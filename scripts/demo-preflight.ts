import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DECISIONS,
  POSTMORTEMS,
  RUNBOOKS,
  VECTOR_COLLECTIONS,
  WATCH_STATE,
  vectorIndexName,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * The go/no-go, run twenty minutes before the pitch.
 *
 * Automates every mechanical item in docs/preflight.md and explicitly surfaces the two it
 * cannot. Every check has a 5s timeout and the whole run stays under 20s: the operator has
 * a twenty-minute window and one hung DNS lookup should not consume it.
 */

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fixHint: string | null;
  ms: number;
}

export interface PreflightOptions {
  baseUrl: string;
  only: string[] | null;
  json: boolean;
  offline: boolean;
  allowFixture: boolean;
  postmortemFloor: number;
  runbookMin: number;
  runbookMax: number;
}

export type Check = (o: PreflightOptions) => Promise<CheckResult>;

const CHECK_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 4000;
const WATCH_STATE_STALE_MS = 120_000;

/** Matches the fixture postmortem count in contracts §11. */
const DEFAULT_POSTMORTEM_FLOOR = 6;
/** Deliberately wide. PHASE-05 has not run yet, so a precise bound would be invented. */
const DEFAULT_RUNBOOK_MIN = 20;
const DEFAULT_RUNBOOK_MAX = 5000;

const PITCH_FILE = "data/pitch-numbers.json";
const PITCH_PCT = 15.0;
const PITCH_DENOMINATOR = 5_653_498;

