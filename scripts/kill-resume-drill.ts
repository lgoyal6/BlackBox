import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { col } from "@/lib/db/client";
import { DECISIONS, REMEDIATIONS, type SignatureMatch } from "@/lib/contracts";
import { graph } from "@/lib/registry";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf("=");
  return eq === -1 ? "true" : match.slice(eq + 1);
}

function defaultIncidentId(): string {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "incidents.json"), "utf8")) as {
    incidentId: string;
    cad: { initialCallType: string };
  }[];
  const unc = raw.find((i) => i.cad.initialCallType === "UNC");
  return (unc ?? raw[0]).incidentId;
}

interface Snapshot {
  timelineLength: number;
  signature: SignatureMatch | null;
  decisions: number;
  remediations: number;
}

async function snapshotCounts(incidentId: string): Promise<Snapshot> {
  const port = await graph();
  const s = await port.state(incidentId);
  const [decisions, remediations] = await Promise.all([
    col(DECISIONS).countDocuments({}),
    col(REMEDIATIONS).countDocuments({}),
  ]);
  return {
    timelineLength: s.values.timeline?.length ?? 0,
    signature: s.values.signature ?? null,
    decisions,
    remediations,
  };
}

async function runResumeOnly(incidentId: string): Promise<void> {
  const port = await graph();
  const result = await port.resume(incidentId, { confirmed: true, verbatimOk: true });
  console.log("RESUME_RESULT:", JSON.stringify(result));
}

async function main(): Promise<void> {
  const incidentId = flag("incident-id") ?? defaultIncidentId();

  if (flag("resume-only") !== undefined) {
    await runResumeOnly(incidentId);
    return;
  }

  const port = await graph();
  let result = await port.start(incidentId);
  let guard = 0;
  while (result.interrupt && result.interrupt.type !== "readback" && guard < 10) {
    result = await port.resume(incidentId, { closeRequested: false });
    guard += 1;
  }
  if (!result.interrupt || result.interrupt.type !== "readback") {
    console.error("FAIL: did not reach a readback interrupt");
    process.exit(1);
    return;
  }

  const before = await snapshotCounts(incidentId);
  console.log("Parked at readback interrupt. Snapshot:", JSON.stringify(before));

  if (flag("stop-before-resume") !== undefined) {
    console.log("--stop-before-resume: leaving the incident parked at the gate.");
    return;
  }

  const child = spawn(
    "npx",
    ["tsx", __filename, "--resume-only", `--incident-id=${incidentId}`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  if (exitCode !== 0) {
    console.error("FAIL: resume-only child process exited non-zero");
    process.exit(1);
    return;
  }

  const after = await snapshotCounts(incidentId);
  console.log("After resume in a fresh process. Snapshot:", JSON.stringify(after));

  const timelineOk = after.timelineLength >= before.timelineLength;
  const signatureOk = JSON.stringify(after.signature) === JSON.stringify(before.signature);
  const decisionsOk = after.decisions === before.decisions;
  const remediationsOk = after.remediations === before.remediations;

  if (timelineOk && signatureOk && decisionsOk && remediationsOk) {
    console.log("PASS");
    process.exit(0);
  } else {
    console.error("FAIL", JSON.stringify({ timelineOk, signatureOk, decisionsOk, remediationsOk, before, after }));
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
