import { col } from "@/lib/db/client";
import { embeddings, events, llm } from "@/lib/registry";
import { env } from "@/lib/env";
import { POSTMORTEMS, labelFor, type DecisionDoc, type IncidentDoc, type PostmortemDoc } from "@/lib/contracts";

const DOSE = /\d+\s*(mg|mcg|mL|g)\b/i;
const MIN_WORDS = 40;
const MAX_WORDS = 200;
const TARGET_MIN = 60;
const TARGET_MAX = 110;
const PREVIEW_WORDS = 40;
const MAX_LESSONS = 3;

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function truncateToSentence(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (/[.!?]$/.test(words[i])) return words.slice(0, i + 1).join(" ");
  }
  return `${words.join(" ")}.`;
}

/** Observed transition from the live record only. */
export function whatChangedFrom(incident: IncidentDoc, decisions: DecisionDoc[]): string {
  const from = labelFor(incident.cad.initialCallType);
  const actionTexts = decisions.map((d) => d.actionChosen).join(" ");
  const timelineTexts = incident.timeline.map((e) => e.text).join(" ");
  const combined = `${actionTexts} ${timelineTexts}`.toLowerCase();

  if (/arrest|pulseless|asystole|compressions/.test(combined)) {
    return `${from} → cardiac arrest`;
  }
  if (/cardiac|chest pain|mi\b/.test(combined)) {
    return `${from} → cardiac condition`;
  }
  return `${from} → transfer of care`;
}

function templateNarrative(incident: IncidentDoc, decisions: DecisionDoc[]): string {
  const label = labelFor(incident.cad.initialCallType);
  const firstRationale = decisions[0]?.rationale;
  const rationaleClause = firstRationale
    ? ` We recorded the reasoning behind our actions, including that ${firstRationale}.`
    : " We recorded our actions as we went.";
  return (
    `We responded to a call dispatched as ${label} in ${incident.cad.borough}, dispatch area ` +
    `${incident.cad.dispatchArea}.${rationaleClause} We continued documentation through transfer ` +
    `of care and closed the call once the patient was handed off.`
  );
}

function buildLessons(decisions: DecisionDoc[]): string[] {
  if (decisions.length === 0) return ["record the rationale before closing the call"];
  return decisions.slice(0, MAX_LESSONS).map((d) => d.rationale);
}

export async function generateAndWrite(
  incident: IncidentDoc,
  decisions: DecisionDoc[],
): Promise<PostmortemDoc & { insertedId: string }> {
  const decisionLines = decisions.map((d) => `Action: ${d.actionChosen}. Rationale: ${d.rationale}.`).join("\n");
  const timelineLines = incident.timeline.map((e) => `[${e.source}] ${e.text}`).join("\n");
  const prompt =
    `postmortem: write a first-person-plural, past-tense narrative (60-110 words) for this EMS call. ` +
    `Dispatched as ${labelFor(incident.cad.initialCallType)}. Never invent vitals, drug doses, or patient ` +
    `identifiers. Use only what the crew recorded below.\n\nTimeline:\n${timelineLines}\n\nDecisions:\n${decisionLines}`;

  let narrative = await (await llm()).text(prompt, { maxWords: TARGET_MAX });
  if (DOSE.test(narrative)) {
    narrative = templateNarrative(incident, decisions);
  }

  const count = wordCount(narrative);
  if (count < MIN_WORDS) {
    narrative = `${narrative} We documented the rationale for each decision as part of transfer of care.`;
  } else if (count > MAX_WORDS) {
    narrative = truncateToSentence(narrative, MAX_WORDS);
  }

  const whatChanged = whatChangedFrom(incident, decisions);
  const lessons = buildLessons(decisions);
  const embeddedText = [narrative, whatChanged, ...lessons].join(" | ");
  const embedding = await (await embeddings()).embedOne(embeddedText, "document");
  if (embedding.length !== env.embeddingDim) {
    throw new Error(
      `generateAndWrite: embedding length ${embedding.length} does not match env.embeddingDim ${env.embeddingDim}`,
    );
  }

  const doc: PostmortemDoc = {
    incidentId: incident.incidentId,
    displayId: incident.displayId,
    narrative,
    whatChanged,
    severityDelta: 0,
    lessons,
    origin: "live",
    callTypeFamily: incident.callTypeFamily,
    embedding,
    embeddedText,
    t: new Date(),
  };

  await col<PostmortemDoc>(POSTMORTEMS).deleteMany({ incidentId: incident.incidentId, origin: "live" });
  const result = await col<PostmortemDoc>(POSTMORTEMS).insertOne(doc);
  const insertedId = String(result.insertedId);

  const preview = narrative.split(/\s+/).slice(0, PREVIEW_WORDS).join(" ");
  await (await events()).emit({
    kind: "pcr",
    incidentId: incident.incidentId,
    payload: { postmortemId: insertedId, preview },
  });

  const writeCount = await col<PostmortemDoc>(POSTMORTEMS).countDocuments({});
  await (await events()).emit({
    kind: "write",
    incidentId: incident.incidentId,
    payload: { collection: POSTMORTEMS, count: writeCount },
  });

  return { ...doc, insertedId };
}