function ok(id: string, label: string, detail: string, ms = 0): CheckResult {
  return { id, label, status: "PASS", detail, fixHint: null, ms };
}
function bad(id: string, label: string, detail: string, fixHint: string): CheckResult {
  return { id, label, status: "FAIL", detail, fixHint, ms: 0 };
}
function warn(id: string, label: string, detail: string, fixHint: string): CheckResult {
  return { id, label, status: "WARN", detail, fixHint, ms: 0 };
}
function skip(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: "SKIP", detail, fixHint: null, ms: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function http(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Asserts READY, not merely existence. A PENDING Atlas Search index returns zero results
 * with no error, so the entire memory story returns nothing on stage while every log line
 * looks healthy.
 */
const vectorIndexes: Check = async () => {
  const id = "vector-indexes";
  const label = "Four vector indexes exist and are READY";
  const notReady: string[] = [];

  for (const collection of VECTOR_COLLECTIONS) {
    const wanted = vectorIndexName(collection);
    const indexes = await col(collection).listSearchIndexes().toArray();
    const found = indexes.find((i) => i.name === wanted);
    if (found === undefined) {
      notReady.push(`${wanted} missing`);
      continue;
    }
    const status = "status" in found ? String(found.status) : "unknown";
    if (status.toUpperCase() !== "READY") notReady.push(`${wanted} ${status}`);
  }

  if (notReady.length > 0) {
    return bad(
      id,
      label,
      notReady.join(", "),
      "npm run indexes, then wait for Atlas to finish building. PENDING returns zero hits silently.",
    );
  }
  return ok(id, label, `${VECTOR_COLLECTIONS.length} indexes READY`);
};

const postmortemFloor: Check = async (o) => {
  const id = "postmortem-floor";
  const label = "Seeded postmortems at or above the floor";
  const n = await col(POSTMORTEMS).countDocuments();
  if (n < o.postmortemFloor) {
    return bad(
      id,
      label,
      `${n} postmortems, floor is ${o.postmortemFloor}`,
      "npm run seed. A partial seed leaves retrieval functional but returning nothing relevant.",
    );
  }
  return ok(id, label, `${n} postmortems`);
};

/**
 * A hard FAIL, not a warning. Critical Rule 5 says decisions fills live on stage; a
 * non-zero start means the last rehearsal was not reset, and the write counter starting
 * above zero destroys the "watch it fill live" beat.
 */
const decisionsEmpty: Check = async () => {
  const id = "decisions-empty";
  const label = "decisions is empty";
  const n = await col(DECISIONS).countDocuments();
  if (n !== 0) {
    return bad(
      id,
      label,
      `${n} documents present`,
      "npx tsx scripts/demo-reset.ts --yes",
    );
  }
  return ok(id, label, "0 documents");
};

const runbookChunks: Check = async (o) => {
  const id = "runbook-chunks";
  const label = "Runbook chunk count in range";
  const n = await col(RUNBOOKS).countDocuments();
  if (n < o.runbookMin || n > o.runbookMax) {
    return bad(
      id,
      label,
      `${n} chunks, expected ${o.runbookMin}..${o.runbookMax}`,
      "npm run ingest:runbooks. A truncated PDF parse leaves only a handful of chunks.",
    );
  }
  return ok(id, label, `${n} chunks`);
};

const elevenlabsAgent: Check = async (o) => {
  const id = "elevenlabs-agent";
  const label = "ElevenLabs agent id set and responding";
  const server = env.elevenLabsAgentId;
  const browser = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "";

  if (server === "" || browser === "") {
    return bad(
      id,
      label,
      `ELEVENLABS_AGENT_ID=${server || "(unset)"} NEXT_PUBLIC_ELEVENLABS_AGENT_ID=${browser || "(unset)"}`,
      "npm run agent:setup, then copy the id into both vars in .env.local.",
    );
  }
  if (server !== browser) {
    return bad(id, label, "server and browser agent ids differ", "Make both vars the same id.");
  }

  const res = await http(`${o.baseUrl}/api/voice/signed-url`);
  if (res.status !== 200) {
    return bad(id, label, `GET /api/voice/signed-url -> ${res.status}`, "Is npm run dev up?");
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    return bad(id, label, "signed-url response is not JSON", "Check PHASE-13's route.");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.url !== "string" || b.url === "") {
    return bad(id, label, "signed-url response has no url", "Check PHASE-13's route.");
  }
  if (typeof b.agentId === "string" && b.agentId !== server) {
    return bad(id, label, `signed-url agentId ${b.agentId} != ${server}`, "Ids must match.");
  }
  return ok(id, label, "agent id set, signed-url 200");
};

/**
 * Checks both directions. A 200 with the secret proves the tunnel and route work; a 401
 * without it proves the secret is enforced. Testing only the happy path hides a
 * misconfigured secret until a server tool gets a 401 mid-call, which is unrecoverable
 * inside a three-minute pitch.
 */
const tunnel: Check = async () => {
  const id = "tunnel";
  const label = "Tunnel reachable and shared secret enforced";
  const base = env.publicBaseUrl;

  if (base === "") {
    return bad(id, label, "PUBLIC_BASE_URL is unset", "Start the tunnel and set PUBLIC_BASE_URL.");
  }
  if (!base.startsWith("https://")) {
    return bad(id, label, `PUBLIC_BASE_URL is not https: ${base}`, "ElevenLabs server tools require https.");
  }

  // log_timeline is the cheapest tool and its only side effect is appending a timeline
  // entry, so probe with incidentId "preflight" and leave the demo incidents untouched.
  const url = `${base.replace(/\/$/, "")}/api/tools/log_timeline`;
  const body = JSON.stringify({ incidentId: "preflight", text: "preflight probe", source: "system" });

  const withSecret = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-BlackBox-Secret": env.toolSharedSecret },
    body,
  });
  if (withSecret.status !== 200) {
    return bad(id, label, `with secret -> ${withSecret.status}`, "Check TOOL_SHARED_SECRET and the tunnel URL.");
  }

  const withoutSecret = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (withoutSecret.status !== 401) {
    return bad(
      id,
      label,
      `without secret -> ${withoutSecret.status}, expected 401`,
      "The route is not enforcing X-BlackBox-Secret. Anyone can write to Atlas.",
    );
  }
  return ok(id, label, "200 with secret, 401 without");
};

/**
 * Reads a file, never the network. Conference wifi is the most reliable way to lose a
 * pitch and this number is the first sentence out of the presenter's mouth.
 * PHASE-04 owns the file's shape, so this adapts rather than asserting one.
 */
const pitchNumber: Check = async () => {
  const id = "pitch-number";
  const label = "Cached pitch number present";
  const path = resolve(process.cwd(), PITCH_FILE);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return bad(id, label, `${PITCH_FILE} not found`, "npm run pitch (data/ is gitignored, so it must be regenerated on the demo machine).");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad(id, label, `${PITCH_FILE} does not parse`, "npm run pitch");
  }

  const blob = JSON.stringify(parsed);
  if (blob === "{}" || blob === "[]") {
    return bad(id, label, `${PITCH_FILE} is empty`, "npm run pitch");
  }

  const numbers = [...blob.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const hasPct = numbers.some((n) => Math.abs(n - PITCH_PCT) < 0.5);
  const hasDenominator = numbers.some(
    (n) => Math.abs(n - PITCH_DENOMINATOR) / PITCH_DENOMINATOR < 0.02,
  );

  if (!hasPct || !hasDenominator) {
    return bad(
      id,
      label,
      `missing ${hasPct ? "" : "~15.0 "}${hasDenominator ? "" : "~5,653,498"}`.trim(),
      "npm run pitch to recompute from the Socrata COUNT aggregates.",
    );
  }
  return ok(id, label, "15.0% and the 5,653,498 denominator present");
};

