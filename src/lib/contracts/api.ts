import { z } from "zod";

export const RecallMemoryReq = z.object({
  incidentId: z.string().min(1),
  query: z.string().min(1),
});
export type RecallMemoryReq = z.output<typeof RecallMemoryReq>;
export const RecallMemoryRes = z.object({
  summary: z.string(),
  spoken: z.string(),
  hits: z.array(z.unknown()),
});
export type RecallMemoryRes = z.output<typeof RecallMemoryRes>;

export const GetProtocolReq = z.object({
  incidentId: z.string().min(1),
  topic: z.string().min(1),
});
export type GetProtocolReq = z.output<typeof GetProtocolReq>;
export const GetProtocolRes = z.object({
  spoken: z.string(),
  text: z.string(),
  sectionTitle: z.string(),
  pageStart: z.number(),
});
export type GetProtocolRes = z.output<typeof GetProtocolRes>;

export const LogTimelineReq = z.object({
  incidentId: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(["medic", "agent", "system"]),
});
export type LogTimelineReq = z.output<typeof LogTimelineReq>;
export const LogTimelineRes = z.object({ ok: z.literal(true) });
export type LogTimelineRes = z.output<typeof LogTimelineRes>;

export const ProposeReadbackReq = z.object({
  incidentId: z.string().min(1),
  utterance: z.string().min(1),
  drug: z.string().min(1).optional(),
  dose: z.string().min(1).optional(),
  route: z.string().min(1).optional(),
});
export type ProposeReadbackReq = z.output<typeof ProposeReadbackReq>;
export const ProposeReadbackRes = z.object({ readbackText: z.string() });
export type ProposeReadbackRes = z.output<typeof ProposeReadbackRes>;

export const ConfirmReadbackReq = z.object({
  incidentId: z.string().min(1),
  confirmed: z.boolean(),
  verbatimOk: z.boolean(),
});
export type ConfirmReadbackReq = z.output<typeof ConfirmReadbackReq>;
export const ConfirmReadbackRes = z.object({
  ok: z.boolean(),
  resumedAt: z.enum([
    "triage", "signature_match", "brief", "plan", "readback_gate",
    "execute_record", "verify", "record_decision", "await_input", "postmortem",
  ]).nullable(),
});
export type ConfirmReadbackRes = z.output<typeof ConfirmReadbackRes>;

export const RecordDecisionReq = z.object({
  incidentId: z.string().min(1),
  utterance: z.string().min(1),
});
export type RecordDecisionReq = z.output<typeof RecordDecisionReq>;
export const RecordDecisionRes = z.object({
  ok: z.literal(true),
  ack: z.string(),
});
export type RecordDecisionRes = z.output<typeof RecordDecisionRes>;

export const CloseCallReq = z.object({
  incidentId: z.string().min(1),
});
export type CloseCallReq = z.output<typeof CloseCallReq>;
export const CloseCallRes = z.object({
  postmortemId: z.string(),
  pcrPreview: z.string(),
});
export type CloseCallRes = z.output<typeof CloseCallRes>;

export const DemoFireReq = z.object({
  pattern: z.enum(["arrest", "cardiac"]),
  incidentId: z.string().min(1).optional(),
});
export type DemoFireReq = z.output<typeof DemoFireReq>;
export const DemoFireRes = z.object({
  incidentId: z.string(),
  ref: z.string(),
  displayId: z.string(),
});
export type DemoFireRes = z.output<typeof DemoFireRes>;

export const DemoCloseReq = z.object({
  incidentId: z.string().min(1),
});
export type DemoCloseReq = z.output<typeof DemoCloseReq>;
export const DemoCloseRes = z.object({ ok: z.literal(true) });
export type DemoCloseRes = z.output<typeof DemoCloseRes>;

export const DemoResetReq = z.object({}).strict();
export type DemoResetReq = z.output<typeof DemoResetReq>;
export const DemoResetRes = z.object({
  deleted: z.record(z.string(), z.number()),
});
export type DemoResetRes = z.output<typeof DemoResetRes>;

export const ErrorRes = z.object({ error: z.string() });
export type ErrorRes = z.output<typeof ErrorRes>;
