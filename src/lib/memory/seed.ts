import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Document, Filter } from "mongodb";
import {
  CURATED_POSTMORTEM_CAP,
  DECISIONS,
  INCIDENTS,
  POSTMORTEMS,
  REMEDIATIONS,
  SEED_DEFAULT_TEMPLATED,
  SEED_STRATA,
  SEED_TARGET,
  callTypeFamily,
  labelFor,
  type CallTypeFamily,
  type GroundTruth,
  type IncidentDoc,
  type MemoryOrigin,
  type PostmortemDoc,
  type RemediationDoc,
  type RemediationOutcome,
} from "@/lib/contracts";
import { col, ping } from "@/lib/db/client";
import { embeddings, llm } from "@/lib/registry";

export const DOSE_RE = /\d+\s*(mg|mcg|mL|g)\b/i;

const DEFAULT_SEED = 20260813;
const DEFAULT_CONCURRENCY = 8;
const INSERT_CHUNK = 500;
const EMBED_CHUNK = 128;
const POOL_MULTIPLIER = 5;
const LLM_FAIL_FRACTION = 0.1;
const WORD_MIN = 60;
const WORD_MAX = 110;
const SLOW_RATIO = 1.5;
const OTHER_TRANSITION_CAP = 0.15;

const PAD_SENTENCES = [
  "We logged the mismatch so the next crew would not have to rediscover it.",
  "The first read was the dispatch type; the close type is what the scene actually was.",
  "Nothing about the close type was visible from the dispatch label alone.",
];

const CANDIDATE_FILTER: Filter<IncidentDoc> = {
  isLive: false,
  _groundTruth: { $exists: true },
  "cad.initialSeverityLevelCode": { $gte: 1, $lte: 8 },
  $expr: { $ne: ["$_groundTruth.finalCallType", "$cad.initialCallType"] },
};

const TOTAL_SECONDS_EXPR = {
  $let: {
    vars: {
      r: "$_groundTruth.incidentResponseSeconds",
      t: "$_groundTruth.incidentTravelSeconds",
    },
    in: {
      $cond: {
        if: { $eq: [{ $type: "$$r" }, "number"] },
        then: {
          $add: [
            "$$r",
            {
              $cond: {
                if: { $eq: [{ $type: "$$t" }, "number"] },
                then: "$$t",
                else: 0,
              },
            },
          ],
        },
        else: null,
      },
    },
  },
};

export interface SeedOptions {
  target?: number;
  templated?: boolean;
  llm?: boolean;
  concurrency?: number;
  seed?: number;
  fromFixtures?: boolean;
  curatedOnly?: boolean;
  dryRun?: boolean;
}

export interface SeedSelection {
  incident: IncidentDoc;
  transition: string;
  severityDelta: number;
  reopened: boolean;
  totalSeconds: number | null;
  familyMedianSeconds: number | null;
}

export interface SeedReport {
  selected: number;
  postmortemsWritten: number;
  remediationsWritten: number;
  curatedWritten: number;
  byTransition: Record<string, number>;
  outcomes: { success: number; failure: number };
  narrativeMode: "llm" | "templated";
  llmFailures: number;
  decisionsCount: number;
  elapsedMs: number;
}

export interface RemediationDraft {
  incidentId: string;
  action: string;
  outcome: RemediationOutcome;
  durationSeconds: number | null;
  costMinutes: number | null;
  sideEffects: string[];
  origin: MemoryOrigin;
  callTypeFamily: CallTypeFamily;
  embeddedText: string;
  t: Date;
}

export interface CuratedEntry {
  id: string;
  select: { initialCallType: string; finalCallType: string; dispatchArea?: string };
  narrativeTemplate: string;
  lessons: string[];
  whatChangedTemplate: string;
}

export let familyMediansAggregationCalls = 0;

let mediansCache: Map<CallTypeFamily, number> | undefined;

const TOTAL_SECONDS_EXPR_STAGE = {
  $addFields: { incidentTotalSeconds: TOTAL_SECONDS_EXPR },
};

export function wordCount(s: string): number {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  return parts.length;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return results;
}

export function computeCostMinutes(
  totalSeconds: number | null,
  medianSeconds: number | null,
): number | null {
  if (totalSeconds === null || medianSeconds === null) return null;
  if (!Number.isFinite(totalSeconds) || !Number.isFinite(medianSeconds)) return null;
  const minutes = Math.max(0, (totalSeconds - medianSeconds) / 60);
  return Math.round(minutes * 10) / 10;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

export function incidentTotalSeconds(gt: GroundTruth | undefined): number | null {
  if (!gt) return null;
  const response = gt.incidentResponseSeconds;
  const travel = gt.incidentTravelSeconds;
  if (response === null || response === undefined) return null;
  if (travel === null || travel === undefined) return response;
  return response + travel;
}

function asDate(value: unknown, fallback?: Date | null): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback === undefined ? new Date(0) : fallback;
}