/**
 * WARN, not FAIL: contracts §2 gives the worker a place to persist a resume token but
 * specifies no update cadence, so a script cannot honestly assert the worker is alive.
 * The reliable version is the manual item in docs/preflight.md.
 */
const workerMode: Check = async () => {
  const id = "worker-mode";
  const label = "Worker trigger mode and watch state";
  const mode = env.triggerMode;

  if (mode !== "changestream" && mode !== "poll") {
    return warn(id, label, `TRIGGER_MODE=${mode}`, "Set TRIGGER_MODE to changestream or poll.");
  }

  const doc = await col<Record<string, unknown>>(WATCH_STATE).findOne({});
  if (doc === null) {
    return warn(id, label, `${mode}, ${WATCH_STATE} is empty`, "Start npm run worker and confirm it printed its trigger mode.");
  }

  const stamps = Object.values(doc)
    .filter((v): v is Date => v instanceof Date)
    .map((d) => d.getTime());
  if (stamps.length === 0) {
    return ok(id, label, `${mode}, ${WATCH_STATE} present (no timestamp field)`);
  }

  const ageMs = Date.now() - Math.max(...stamps);
  if (ageMs > WATCH_STATE_STALE_MS) {
    return warn(
      id,
      label,
      `${mode}, watch state ${Math.round(ageMs / 1000)}s old`,
      "Look at the worker terminal — it may have died.",
    );
  }
  return ok(id, label, `${mode}, watch state ${Math.round(ageMs / 1000)}s old`);
};

/**
 * Two independent detectors, because these are different failure modes: somebody
 * deliberately setting `fake` and forgetting, versus the registry silently falling back
 * because a real module is missing. At hour seven one of these is what stops a demo that
 * would otherwise have run on fakes.
 */
const fakePorts: Check = async (o) => {
  const id = "fake-ports";
  const label = "No port resolving to a fake";
  const problems: string[] = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.endsWith("_MODE")) continue;
    if (key === "NEXT_PUBLIC_EVENTS_MODE") continue;
    if ((value ?? "").toLowerCase() === "fake") problems.push(`${key}=fake`);
  }

  const eventsMode = (process.env.NEXT_PUBLIC_EVENTS_MODE ?? "").toLowerCase();
  const fixtureDashboard = eventsMode === "fixture";

  // Enumerate resolvers from the registry's exports rather than hard-coding: contracts §9
  // has already grown once, from six ports to seven, and a hard-coded list silently stops
  // covering the newest port.
  const registry: Record<string, unknown> = await import("@/lib/registry");
  const captured: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a: unknown[]) => captured.push(a.join(" "));
  console.error = (...a: unknown[]) => captured.push(a.join(" "));
  try {
    for (const [name, value] of Object.entries(registry)) {
      if (typeof value !== "function") continue;
      try {
        await (value as () => Promise<unknown>)();
      } catch (error) {
        captured.push(`${name} threw: ${message(error)}`);
      }
    }
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }

  for (const line of captured) {
    if (line.includes("FAKE PORT")) problems.push(line.trim());
  }

  if (problems.length > 0) {
    return bad(id, label, problems.join(" | "), "Unset the *_MODE vars and land the missing real modules before going on stage.");
  }
  if (fixtureDashboard) {
    // A dashboard replaying a fixture is the same failure as a fake port.
    return o.allowFixture
      ? warn(id, label, "NEXT_PUBLIC_EVENTS_MODE=fixture (allowed)", "Deliberate fixture dress rehearsal.")
      : bad(id, label, "NEXT_PUBLIC_EVENTS_MODE=fixture", "Clear it, or pass --allowFixture for a deliberate fixture rehearsal.");
  }
  return ok(id, label, "all ports real");
};

// Manual items appear in CHECKS as SKIP rather than being omitted, so the item count here
// and in docs/preflight.md match and nothing falls between the two.
const audioLevels: Check = async () =>
  skip("audio-levels", "Audio levels (manual)", "Run a ten-second two-way test with the real first medic line.");

