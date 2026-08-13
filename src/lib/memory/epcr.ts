import { labelFor, type DecisionDoc, type IncidentDoc, type PostmortemDoc } from "@/lib/contracts";

export const PCR_SECTION_ORDER = [
  "Response",
  "Scene",
  "Patient",
  "Situation",
  "Assessment",
  "Treatments",
  "Clinical rationale",
  "Disposition",
] as const;

export type PcrSectionTitle = (typeof PCR_SECTION_ORDER)[number];

export interface PcrSection {
  title: PcrSectionTitle;
  body: string;
}

export interface PcrDraft {
  incidentId: string;
  displayId: string;
  ref: string;
  unsigned: true;
  sections: PcrSection[];
}

const NOT_RECORDED = "Not recorded.";
const CAP_ENTRIES = 12;

function capJoin(lines: string[]): string {
  const capped = lines.slice(0, CAP_ENTRIES);
  return capped.length > 0 ? capped.join(" ") : NOT_RECORDED;
}

export function draftPcr(
  incident: IncidentDoc,
  decisions: DecisionDoc[],
  postmortem?: Pick<PostmortemDoc, "narrative" | "whatChanged" | "lessons">,
): PcrDraft {
  const { cad, timeline } = incident;

  const responseBody =
    `${incident.ref}. ${labelFor(cad.initialCallType)}. Dispatch area ${cad.dispatchArea}, ` +
    `${cad.borough}${cad.unit ? `, unit ${cad.unit}` : ""}. ${cad.incidentDatetime.toISOString()}.`;

  const sceneBody = `Dispatch area ${cad.dispatchArea}, ${cad.borough}.`;

  const patientBody = "Not recorded in BlackBox.";

  const situationLines = timeline.filter((e) => e.source === "medic").map((e) => e.text);
  const situationBody = situationLines.length > 0 ? capJoin(situationLines) : "Not recorded.";

  const assessmentLines = timeline
    .filter((e) => e.source !== "medic" && e.kind !== "readback")
    .map((e) => e.text);
  const assessmentBody = assessmentLines.length > 0 ? capJoin(assessmentLines) : "Not recorded.";

  const treatmentsBody =
    decisions.length > 0 ? decisions.map((d) => d.actionChosen).join("; ") : "None recorded.";

  const clinicalRationaleBody =
    decisions.length > 0
      ? decisions.map((d) => `${d.actionChosen} — ${d.rationale}`).join("\n")
      : "No decisions recorded.";

  const dispositionBody = [
    "Transfer of care; unsigned draft only.",
    postmortem?.whatChanged ? `Recorded transition: ${postmortem.whatChanged}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    incidentId: incident.incidentId,
    displayId: incident.displayId,
    ref: incident.ref,
    unsigned: true,
    sections: [
      { title: "Response", body: responseBody },
      { title: "Scene", body: sceneBody },
      { title: "Patient", body: patientBody },
      { title: "Situation", body: situationBody },
      { title: "Assessment", body: assessmentBody },
      { title: "Treatments", body: treatmentsBody },
      { title: "Clinical rationale", body: clinicalRationaleBody },
      { title: "Disposition", body: dispositionBody },
    ],
  };
}

export function renderPcrText(draft: PcrDraft): string {
  const header = "UNSIGNED DRAFT — not a legal patient care report";
  const body = draft.sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
  return `${header}\n\n${body}`;
}
