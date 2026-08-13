import { END, START, StateGraph } from "@langchain/langgraph";
import { getClient } from "@/lib/db/client";
import { ensureCheckpointer } from "./checkpointer";
import { IncidentAnnotation } from "./state";
import { wrapNode } from "./wrap";
import * as nodes from "./nodes";

async function buildGraph() {
  const client = getClient();
  const checkpointer = await ensureCheckpointer(client);

  return new StateGraph(IncidentAnnotation)
    .addNode("triage", wrapNode("triage", nodes.triage))
    .addNode("signature_match", wrapNode("signature_match", nodes.signatureMatchNode))
    .addNode("brief", wrapNode("brief", nodes.brief))
    .addNode("plan", wrapNode("plan", nodes.plan))
    .addNode("readback_gate", nodes.readbackGate)
    .addNode("execute_record", wrapNode("execute_record", nodes.executeRecord))
    .addNode("verify", wrapNode("verify", nodes.verify))
    .addNode("record_decision", wrapNode("record_decision", nodes.recordDecisionNode))
    .addNode("await_input", nodes.awaitInput)
    .addNode("postmortem", wrapNode("postmortem", nodes.postmortemNode))
    .addEdge(START, "triage")
    .addEdge("triage", "signature_match")
    .addEdge("signature_match", "brief")
    .addEdge("brief", "plan")
    .addEdge("plan", "readback_gate")
    .addEdge("readback_gate", "execute_record")
    .addEdge("execute_record", "verify")
    .addEdge("verify", "record_decision")
    .addConditionalEdges("record_decision", (state) => (state.closeRequested ? "postmortem" : "await_input"))
    .addConditionalEdges("await_input", (state) => (state.closeRequested ? "postmortem" : "plan"))
    .addEdge("postmortem", END)
    .compile({ checkpointer });
}

let cached: ReturnType<typeof buildGraph> | null = null;

export async function getCompiledGraph(): ReturnType<typeof buildGraph> {
  if (!cached) cached = buildGraph();
  return cached;
}