const windowLayout: Check = async () =>
  skip("window-layout", "Window layout (manual)", "Two browser windows side by side; never alt-tab on stage.");

const MANUAL = new Set(["audio-levels", "window-layout"]);

export const CHECKS: readonly { id: string; label: string; run: Check }[] = [
  { id: "vector-indexes", label: "Four vector indexes exist and are READY", run: vectorIndexes },
  { id: "postmortem-floor", label: "Seeded postmortems at or above the floor", run: postmortemFloor },
  { id: "decisions-empty", label: "decisions is empty", run: decisionsEmpty },
  { id: "runbook-chunks", label: "Runbook chunk count in range", run: runbookChunks },
  { id: "elevenlabs-agent", label: "ElevenLabs agent id set and responding", run: elevenlabsAgent },
  { id: "tunnel", label: "Tunnel reachable and shared secret enforced", run: tunnel },
  { id: "pitch-number", label: "Cached pitch number present", run: pitchNumber },
  { id: "worker-mode", label: "Worker trigger mode and watch state", run: workerMode },
  { id: "fake-ports", label: "No port resolving to a fake", run: fakePorts },
  { id: "audio-levels", label: "Audio levels (manual)", run: audioLevels },
  { id: "window-layout", label: "Window layout (manual)", run: windowLayout },
];

async function withTimeout(id: string, label: string, run: Check, o: PreflightOptions): Promise<CheckResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
    });
    const result = await Promise.race([run(o), timeout]);
    return { ...result, ms: Date.now() - started };
  } catch (error) {
    return {
      id,
      label,
      status: "FAIL",
      detail: message(error),
      fixHint: "Is Atlas reachable and npm run dev up?",
      ms: Date.now() - started,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runPreflight(
  o: PreflightOptions,
): Promise<{ results: CheckResult[]; ok: boolean }> {
  const selected = o.only === null ? CHECKS : CHECKS.filter((c) => o.only!.includes(c.id));
  const results: CheckResult[] = [];

  for (const check of selected) {
    if (MANUAL.has(check.id)) {
      results.push({ ...(await check.run(o)), ms: 0 });
      continue;
    }
    if (o.offline) {
      results.push(skip(check.id, check.label, "skipped (--offline)"));
      continue;
    }
    results.push(await withTimeout(check.id, check.label, check.run, o));
  }

  return { results, ok: results.every((r) => r.status !== "FAIL") };
}

function parseOptions(argv: string[]): PreflightOptions {
  const o: PreflightOptions = {
    baseUrl: (env.publicBaseUrl || "http://localhost:3000").replace(/\/$/, ""),
    only: null,
    json: false,
    offline: false,
    allowFixture: false,
    postmortemFloor: DEFAULT_POSTMORTEM_FLOOR,
    runbookMin: DEFAULT_RUNBOOK_MIN,
    runbookMax: DEFAULT_RUNBOOK_MAX,
  };

  for (const arg of argv) {
    if (arg === "--json") o.json = true;
    else if (arg === "--offline") o.offline = true;
    else if (arg === "--allowFixture" || arg === "--allow-fixture") o.allowFixture = true;
    else if (arg.startsWith("--only=")) o.only = arg.slice("--only=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--base-url=")) o.baseUrl = arg.slice("--base-url=".length).replace(/\/$/, "");
    else if (arg.startsWith("--postmortem-floor=")) o.postmortemFloor = Number(arg.split("=")[1]);
    else if (arg.startsWith("--runbook-min=")) o.runbookMin = Number(arg.split("=")[1]);
    else if (arg.startsWith("--runbook-max=")) o.runbookMax = Number(arg.split("=")[1]);
  }
  return o;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function render(results: CheckResult[]): void {
  const idWidth = Math.max(...results.map((r) => r.id.length), 2);
  for (const r of results) {
    console.log(`${pad(r.id, idWidth)}  ${pad(r.status, 4)}  ${pad(`${r.ms}ms`, 7)}  ${r.detail}`);
    if (r.status !== "PASS" && r.fixHint !== null) {
      console.log(`${" ".repeat(idWidth)}  fix:  ${r.fixHint}`);
    }
  }
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const { results, ok: passed } = await runPreflight(o);

  if (o.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    render(results);
    const failed = results.filter((r) => r.status === "FAIL").length;
    console.log(passed ? "GO" : `NO-GO: ${failed} check(s) failed`);
  }

  process.exit(passed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
