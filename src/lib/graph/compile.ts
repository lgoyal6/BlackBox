import { END, START, StateGraph } from "@langchain/langgraph";
import { getClient } from "@/lib/db/client";
import { ensureCheckpointer } from "./checkpointer";
import { IncidentAnnotation } from "./state";
import { wrapNode } from "./wrap";
import * as nodes from "./nodes";

/**
 * LangGraph 1.4.9 refuses a node name that collides with a state-channel name
 * ("X is already being used as a state attribute... cannot also be used as a node name").
 * `IncidentState` has both a `brief` and a `plan` field, which are also GraphNode names —
 * a real collision baked into the locked contract, only surfaced by a live `.compile()`.
 * These two nodes register under distinct internal keys; the GraphNode string passed to
 * `wrapNode` (and therefore `nodeTrail`/emitted `node` events) is unaffected and still
 * exactly matches `GRAPH_NODE_ORDER`.
 */
const BRIEF_NODE = "brief_step";
const PLAN_NODE = "plan_step";

async function buildGraph() {
  const client = getClient();
  const checkpointer = await ensureCheckpointer(client);

  return new StateGraph(IncidentAnnotation)
    .addNode("triage", wrapNode("triage", nodes.triage))
    .addNode("signature_match", wrapNode("signature_match", nodes.signatureMatchNode))
    .addNode(BRIEF_NODE, wrapNode("brief", nodes.brief))
    .addNode(PLAN_NODE, wrapNode("plan", nodes.plan))
    .addNode("readback_gate", nodes.readbackGate)
    .addNode("execute_record", wrapNode("execute_record", nodes.executeRecord))
    .addNode("verify", wrapNode("verify", nodes.verify))
    .addNode("record_decision", wrapNode("record_decision", nodes.recordDecisionNode))
    .addNode("await_input", nodes.awaitInput)
    .addNode("postmortem", wrapNode("postmortem", nodes.postmortemNode))
    .addEdge(START, "triage")
    .addEdge("triage", "signature_match")
    .addEdge("signature_match", BRIEF_NODE)
    .addEdge(BRIEF_NODE, PLAN_NODE)
    .addEdge(PLAN_NODE, "readback_gate")
    .addEdge("readback_gate", "execute_record")
    .addEdge("execute_record", "verify")
    .addEdge("verify", "record_decision")
    .addConditionalEdges("record_decision", (state) => (state.closeRequested ? "postmortem" : "await_input"))
    .addConditionalEdges("await_input", (state) => (state.closeRequested ? "postmortem" : PLAN_NODE))
    .addEdge("postmortem", END)
    .compile({ checkpointer });
}

let cached: ReturnType<typeof buildGraph> | null = null;

export async function getCompiledGraph(): ReturnType<typeof buildGraph> {
  if (!cached) cached = buildGraph();
  return cached;
}