function hydrateIncident(raw: IncidentDoc): IncidentDoc {
  const gt = raw._groundTruth;
  return {
    ...raw,
    cad: {
      ...raw.cad,
      incidentDatetime: asDate(raw.cad.incidentDatetime) ?? new Date(0),
    },
    createdAt: asDate(raw.createdAt) ?? new Date(0),
    updatedAt: asDate(raw.updatedAt) ?? new Date(0),
    _groundTruth: gt
      ? {
          ...gt,
          incidentCloseDatetime: asDate(gt.incidentCloseDatetime, null),
        }
      : undefined,
  };
}

function isCandidate(doc: IncidentDoc): boolean {
  const gt = doc._groundTruth;
  if (doc.isLive || !gt) return false;
  const sev = doc.cad.initialSeverityLevelCode;
  if (sev < 1 || sev > 8) return false;
  return gt.finalCallType !== doc.cad.initialCallType;
}

function transitionOf(doc: IncidentDoc): string {
  const final = doc._groundTruth?.finalCallType ?? doc.cad.initialCallType;
  return `${doc.cad.initialCallType}->${final}`;
}

function toSelection(
  incident: IncidentDoc,
  medians: Map<CallTypeFamily, number>,
): SeedSelection {
  const gt = incident._groundTruth;
  const total = incidentTotalSeconds(gt);
  const family = incident.callTypeFamily;
  return {
    incident,
    transition: transitionOf(incident),
    severityDelta: gt
      ? incident.cad.initialSeverityLevelCode - gt.finalSeverityLevelCode
      : 0,
    reopened: gt?.reopenIndicator === true,
    totalSeconds: total,
    familyMedianSeconds: medians.get(family) ?? null,
  };
}

function mediansFromIncidents(docs: IncidentDoc[]): Map<CallTypeFamily, number> {
  const buckets = new Map<CallTypeFamily, number[]>();
  for (const doc of docs) {
    const total = incidentTotalSeconds(doc._groundTruth);
    if (total === null) continue;
    const list = buckets.get(doc.callTypeFamily) ?? [];
    list.push(total);
    buckets.set(doc.callTypeFamily, list);
  }
  const out = new Map<CallTypeFamily, number>();
  for (const [family, values] of buckets) {
    const m = median(values);
    if (m !== null) out.set(family, m);
  }
  return out;
}

