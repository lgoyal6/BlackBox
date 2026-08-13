import { DemoFireReq, DemoFireRes } from "@/lib/contracts";
import { env } from "@/lib/env";

/**
 * Fires either demo call by pattern. A thin client over POST /api/demo/fire.
 *
 * This runs on stage, so success prints three lines and nothing else — a wall of output
 * means the operator is reading instead of talking.
 */

export type DemoPattern = "arrest" | "cardiac";

export interface FireArgs {
  pattern: DemoPattern;
  incidentId?: string;
  baseUrl: string;
  dryRun: boolean;
}

const PATTERNS: readonly DemoPattern[] = ["arrest", "cardiac"];
const FETCH_TIMEOUT_MS = 10_000;

class UsageError extends Error {}

function isPattern(v: string): v is DemoPattern {
  return (PATTERNS as readonly string[]).includes(v);
}

export function parseArgs(argv: string[]): FireArgs {
  let pattern: DemoPattern | null = null;
  let incidentId: string | undefined;
  let baseUrl = env.publicBaseUrl || "http://localhost:3000";
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--pattern=")) {
      const value = arg.slice("--pattern=".length);
      if (!isPattern(value)) throw new UsageError(`unknown pattern ${JSON.stringify(value)}`);
      pattern = value;
    } else if (arg.startsWith("--incident-id=")) {
      incidentId = arg.slice("--incident-id=".length);
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag ${JSON.stringify(arg)}`);
    } else if (pattern === null) {
      if (!isPattern(arg)) throw new UsageError(`unknown pattern ${JSON.stringify(arg)}`);
      pattern = arg;
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  if (pattern === null) throw new UsageError("no pattern given");
  return { pattern, incidentId, baseUrl, dryRun };
}

function requestFor(a: FireArgs): { url: string; headers: Record<string, string>; body: string } {
  // DemoFireReq is the contract; this script does not invent a shape.
  const body = DemoFireReq.parse(
    a.incidentId === undefined
      ? { pattern: a.pattern }
      : { pattern: a.pattern, incidentId: a.incidentId },
  );
  return {
    url: `${a.baseUrl.replace(/\/$/, "")}/api/demo/fire`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function fire(a: FireArgs): Promise<{
  incidentId: string;
  ref: string;
  displayId: string;
}> {
  const req = requestFor(a);
  // A hung request is worse on stage than a fast failure: the operator cannot tell
  // whether to press it again.
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${req.url} -> ${res.status}\n${text}`);
  }
  return DemoFireRes.parse(JSON.parse(text));
}

async function main(): Promise<void> {
  let args: FireArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`valid patterns: ${PATTERNS.join(", ")}`);
    console.error("usage: npx tsx scripts/demo-fire.ts <arrest|cardiac> [--incident-id=] [--base-url=] [--dry-run]");
    process.exit(2);
  }

  const req = requestFor(args);

  if (args.dryRun) {
    console.log(`POST ${req.url}`);
    for (const [k, v] of Object.entries(req.headers)) console.log(`${k}: ${v}`);
    console.log(req.body);
    return;
  }

  const out = await fire(args);
  console.log(out.ref);
  console.log(out.incidentId);
  console.log(`${args.baseUrl.replace(/\/$/, "")}/?incidentId=${encodeURIComponent(out.incidentId)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
