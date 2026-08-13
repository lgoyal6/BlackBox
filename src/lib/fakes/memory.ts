import type { DecisionOutcome } from "@/lib/contracts";
import type { MemoryPort } from "@/lib/ports";

const decisions = new Map<string, { incidentId: string; rationale: string; outcome: DecisionOutcome }>();
let seq = 0;

const memory: MemoryPort = {
  async recordDecision(input) {
    if (!input.rationale.trim()) {
      throw new Error("MISSING_RATIONALE: rationale must be a non-empty string");
    }
    const id = `dec-fake-${++seq}`;
    decisions.set(id, {
      incidentId: input.incidentId,
      rationale: input.rationale,
      outcome: input.outcome ?? "pending",
    });
    return id;
  },
  async updateOutcome(decisionId, outcome) {
    const existing = decisions.get(decisionId);
    if (existing) existing.outcome = outcome;
  },
  async generateAndWrite(incidentId) {
    return `pm-fake-${incidentId}`;
  },
  async draftPcr(incidentId) {
    return {
      text: `UNSIGNED DRAFT — not a legal patient care report\n\nIncident ${incidentId}. Narrative withheld pending transfer of care.`,
    };
  },
};

export default memory;
