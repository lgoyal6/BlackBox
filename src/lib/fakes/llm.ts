import type { LlmPort } from "@/lib/ports";

const TEMPLATES: Array<{ prefix: string; text: string }> = [
  { prefix: "postmortem", text: "We arrived to an unresponsive patient and recorded the decisions we made, including why we deferred the airway." },
  { prefix: "pcr", text: "UNSIGNED DRAFT — crew documented compressions, deferred airway for recent neck surgery, and requested confirmation of epinephrine." },
  { prefix: "brief", text: "Dispatched as sick. This call type in B3 reclassifies to cardiac overnight more often than chance." },
  { prefix: "extract", text: "deferred supraglottic airway" },
];

function templateFor(prompt: string): string {
  const lower = prompt.toLowerCase();
  const hit = TEMPLATES.find((row) => lower.includes(row.prefix));
  return hit?.text ?? "Recorded without adding clinical advice.";
}

async function json<T>(prompt: string, schema: unknown): Promise<T> {
  if (schema && typeof schema === "object" && "example" in schema) {
    return (schema as { example: T }).example;
  }
  const lower = prompt.toLowerCase();
  if (lower.includes("rationale") || lower.includes("extract")) {
    const invented = /family|because|says|reports/.test(lower);
    return {
      actionChosen: "deferred supraglottic airway",
      rationale: invented ? "family reports recent neck surgery" : null,
    } as T;
  }
  if (lower.includes("postmortem")) {
    return {
      narrative: templateFor("postmortem"),
      whatChanged: "unconscious or unresponsive → cardiac arrest",
      lessons: ["Record the rationale before closing the call."],
    } as T;
  }
  return { text: templateFor(prompt) } as T;
}

async function text(prompt: string, opts?: { maxWords?: number }): Promise<string> {
  const body = templateFor(prompt);
  if (!opts?.maxWords) return body;
  const words = body.split(/\s+/);
  return words.slice(0, opts.maxWords).join(" ");
}

const llm: LlmPort = { json, text };
export default llm;
