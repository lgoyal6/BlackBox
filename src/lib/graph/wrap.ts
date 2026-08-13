import { INTERRUPT, isInterrupted } from "@langchain/langgraph";
import type { GraphNode, IncidentState, InterruptPayload } from "@/lib/contracts";
import { events } from "@/lib/registry";

export function threadConfig(incidentId: string): { configurable: { thread_id: string } } {
  return { configurable: { thread_id: incidentId } };
}

/**
 * Both emits fire only after `fn()` resolves — never before. On resume the interrupted node
 * re-executes from the top, so an "enter" emitted before `fn()` would duplicate on every resume.
 */
export function wrapNode(
  name: GraphNode,
  fn: (state: IncidentState) => Promise<Partial<IncidentState>>,
): (state: IncidentState) => Promise<Partial<IncidentState>> {
  return async (state: IncidentState) => {
    const result = await fn(state);
    await (await events()).emit({
      kind: "node",
      incidentId: state.incidentId,
      payload: { node: name, phase: "enter" },
    });
    await (await events()).emit({
      kind: "node",
      incidentId: state.incidentId,
      payload: { node: name, phase: "exit" },
    });
    return result;
  };
}

export function interruptPayloadFromInvokeResult(result: unknown): InterruptPayload | null {
  if (!isInterrupted(result)) return null;
  const interrupts = (result as Record<typeof INTERRUPT, { value?: unknown }[]>)[INTERRUPT];
  if (!Array.isArray(interrupts) || interrupts.length === 0) return null;
  return (interrupts[0]?.value ?? null) as InterruptPayload | null;
}
