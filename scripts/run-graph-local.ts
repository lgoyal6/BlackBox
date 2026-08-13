import { readFileSync } from "node:fs";
import { join } from "node:path";
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

async function main(): Promise<void> {
  const incidentId = flag("incident-id") ?? defaultIncidentId();
  const autoConfirm = flag("auto-confirm") !== undefined;
  const printState = flag("print-state") !== undefined;

  const port = await graph();
  let result = await port.start(incidentId);
  console.log("start() interrupt:", JSON.stringify(result.interrupt));

  while (result.interrupt && autoConfirm) {
    const resumeValue =
      result.interrupt.type === "readback" ? { confirmed: true, verbatimOk: true } : { closeRequested: true };
    result = await port.resume(incidentId, resumeValue);
    console.log("resume() interrupt:", JSON.stringify(result.interrupt));
  }

  const snapshot = await port.state(incidentId);

  if (printState) {
    console.log("nodeTrail:", snapshot.values.nodeTrail);
    console.log("brief:", snapshot.values.brief);
    console.log("plan:", JSON.stringify(snapshot.values.plan, null, 2));
    console.log("next:", snapshot.next);
    console.log("checkpointCount:", snapshot.checkpointCount);
  }

  if (autoConfirm) {
    const trail = snapshot.values.nodeTrail ?? [];
    if (!trail.includes("postmortem")) {
      console.error("FAIL: --auto-confirm finished without 'postmortem' in nodeTrail");
      process.exit(1);
    }
    if (/\b(UNC|EDP|SICK|ARREST|CARD)\b/.test(snapshot.values.brief ?? "")) {
      console.error("FAIL: brief contains a raw dispatch code");
      process.exit(1);
    }
    console.log("PASS");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
