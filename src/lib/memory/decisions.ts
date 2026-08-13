import { col } from "@/lib/db/client";
import { embeddings, events } from "@/lib/registry";
import { env } from "@/lib/env";
import { DECISIONS, type CallTypeFamily, type DecisionDoc, type DecisionOutcome } from "@/lib/contracts";

export interface RecordDecisionInput {
  incidentId: string;
  displayId: string;
  utterance: string;
  actionChosen: string;
  rationale: string;
  optionsConsidered?: string[];
  outcome?: DecisionOutcome;
  protocolConflict?: boolean;
  callTypeFamily: CallTypeFamily;
}

export class EmptyRationaleError extends Error {
  constructor(message = "rationale must be a non-empty string") {
    super(message);
    this.name = "EmptyRationaleError";
  }
}

/** Throws EmptyRationaleError before any database or embedding call. */
export function assertRationale(rationale: string): string {
  const trimmed = rationale.trim();
  if (trimmed === "") throw new EmptyRationaleError();
  return trimmed;
}

function assertActionChosen(actionChosen: string): string {
  const trimmed = actionChosen.trim();
  if (trimmed === "") throw new Error("actionChosen must be a non-empty string");
  return trimmed;
}

export function embeddedTextFor(
  input: Pick<RecordDecisionInput, "utterance" | "actionChosen" | "rationale">,
): string {
  return [input.utterance, input.actionChosen, input.rationale].join(" | ");
}

export async function recordDecision(
  input: RecordDecisionInput,
): Promise<DecisionDoc & { insertedId: string }> {
  assertRationale(input.rationale);
  assertActionChosen(input.actionChosen);

  const embeddedText = embeddedTextFor(input);
  const embedding = await (await embeddings()).embedOne(embeddedText, "document");
  if (embedding.length !== env.embeddingDim) {
    throw new Error(
      `recordDecision: embedding length ${embedding.length} does not match env.embeddingDim ${env.embeddingDim}`,
    );
  }

  const doc: DecisionDoc = {
    incidentId: input.incidentId,
    displayId: input.displayId,
    utterance: input.utterance,
    actionChosen: input.actionChosen.trim(),
    rationale: input.rationale.trim(),
    optionsConsidered: input.optionsConsidered ?? [],
    outcome: input.outcome ?? "pending",
    protocolConflict: input.protocolConflict ?? false,
    callTypeFamily: input.callTypeFamily,
    embedding,
    embeddedText,
    t: new Date(),
  };

  const result = await col<DecisionDoc>(DECISIONS).insertOne(doc);
  const insertedId = String(result.insertedId);

  await (await events()).emit({
    kind: "decision",
    incidentId: input.incidentId,
    payload: {
      decisionId: insertedId,
      actionChosen: doc.actionChosen,
      rationaleRecorded: true,
      protocolConflict: doc.protocolConflict,
    },
  });

  // write.payload.count is absolute, never a delta — recount rather than guess.
  const count = await col<DecisionDoc>(DECISIONS).countDocuments({});
  await (await events()).emit({
    kind: "write",
    incidentId: input.incidentId,
    payload: { collection: DECISIONS, count },
  });

  return { ...doc, insertedId };
}