function majorVersion(version: string): number {
  const n = parseInt(version.split(".")[0] ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function strataFor(target: number): { uncArrest: number; sickCard: number; other: number } {
  if (target === SEED_TARGET) return { ...SEED_STRATA };
  const sum = SEED_STRATA.uncArrest + SEED_STRATA.sickCard + SEED_STRATA.other;
  const uncArrest = Math.round((SEED_STRATA.uncArrest / sum) * target);
  const sickCard = Math.round((SEED_STRATA.sickCard / sum) * target);
  return { uncArrest, sickCard, other: Math.max(0, target - uncArrest - sickCard) };
}

function bucketKind(doc: IncidentDoc): "uncArrest" | "sickCard" | "other" {
  const initial = doc.cad.initialCallType;
  const final = doc._groundTruth?.finalCallType;
  if (initial === "UNC" && final === "ARREST") return "uncArrest";
  if (initial === "SICK" && final === "CARD") return "sickCard";
  return "other";
}

function bucketMatch(kind: "uncArrest" | "sickCard" | "other"): Filter<IncidentDoc> {
  if (kind === "uncArrest") {
    return { "cad.initialCallType": "UNC", "_groundTruth.finalCallType": "ARREST" };
  }
  if (kind === "sickCard") {
    return { "cad.initialCallType": "SICK", "_groundTruth.finalCallType": "CARD" };
  }
  return {
    $nor: [
      { "cad.initialCallType": "UNC", "_groundTruth.finalCallType": "ARREST" },
      { "cad.initialCallType": "SICK", "_groundTruth.finalCallType": "CARD" },
    ],
  };
}

function pickFromPool(
  pool: SeedSelection[],
  n: number,
  rng: () => number,
  capPerTransition?: number,
): SeedSelection[] {
  const under = shuffle(
    pool.filter((s) => s.severityDelta > 0),
    rng,
  );
  const rest = shuffle(
    pool.filter((s) => s.severityDelta <= 0),
    rng,
  );
  const ordered = [...under, ...rest];
  const out: SeedSelection[] = [];
  const counts = new Map<string, number>();
  for (const sel of ordered) {
    if (out.length >= n) break;
    if (capPerTransition !== undefined) {
      const used = counts.get(sel.transition) ?? 0;
      if (used >= capPerTransition) continue;
      counts.set(sel.transition, used + 1);
    }
    out.push(sel);
  }
  return out;
}

async function loadFixtureIncidents(): Promise<IncidentDoc[]> {
  const path = join(process.cwd(), "fixtures", "incidents.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as IncidentDoc[];
  return raw.map(hydrateIncident);
}

export async function familyMedians(): Promise<Map<CallTypeFamily, number>> {
  if (mediansCache) return mediansCache;

  const hello = await ping();
  console.log(`MongoDB ${hello.version}`);

  familyMediansAggregationCalls += 1;
  const incidents = col<IncidentDoc>(INCIDENTS);
  type MedianRow = { _id: CallTypeFamily; medianSeconds?: number; seconds?: number[] };
  const prefix: Document[] = [
    { $match: CANDIDATE_FILTER },
    TOTAL_SECONDS_EXPR_STAGE,
    { $match: { incidentTotalSeconds: { $ne: null } } },
  ];
  const groupMedian: Document = {
    $group: {
      _id: "$callTypeFamily",
      medianSeconds: { $median: { input: "$incidentTotalSeconds", method: "approximate" } },
    },
  };
  const groupPush: Document = {
    $group: {
      _id: "$callTypeFamily",
      seconds: { $push: "$incidentTotalSeconds" },
    },
  };

  const run = (group: Document) =>
    incidents.aggregate<MedianRow>([...prefix, group]).toArray();

  let rows: MedianRow[];
  const canMedian = majorVersion(hello.version) >= 7;
  if (canMedian) {
    try {
      rows = await run(groupMedian);
    } catch (error) {
      console.warn(
        `$median unavailable (${error instanceof Error ? error.message : String(error)}); falling back to $push`,
      );
      rows = await run(groupPush);
    }
  } else {
    rows = await run(groupPush);
  }

  const out = new Map<CallTypeFamily, number>();
  for (const row of rows) {
    if (typeof row.medianSeconds === "number" && Number.isFinite(row.medianSeconds)) {
      out.set(row._id, row.medianSeconds);
      continue;
    }
    const m = median((row.seconds ?? []).filter((n) => typeof n === "number"));
    if (m !== null) out.set(row._id, m);
  }
  mediansCache = out;
  return out;
}

export async function selectSeedIncidents(opts: SeedOptions): Promise<SeedSelection[]> {
  const target = opts.target ?? SEED_TARGET;
  const seed = opts.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);
  const strata = strataFor(target);
  const poolLimit = target * POOL_MULTIPLIER;
  const otherCap = Math.max(1, Math.floor(target * OTHER_TRANSITION_CAP));

  let uncPool: IncidentDoc[];
  let sickPool: IncidentDoc[];
  let otherPool: IncidentDoc[];
  let medians: Map<CallTypeFamily, number>;

  if (opts.fromFixtures) {
    const all = (await loadFixtureIncidents()).filter(isCandidate).sort((a, b) =>
      a.incidentId.localeCompare(b.incidentId),
    );
    medians = mediansFromIncidents(all);
    uncPool = all.filter((d) => bucketKind(d) === "uncArrest").slice(0, poolLimit);
    sickPool = all.filter((d) => bucketKind(d) === "sickCard").slice(0, poolLimit);
    otherPool = all.filter((d) => bucketKind(d) === "other").slice(0, poolLimit);
  } else {
    medians = await familyMedians();
    const incidents = col<IncidentDoc>(INCIDENTS);
    const fetch = (kind: "uncArrest" | "sickCard" | "other") =>
      incidents
        .find({ ...CANDIDATE_FILTER, ...bucketMatch(kind) })
        .sort({ incidentId: 1 })
        .limit(poolLimit)
        .toArray();
    [uncPool, sickPool, otherPool] = await Promise.all([
      fetch("uncArrest"),
      fetch("sickCard"),
      fetch("other"),
    ]);
  }

  const unc = pickFromPool(uncPool.map((d) => toSelection(d, medians)), strata.uncArrest, rng);
  const sick = pickFromPool(sickPool.map((d) => toSelection(d, medians)), strata.sickCard, rng);
  const other = pickFromPool(
    otherPool.map((d) => toSelection(d, medians)),
    strata.other,
    rng,
    otherCap,
  );
  return [...unc, ...sick, ...other];
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

function severityDirection(sel: SeedSelection): string {
  const initial = sel.incident.cad.initialSeverityLevelCode;
  const final = sel.incident._groundTruth?.finalSeverityLevelCode ?? initial;
  if (sel.severityDelta > 0) return `upgraded to`;
  if (sel.severityDelta < 0) return `downgraded to`;
  return `held at`;
}

function extraClause(sel: SeedSelection): string {
  const cost = computeCostMinutes(sel.totalSeconds, sel.familyMedianSeconds);
  const bits: string[] = [];
  if (sel.reopened) {
    bits.push("The incident was reopened after close.");
  }
  if (
    sel.totalSeconds !== null &&
    sel.familyMedianSeconds !== null &&
    sel.totalSeconds > SLOW_RATIO * sel.familyMedianSeconds &&
    cost !== null
  ) {
    bits.push(`The extra time versus the family median cost ${cost} minutes.`);
  } else if (cost !== null && cost > 0) {
    bits.push(`That mismatch cost ${cost} minutes against the family median.`);
  }
  return bits.join(" ");
}

export function templatedNarrative(sel: SeedSelection): string {
  const initial = sel.incident.cad.initialCallType;
  const final = sel.incident._groundTruth?.finalCallType ?? initial;
  const initialLabel = labelFor(initial);
  const finalLabel = labelFor(final);
  const borough = sel.incident.cad.borough;
  const area = sel.incident.cad.dispatchArea;
  const finalSev = sel.incident._groundTruth?.finalSeverityLevelCode
    ?? sel.incident.cad.initialSeverityLevelCode;
  const extra = extraClause(sel);
  const body = [
    `We were dispatched for ${article(initialLabel)} ${initialLabel} in ${borough}, ${area}.`,
    `It was closed as ${article(finalLabel)} ${finalLabel}.`,
    `The severity was ${severityDirection(sel)} level ${finalSev}.`,
    `The tell that should have flipped the read sooner was the mismatch between the dispatch label and what we found on arrival — the scene did not match a routine ${initialLabel} once we were on the floor.`,
    `We treated it as the dispatched type at first, then corrected once the presenting picture was clear.`,
    `Handling this as ${initialLabel} is the path we would not repeat.`,
    extra,
  ]
    .filter(Boolean)
    .join(" ");
  return fitWordBand(body);
}

function fitWordBand(text: string): string {
  let s = text.replace(/\s+/g, " ").trim();
  let n = wordCount(s);
  let i = 0;
  while (n < WORD_MIN && i < PAD_SENTENCES.length) {
    s = `${s} ${PAD_SENTENCES[i++] as string}`;
    n = wordCount(s);
  }
  while (n < WORD_MIN) {
    s = `${s} We wrote the mismatch down.`;
    n = wordCount(s);
  }
  if (n > WORD_MAX) {
    s = s.split(/\s+/).slice(0, WORD_MAX).join(" ");
  }
  return s;
}

function lessonsFor(sel: SeedSelection): string[] {
  const initial = labelFor(sel.incident.cad.initialCallType);
  const final = labelFor(sel.incident._groundTruth?.finalCallType ?? sel.incident.cad.initialCallType);
  const lessons = [`A ${initial} dispatch can close as ${final}.`];
  if (sel.severityDelta > 0) {
    lessons.push("The first read understated severity.");
  }
  if (sel.reopened) {
    lessons.push("A reopened incident is failure memory, not a footnote.");
  }
  return lessons;
}

function narrativePrompt(sel: SeedSelection): string {
  const initial = sel.incident.cad.initialCallType;
  const final = sel.incident._groundTruth?.finalCallType ?? initial;
  const cost = computeCostMinutes(sel.totalSeconds, sel.familyMedianSeconds);
  const extra = extraClause(sel);
  return [
    "Write a postmortem crew debrief narrative.",
    "60 to 110 words. First person plural, past tense, the register of a real crew debrief.",
    "Cover what was dispatched, what it actually turned out to be, and what the tell was — the observable detail that should have flipped the read sooner.",
    extra ? `Where time was lost: ${extra}` : "",
    "Never invent vitals, drug doses, or patient identifiers.",
    "The only numbers permitted in a narrative are the derived costMinutes and severity codes.",
    "Do not propose treatment, diagnosis, or a dose.",
    `Dispatch: ${labelFor(initial)} (${initial}) in ${sel.incident.cad.borough} ${sel.incident.cad.dispatchArea}.`,
    `Closed as: ${labelFor(final)} (${final}).`,
    `Severity codes: ${sel.incident.cad.initialSeverityLevelCode} to ${sel.incident._groundTruth?.finalSeverityLevelCode ?? sel.incident.cad.initialSeverityLevelCode}.`,
    `Reopened: ${sel.reopened ? "yes" : "no"}.`,
    `Derived costMinutes: ${cost === null ? "unknown" : String(cost)}.`,
    `Display id: ${sel.incident.displayId}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function buildNarrative(
  sel: SeedSelection,
  opts: { templated: boolean },
): Promise<{ narrative: string; lessons: string[] }> {
  const lessons = lessonsFor(sel);
  if (opts.templated) {
    return { narrative: templatedNarrative(sel), lessons };
  }
  const port = await llm();
  const raw = await port.text(narrativePrompt(sel), { maxWords: WORD_MAX });
  if (DOSE_RE.test(raw) || wordCount(raw) < WORD_MIN || wordCount(raw) > WORD_MAX) {
    throw new Error("narrative rejected");
  }
  return { narrative: raw.trim(), lessons };
}

export function deriveRemediations(sels: SeedSelection[]): RemediationDraft[] {
  return sels.map((sel) => {
    const initial = sel.incident.cad.initialCallType;
    const final = sel.incident._groundTruth?.finalCallType ?? initial;
    const initialSev = sel.incident.cad.initialSeverityLevelCode;
    const finalSev = sel.incident._groundTruth?.finalSeverityLevelCode ?? initialSev;
    const sideEffects: string[] = [];
    if (sel.reopened) sideEffects.push("incident reopened");
    if (sel.severityDelta > 0) {
      sideEffects.push(`undertriaged: severity ${initialSev} to ${finalSev}`);
    }
    if (
      sel.totalSeconds !== null &&
      sel.familyMedianSeconds !== null &&
      sel.totalSeconds > SLOW_RATIO * sel.familyMedianSeconds
    ) {
      const ratio = Math.round((sel.totalSeconds / sel.familyMedianSeconds) * 10) / 10;
      sideEffects.push(`slow: ${ratio}x family median`);
    }
    const outcome: RemediationOutcome = sideEffects.length > 0 ? "failure" : "success";
    const action = `handled as ${labelFor(initial)}`;
    const costMinutes = computeCostMinutes(sel.totalSeconds, sel.familyMedianSeconds);
    const reasons = sideEffects.length > 0 ? sideEffects.join("; ") : "no failure signal";
    const embeddedText = [
      action,
      `outcome ${outcome}`,
      reasons,
      `dispatched as ${labelFor(initial)}, closed as ${labelFor(final)}`,
    ].join(". ") + ".";
    return {
      incidentId: sel.incident.incidentId,
      action,
      outcome,
      durationSeconds: sel.totalSeconds,
      costMinutes,
      sideEffects,
      origin: "seeded" as const,
      callTypeFamily: callTypeFamily(initial),
      embeddedText,
      t: sel.incident.cad.incidentDatetime,
    };
  });
}

export function assertDeriveRemediationRules(): void {
  const baseCad = {
    initialCallType: "SICK",
    initialSeverityLevelCode: 6,
    borough: "BROOKLYN",
    zipcode: "11201",
    dispatchArea: "B3",
    incidentDatetime: new Date("2024-01-01T00:00:00.000Z"),
  };
  const baseGt: GroundTruth = {
    finalCallType: "CARD",
    finalSeverityLevelCode: 6,
    severityDelta: 0,
    incidentCloseDatetime: null,
    incidentDispositionCode: null,
    reopenIndicator: false,
    dispatchResponseSeconds: null,
    incidentResponseSeconds: 100,
    incidentTravelSeconds: 0,
  };
  const stub = (over: Partial<SeedSelection> & { gt?: Partial<GroundTruth>; cad?: Partial<IncidentDoc["cad"]> }): SeedSelection => {
    const cad = { ...baseCad, ...over.cad };
    const gt = { ...baseGt, ...over.gt };
    const incident: IncidentDoc = {
      incidentId: over.incident?.incidentId ?? "1",
      displayId: "0001",
      ref: "240101-0001",
      status: "closed",
      cad,
      callTypeFamily: callTypeFamily(cad.initialCallType),
      timeline: [],
      isLive: false,
      _groundTruth: gt,
      createdAt: cad.incidentDatetime,
      updatedAt: cad.incidentDatetime,
    };
    return {
      incident,
      transition: `${cad.initialCallType}->${gt.finalCallType}`,
      severityDelta: over.severityDelta ?? 0,
      reopened: over.reopened ?? false,
      totalSeconds: over.totalSeconds ?? 100,
      familyMedianSeconds: over.familyMedianSeconds ?? 100,
    };
  };

  const [reopen] = deriveRemediations([stub({ severityDelta: 0, reopened: true, gt: { reopenIndicator: true } })]);
  const [under] = deriveRemediations([
    stub({
      severityDelta: 4,
      cad: { initialSeverityLevelCode: 6 },
      gt: { finalSeverityLevelCode: 2, severityDelta: 4 },
    }),
  ]);
  const [slow] = deriveRemediations([stub({ severityDelta: 0, totalSeconds: 200, familyMedianSeconds: 100 })]);
  const [ok] = deriveRemediations([stub({ severityDelta: 0, totalSeconds: 100, familyMedianSeconds: 100 })]);

  if (reopen?.outcome !== "failure" || !reopen.sideEffects.includes("incident reopened")) {
    throw new Error("deriveRemediations: reopen should be failure");
  }
  if (under?.outcome !== "failure" || !under.sideEffects.some((s) => s.startsWith("undertriaged:"))) {
    throw new Error("deriveRemediations: undertriage should be failure");
  }
  if (slow?.outcome !== "failure" || !slow.sideEffects.some((s) => s.startsWith("slow:"))) {
    throw new Error("deriveRemediations: slow should be failure");
  }
  if (ok?.outcome !== "success" || (ok.sideEffects.length ?? 1) !== 0) {
    throw new Error("deriveRemediations: none-of-the-above should be success");
  }

  if (computeCostMinutes(null, 100) !== null || computeCostMinutes(100, null) !== null) {
    throw new Error("computeCostMinutes: null in either input must return null");
  }
  if (computeCostMinutes(0, 100) !== 0) {
    throw new Error("computeCostMinutes: must never return a negative number");
  }
  if (computeCostMinutes(160, 100) !== 1) {
    throw new Error("computeCostMinutes: 60s over median must be 1.0");
  }
  if (computeCostMinutes(90, 100) !== 0) {
    throw new Error("computeCostMinutes: below-median must clamp to 0");
  }
}

export async function loadCurated(): Promise<CuratedEntry[]> {
  const path = join(process.cwd(), "fixtures", "curated-postmortems.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    note?: string;
    entries?: CuratedEntry[];
  };
  if (!parsed.note || !parsed.note.toLowerCase().includes("synthetic")) {
    throw new Error("fixtures/curated-postmortems.json must carry a note naming the synthetic detail");
  }
  const entries = parsed.entries ?? [];
  if (entries.length > CURATED_POSTMORTEM_CAP) {
    console.warn(
      `curated entries ${entries.length} exceed CURATED_POSTMORTEM_CAP=${CURATED_POSTMORTEM_CAP}; truncating`,
    );
  }
  return entries.slice(0, CURATED_POSTMORTEM_CAP);
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function bindVars(sel: SeedSelection): Record<string, string> {
  const initial = sel.incident.cad.initialCallType;
  const final = sel.incident._groundTruth?.finalCallType ?? initial;
  const cost = computeCostMinutes(sel.totalSeconds, sel.familyMedianSeconds);
  return {
    costMinutes: cost === null ? "unmeasured" : cost.toFixed(1),
    displayId: sel.incident.displayId,
    dispatchArea: sel.incident.cad.dispatchArea,
    label: labelFor(initial),
    initialCallType: initial,
    finalCallType: final,
    borough: sel.incident.cad.borough,
  };
}

function scoreBind(sel: SeedSelection): number {
  const cost = computeCostMinutes(sel.totalSeconds, sel.familyMedianSeconds) ?? 0;
  return (sel.severityDelta > 0 ? 1000 : 0) + cost;
}

async function atlasIncidentCount(): Promise<number | null> {
  try {
    return await col(INCIDENTS).countDocuments({});
  } catch {
    return null;
  }
}

function matchSelect(
  doc: IncidentDoc,
  select: CuratedEntry["select"],
  ignoreArea: boolean,
): boolean {
  if (doc.cad.initialCallType !== select.initialCallType) return false;
  if ((doc._groundTruth?.finalCallType ?? "") !== select.finalCallType) return false;
  if (!ignoreArea && select.dispatchArea && doc.cad.dispatchArea !== select.dispatchArea) {
    return false;
  }
  return true;
}

function sameFamilyTransition(doc: IncidentDoc, select: CuratedEntry["select"]): boolean {
  return (
    callTypeFamily(doc.cad.initialCallType) === callTypeFamily(select.initialCallType) &&
    callTypeFamily(doc._groundTruth?.finalCallType ?? "") === callTypeFamily(select.finalCallType)
  );
}

async function bindCuratedEntry(
  entry: CuratedEntry,
  pool: IncidentDoc[],
  medians: Map<CallTypeFamily, number>,
): Promise<SeedSelection | null> {
  let matches = pool.filter((d) => matchSelect(d, entry.select, false));
  let how = "exact";
  if (matches.length === 0) {
    matches = pool.filter((d) => matchSelect(d, entry.select, true));
    how = "codes, any dispatchArea";
  }
  if (matches.length === 0) {
    matches = pool.filter((d) => sameFamilyTransition(d, entry.select));
    how = "callTypeFamily transition";
  }
  if (matches.length === 0) return null;
  const ranked = matches
    .map((d) => toSelection(d, medians))
    .sort((a, b) => {
      const dScore = scoreBind(b) - scoreBind(a);
      if (dScore !== 0) return dScore;
      return a.incident.incidentId.localeCompare(b.incident.incidentId);
    });
  const bound = ranked[0];
  if (!bound) return null;
  if (how !== "exact") {
    console.warn(
      `curated ${entry.id}: no exact match for ${entry.select.initialCallType}/${entry.select.finalCallType}/${entry.select.dispatchArea ?? "*"}; bound to ${bound.incident.incidentId} (${bound.incident.cad.dispatchArea}) via ${how}`,
    );
  }
  return bound;
}

async function embedAll(texts: string[], dim: number): Promise<number[][]> {
  const port = await embeddings();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
    const chunk = texts.slice(i, i + EMBED_CHUNK);
    const embedded = await port.embed(chunk, "document");
    if (embedded.length !== chunk.length) {
      throw new Error(`embed returned ${embedded.length} vectors, expected ${chunk.length}`);
    }
    for (const v of embedded) {
      if (v.length !== dim) {
        throw new Error(
          `embedding length ${v.length} != ${dim}. A dimension mismatch produces empty search results with no error.`,
        );
      }
    }
    vectors.push(...embedded);
  }
  return vectors;
}

async function insertChunks<T extends object>(collection: string, docs: T[]): Promise<number> {
  if (docs.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    const chunk = docs.slice(i, i + INSERT_CHUNK);
    const result = await col(collection).insertMany(chunk, { ordered: false });
    n += result.insertedCount;
  }
  return n;
}

function assertNarrative(narrative: string, where: string): void {
  const n = wordCount(narrative);
  if (n < WORD_MIN || n > WORD_MAX) {
    throw new Error(`${where}: word count ${n} is outside ${WORD_MIN}-${WORD_MAX}`);
  }
  if (DOSE_RE.test(narrative)) {
    throw new Error(`${where}: narrative matches dose regex`);
  }
}

function histogram(sels: SeedSelection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sel of sels) {
    out[sel.transition] = (out[sel.transition] ?? 0) + 1;
  }
  return out;
}

function useLlm(opts: SeedOptions): boolean {
  if (opts.templated === true) return false;
  if (opts.llm === true) return true;
  return !SEED_DEFAULT_TEMPLATED;
}

async function countDecisions(): Promise<number> {
  try {
    return await col(DECISIONS).countDocuments({});
  } catch {
    return 0;
  }
}

async function printDecisionsIfAny(count: number): Promise<void> {
  if (count === 0) return;
  const sample = await col(DECISIONS)
    .find({})
    .project({ incidentId: 1, actionChosen: 1, t: 1, origin: 1 })
    .limit(20)
    .toArray();
  console.error("decisions is not empty:", JSON.stringify(sample, null, 2));
}

function toPostmortem(
  sel: SeedSelection,
  narrative: string,
  lessons: string[],
  origin: MemoryOrigin,
  whatChanged: string,
  embedding: number[],
): PostmortemDoc {
  return {
    incidentId: sel.incident.incidentId,
    displayId: sel.incident.displayId,
    narrative,
    whatChanged,
    severityDelta: sel.severityDelta,
    lessons,
    origin,
    callTypeFamily: sel.incident.callTypeFamily,
    embedding,
    embeddedText: narrative,
    t: sel.incident.cad.incidentDatetime,
  };
}

function toRemediation(draft: RemediationDraft, embedding: number[]): RemediationDoc {
  return { ...draft, embedding };
}

export async function seedMemory(opts: SeedOptions): Promise<SeedReport> {
  const started = Date.now();
  assertDeriveRemediationRules();

  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const narrativeMode: "llm" | "templated" = useLlm(opts) ? "llm" : "templated";

  let llmFailures = 0;
  const selected = opts.curatedOnly ? [] : await selectSeedIncidents(opts);

  let stopLlm = false;
  const narratives = await mapWithConcurrency(selected, concurrency, async (sel) => {
    if (narrativeMode === "templated" || stopLlm) {
      return { narrative: templatedNarrative(sel), lessons: lessonsFor(sel) };
    }
    try {
      return await buildNarrative(sel, { templated: false });
    } catch {
      llmFailures += 1;
      if (llmFailures > LLM_FAIL_FRACTION * selected.length) {
        stopLlm = true;
      }
      return { narrative: templatedNarrative(sel), lessons: lessonsFor(sel) };
    }
  });

  if (stopLlm) {
    console.error("already defaulting to templated");
    throw new Error("already defaulting to templated");
  }

  for (let i = 0; i < narratives.length; i += 1) {
    assertNarrative(narratives[i]?.narrative ?? "", `seeded[${selected[i]?.incident.incidentId}]`);
  }

  const seededDrafts = deriveRemediations(selected).map((d) => ({ ...d, origin: "seeded" as const }));

  const medians = opts.fromFixtures
    ? mediansFromIncidents((await loadFixtureIncidents()).filter(isCandidate))
    : await familyMedians();

  const curatedEntries = await loadCurated();
  let curatedSels: { entry: CuratedEntry; sel: SeedSelection; narrative: string }[] = [];

  const atlasCount = await atlasIncidentCount();
  const pool = opts.fromFixtures
    ? await loadFixtureIncidents()
    : atlasCount && atlasCount > 0
      ? await col<IncidentDoc>(INCIDENTS).find(CANDIDATE_FILTER).sort({ incidentId: 1 }).toArray()
      : [];

  if (pool.length === 0) {
    console.warn("incidents is empty (PHASE-04 has not run); skipping curated and continuing.");
  } else {
    const used = new Set<string>();
    for (const entry of curatedEntries) {
      const bound = await bindCuratedEntry(entry, pool, medians);
      if (!bound) {
        console.warn(`curated ${entry.id}: no matching incident; skipping`);
        continue;
      }
      if (used.has(bound.incident.incidentId)) {
        console.warn(`curated ${entry.id}: incident ${bound.incident.incidentId} already bound; skipping`);
        continue;
      }
      if (!opts.dryRun) {
        if (atlasCount === 0 || atlasCount === null) {
          console.warn(
            `curated ${entry.id}: incidents collection is empty; skipping so curated incidentIds are never orphaned`,
          );
          continue;
        }
        const exists = await col(INCIDENTS).countDocuments({ incidentId: bound.incident.incidentId });
        if (exists === 0) {
          console.warn(
            `curated ${entry.id}: bound ${bound.incident.incidentId} is not in incidents; skipping`,
          );
          continue;
        }
      }
      used.add(bound.incident.incidentId);
      const narrative = fitWordBand(fillTemplate(entry.narrativeTemplate, bindVars(bound)));
      assertNarrative(narrative, `curated[${entry.id}]`);
      curatedSels.push({ entry, sel: bound, narrative });
    }
  }

  const curatedDrafts = deriveRemediations(curatedSels.map((c) => c.sel)).map((d) => ({
    ...d,
    origin: "curated" as const,
  }));

  const outcomes = { success: 0, failure: 0 };
  for (const d of [...seededDrafts, ...curatedDrafts]) {
    outcomes[d.outcome] += 1;
  }

  let postmortemsWritten = 0;
  let remediationsWritten = 0;
  let curatedWritten = 0;

  if (!opts.dryRun) {
    const port = await embeddings();
    const dim = port.info().dim;

    if (!opts.curatedOnly) {
      await col(POSTMORTEMS).deleteMany({ origin: "seeded" });
      await col(REMEDIATIONS).deleteMany({ origin: "seeded" });
    }

    const seededPmTexts = narratives.map((n) => n.narrative);
    const seededRmTexts = seededDrafts.map((d) => d.embeddedText);
    const curatedPmTexts = curatedSels.map((c) => c.narrative);
    const curatedRmTexts = curatedDrafts.map((d) => d.embeddedText);
    const allTexts = [...seededPmTexts, ...seededRmTexts, ...curatedPmTexts, ...curatedRmTexts];
    const vectors = allTexts.length > 0 ? await embedAll(allTexts, dim) : [];

    let offset = 0;
    const seededPmVecs = vectors.slice(offset, offset + seededPmTexts.length);
    offset += seededPmTexts.length;
    const seededRmVecs = vectors.slice(offset, offset + seededRmTexts.length);
    offset += seededRmTexts.length;
    const curatedPmVecs = vectors.slice(offset, offset + curatedPmTexts.length);
    offset += curatedPmTexts.length;
    const curatedRmVecs = vectors.slice(offset, offset + curatedRmTexts.length);

    if (!opts.curatedOnly) {
      const postmortems = selected.map((sel, i) =>
        toPostmortem(
          sel,
          narratives[i]?.narrative ?? "",
          narratives[i]?.lessons ?? [],
          "seeded",
          `${sel.incident.cad.initialCallType} → ${sel.incident._groundTruth?.finalCallType ?? sel.incident.cad.initialCallType}`,
          seededPmVecs[i] ?? [],
        ),
      );
      const remediations = seededDrafts.map((d, i) => toRemediation(d, seededRmVecs[i] ?? []));
      postmortemsWritten = await insertChunks(POSTMORTEMS, postmortems);
      remediationsWritten = await insertChunks(REMEDIATIONS, remediations);
    }

    if (curatedSels.length > 0) {
      await col(POSTMORTEMS).deleteMany({ origin: "curated" });
      await col(REMEDIATIONS).deleteMany({ origin: "curated" });
      const curatedPm = curatedSels.map((c, i) =>
        toPostmortem(
          c.sel,
          c.narrative,
          c.entry.lessons,
          "curated",
          fillTemplate(c.entry.whatChangedTemplate, bindVars(c.sel)),
          curatedPmVecs[i] ?? [],
        ),
      );
      const curatedRm = curatedDrafts.map((d, i) => toRemediation(d, curatedRmVecs[i] ?? []));
      curatedWritten = await insertChunks(POSTMORTEMS, curatedPm);
      await insertChunks(REMEDIATIONS, curatedRm);
    }
  } else {
    postmortemsWritten = selected.length;
    remediationsWritten = seededDrafts.length;
    curatedWritten = curatedSels.length;
  }

  const decisionsCount = await countDecisions();
  await printDecisionsIfAny(decisionsCount);

  return {
    selected: selected.length,
    postmortemsWritten,
    remediationsWritten,
    curatedWritten,
    byTransition: histogram(selected),
    outcomes,
    narrativeMode,
    llmFailures,
    decisionsCount,
    elapsedMs: Date.now() - started,
  };
}
