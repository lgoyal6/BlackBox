import type { Filter, Document } from "mongodb";
import {
  CHECKPOINTS,
  CHECKPOINT_WRITES,
  DECISIONS,
  DemoResetRes,
  EVENTS,
  INCIDENTS,
  POSTMORTEMS,
  REMEDIATIONS,
  RUNBOOKS,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Clean slate between rehearsals.
 *
 * By default this calls POST /api/demo/reset, because PHASE-11 owns the deletion rules and
 * a second implementation of those rules is a second place for them to drift. --direct
 * implements the identical allowlist for when the Next app is not running.
 */

export interface ResetOptions {
  baseUrl: string;
  direct: boolean;
  dryRun: boolean;
  yes: boolean;
}

export interface ResetReport {
  deleted: Record<string, number>;
  protectedBefore: Record<string, number>;
  protectedAfter: Record<string, number>;
}

/** The allowlist from contracts §10. Nothing outside this list is ever deleted. */
const PLAN: readonly { collection: string; filter: Filter<Document> }[] = [
  { collection: DECISIONS, filter: {} },
  { collection: POSTMORTEMS, filter: { origin: "live" } },
  { collection: REMEDIATIONS, filter: { origin: "live" } },
  { collection: EVENTS, filter: {} },
  { collection: CHECKPOINTS, filter: {} },
  { collection: CHECKPOINT_WRITES, filter: {} },
  { collection: INCIDENTS, filter: { isLive: true } },
];

/**
 * Counted before and after on every run. Re-embedding the seed corpus twenty minutes
 * before the pitch costs both API spend and the one window in which nothing else can be
 * fixed, so "reset is probably safe" is not good enough — it gets verified each time.
 */
const PROTECTED: readonly { label: string; collection: string; filter: Filter<Document> }[] = [
  { label: RUNBOOKS, collection: RUNBOOKS, filter: {} },
  { label: `${POSTMORTEMS} (seeded)`, collection: POSTMORTEMS, filter: { origin: { $ne: "live" } } },
  { label: `${REMEDIATIONS} (seeded)`, collection: REMEDIATIONS, filter: { origin: { $ne: "live" } } },
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function countProtected(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const p of PROTECTED) {
    out[p.label] = await col(p.collection).countDocuments(p.filter);
  }
  return out;
}

export async function reset(o: ResetOptions): Promise<ResetReport> {
  if (!o.direct) {
    const url = `${o.baseUrl.replace(/\/$/, "")}/api/demo/reset`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${url} -> ${res.status}\n${text}`);
    const body = DemoResetRes.parse(JSON.parse(text));

    let protectedAfter: Record<string, number> = {};
    try {
      protectedAfter = await countProtected();
    } catch {
      // The route already reported what it deleted; a missing direct connection here is
      // not a reason to fail the reset.
    }
    return { deleted: body.deleted, protectedBefore: {}, protectedAfter };
  }

  const protectedBefore = await countProtected();
  const deleted: Record<string, number> = {};
  for (const step of PLAN) {
    const result = await col(step.collection).deleteMany(step.filter);
    deleted[step.collection] = (deleted[step.collection] ?? 0) + result.deletedCount;
  }
  const protectedAfter = await countProtected();
  return { deleted, protectedBefore, protectedAfter };
}

function parseOptions(argv: string[]): ResetOptions {
  const o: ResetOptions = {
    baseUrl: env.publicBaseUrl || "http://localhost:3000",
    direct: false,
    dryRun: false,
    yes: false,
  };
  for (const arg of argv) {
    if (arg === "--yes") o.yes = true;
    else if (arg === "--dry-run") o.dryRun = true;
    else if (arg === "--direct") o.direct = true;
    else if (arg.startsWith("--base-url=")) o.baseUrl = arg.slice("--base-url=".length);
  }
  return o;
}

async function printPlan(): Promise<void> {
  console.log("deletion plan:");
  for (const step of PLAN) {
    let count = "";
    try {
      count = ` -> ${await col(step.collection).countDocuments(step.filter)} match(es)`;
    } catch (error) {
      count = ` -> count unavailable (${message(error)})`;
    }
    console.log(`  ${step.collection}  ${JSON.stringify(step.filter)}${count}`);
  }

  console.log("protected, never deleted:");
  for (const p of PROTECTED) {
    let count = "";
    try {
      count = ` -> ${await col(p.collection).countDocuments(p.filter)} document(s)`;
    } catch (error) {
      count = ` -> count unavailable (${message(error)})`;
    }
    console.log(`  ${p.label}  ${JSON.stringify(p.filter)}${count}`);
  }
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));

  // Required unconditionally. Between rehearsals somebody will paste a command into the
  // wrong terminal, and a destructive script that runs on a bare invocation is a matter
  // of when, not if.
  if (!o.yes) {
    console.error("refusing to run without --yes (this deletes live demo data)");
    console.error("usage: npx tsx scripts/demo-reset.ts --yes [--direct] [--dry-run]");
    process.exit(2);
  }

  if (o.dryRun) {
    await printPlan();
    console.log("dry run: nothing deleted");
    return;
  }

  const report = await reset(o);

  for (const [collection, n] of Object.entries(report.deleted)) {
    console.log(`deleted  ${collection}  ${n}`);
  }
  for (const [label, n] of Object.entries(report.protectedBefore)) {
    console.log(`protected before  ${label}  ${n}`);
  }
  for (const [label, n] of Object.entries(report.protectedAfter)) {
    console.log(`protected after   ${label}  ${n}`);
  }

  const drifted = Object.keys(report.protectedBefore).filter(
    (k) => report.protectedBefore[k] !== report.protectedAfter[k],
  );
  if (drifted.length > 0) {
    console.error(`PROTECTED COLLECTION CHANGED: ${drifted.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
