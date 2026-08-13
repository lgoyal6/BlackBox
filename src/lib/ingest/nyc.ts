import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  callTypeFamily,
  CODE_LABELS,
  DEMO_SLICES,
  INCIDENTS,
  SOCRATA_BASE,
  toDisplayId,
  toRef,
} from "@/lib/contracts";
import type { IncidentDoc, ReclassPrior } from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { env } from "@/lib/env";

export type SocrataRow = Record<string, string | undefined>;
export type DemoSlice = (typeof DEMO_SLICES)[number];

export const PITCH_NUMBERS_PATH = "data/pitch-numbers.json";
export const RECLASS_PRIORS_PATH = "data/reclass-priors.json";

const UNIT_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_SOCRATA_LIMIT = 1000;
const GROUP_LIMIT = 999;
const NIGHT_WHERE =
  "(date_extract_hh(incident_datetime)>=22 OR date_extract_hh(incident_datetime)<6)";
const PRIORS_YEAR_FLOOR = "incident_datetime>'2023-01-01T00:00:00'";
const PRIORS_CALL_TYPES = "(initial_call_type='UNC' OR initial_call_type='SICK')";

export interface IngestReport {
  fetched: Record<string, number>;
  transformed: number;
  duplicatesAcrossSlices: number;
  dropped: { reason: string; count: number }[];
  upserted: number;
  modified: number;
  familyHistogram: Record<string, number>;
  unlabeledCodes: { code: string; count: number }[];
  samples: IncidentDoc[];
}

export interface PitchMetric {
  key: string;
  where: string | null;
  value: number;
  expected: number;
  drift: boolean;
}

export interface PitchNumbers {
  computedAt: string;
  source: string;
  metrics: PitchMetric[];
}

interface CountSpec {
  key: string;
  where: string | null;
  expected: number;
}

interface DerivedSpec {
  key: string;
  numer: string;
  denom: string;
  expected: number;
  decimals: number;
}

const PITCH_COUNTS: CountSpec[] = [
  { key: "total_incidents", where: null, expected: 29_978_154 },
  { key: "total_2023", where: "incident_datetime>'2023-01-01T00:00:00'", expected: 5_653_498 },
  {
    key: "divergent_2023",
    where: "incident_datetime>'2023-01-01T00:00:00' AND initial_call_type!=final_call_type",
    expected: 845_887,
  },
  { key: "divergent_all", where: "initial_call_type!=final_call_type", expected: 2_750_007 },
  {
    key: "undertriage_2023",
    where:
      "incident_datetime>'2023-01-01T00:00:00' AND final_severity_level_code<initial_severity_level_code",
    expected: 400_548,
  },
  { key: "reopened_all", where: "reopen_indicator='Y'", expected: 237_210 },
];

const PITCH_DERIVED: DerivedSpec[] = [
  { key: "divergent_2023_pct", numer: "divergent_2023", denom: "total_2023", expected: 15.0, decimals: 1 },
  { key: "divergent_all_pct", numer: "divergent_all", denom: "total_incidents", expected: 9.2, decimals: 1 },
  { key: "undertriage_2023_pct", numer: "undertriage_2023", denom: "total_2023", expected: 7.1, decimals: 1 },
  { key: "reopened_all_pct", numer: "reopened_all", denom: "total_incidents", expected: 0.79, decimals: 2 },
];

function drop(opts: { drops?: string[] } | undefined, reason: string): null {
  opts?.drops?.push(reason);
  return null;
}

function isSeverity(n: number | null): n is number {
  return n !== null && n >= 1 && n <= 8;
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function drifted(value: number, expected: number, isPct: boolean): boolean {
  if (isPct) return Math.abs(value - expected) > 0.1;
  return Math.abs(value - expected) > 0.005 * expected;
}

function buildSocrataUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  const limitRaw = search.get("$limit");
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit >= MAX_SOCRATA_LIMIT) {
      throw new Error(`Refusing $limit ${limitRaw}: never send a $limit at or above ${MAX_SOCRATA_LIMIT}`);
    }
  }
  const url = `${SOCRATA_BASE}?${search.toString()}`;
  if (url.includes("rows.csv") || url.includes("accessType=DOWNLOAD")) {
    throw new Error("Refusing bulk CSV download");
  }
  return url;
}

async function socrataGetOnce(params: Record<string, string>): Promise<SocrataRow[]> {
  const url = buildSocrataUrl(params);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.socrataAppToken) headers["X-App-Token"] = env.socrataAppToken;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
  const body = await res.text();
  if (!body.trim()) {
    throw new Error(
      `Socrata returned empty body (HTTP ${res.status}). Check URLSearchParams encoding before rewriting the predicate.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Socrata ${res.status}: ${body.slice(0, 240)}`);
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    throw new Error(`Socrata returned a non-array body: ${body.slice(0, 240)}`);
  }
  return parsed as SocrataRow[];
}

function isTransientSocrata(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof Error && error.name === "TimeoutError") ||
    msg.includes("aborted due to timeout") ||
    msg.includes("Socrata 5") ||
    msg.includes("fetch failed")
  );
}

async function socrataGet(params: Record<string, string>): Promise<SocrataRow[]> {
  try {
    return await socrataGetOnce(params);
  } catch (error) {
    if (!isTransientSocrata(error)) throw error;
    console.warn("Socrata retry after transient error:", error instanceof Error ? error.message : error);
    return socrataGetOnce(params);
  }
}

function readCount(rows: SocrataRow[]): number {
  const row = rows[0];
  if (!row) return 0;
  const raw = row.n ?? Object.values(row).find((v) => v !== undefined);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function readN(row: SocrataRow): number {
  const raw = row.n ?? row.count_1 ?? Object.values(row).find((v) => v !== undefined && /^\d+(\.\d+)?$/.test(v));
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchSlice(slice: DemoSlice): Promise<SocrataRow[]> {
  if (slice.limit >= MAX_SOCRATA_LIMIT) {
    throw new Error(`Refusing $limit ${slice.limit}: never send a $limit at or above ${MAX_SOCRATA_LIMIT}`);
  }
  return socrataGet({
    $where: slice.where,
    $limit: String(slice.limit),
    $order: "incident_id",
  });
}

export function toInt(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function toNum(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Appends "Z" before parsing so naive Socrata timestamps store as UTC wall-clock. */
export function toDate(v: string | undefined): Date | null {
  if (v === undefined || v === "") return null;
  const withZ = /[zZ]$/.test(v) || /[+-]\d{2}:\d{2}$/.test(v) ? v : `${v}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toBool(v: string | undefined): boolean {
  return v === "Y";
}

/** Deterministic from incidentId. The dataset has no unit field. */
export function synthesizeUnit(incidentId: string): string {
  const digits = incidentId.replace(/\D/g, "") || "0";
  const n = Number(digits.slice(-12));
  const safe = Number.isFinite(n) ? n : 0;
  const num = (safe % 40) + 1;
  const letter = UNIT_LETTERS[safe % 26] ?? "A";
  return `${num}${letter}`;
}

export function toIncidentDoc(
  row: SocrataRow,
  opts?: { now?: Date; drops?: string[] },
): IncidentDoc | null {
  const incidentId = row.incident_id?.trim();
  if (!incidentId) return drop(opts, "missing incident_id");

  const initialCallType = row.initial_call_type?.trim();
  if (!initialCallType) return drop(opts, "missing initial_call_type");

  const initialSeverityLevelCode = toInt(row.initial_severity_level_code);
  if (!isSeverity(initialSeverityLevelCode)) return drop(opts, "severity out of range");

  const finalCallType = row.final_call_type?.trim();
  if (!finalCallType) return drop(opts, "missing final_call_type");

  const finalSeverityLevelCode = toInt(row.final_severity_level_code);
  if (!isSeverity(finalSeverityLevelCode)) return drop(opts, "severity out of range");

  const incidentDatetime = toDate(row.incident_datetime);
  if (!incidentDatetime) return drop(opts, "unparseable incident_datetime");

  const now = opts?.now ?? new Date();
  return {
    incidentId,
    displayId: toDisplayId(incidentId),
    ref: toRef(incidentId, incidentDatetime),
    status: "closed",
    isLive: false,
    timeline: [],
    callTypeFamily: callTypeFamily(initialCallType),
    cad: {
      initialCallType,
      initialSeverityLevelCode,
      borough: row.borough ?? "",
      zipcode: row.zipcode ?? "",
      dispatchArea: row.incident_dispatch_area ?? "",
      unit: synthesizeUnit(incidentId),
      incidentDatetime,
    },
    _groundTruth: {
      finalCallType,
      finalSeverityLevelCode,
      severityDelta: initialSeverityLevelCode - finalSeverityLevelCode,
      incidentCloseDatetime: toDate(row.incident_close_datetime),
      incidentDispositionCode: row.incident_disposition_code?.trim() || null,
      reopenIndicator: toBool(row.reopen_indicator),
      dispatchResponseSeconds: toNum(row.dispatch_response_seconds_qy),
      incidentResponseSeconds: toNum(row.incident_response_seconds_qy),
      incidentTravelSeconds: toNum(row.incident_travel_tm_seconds_qy),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function verifyCodeLabels(docs: IncidentDoc[]): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    const code = doc.cad.initialCallType;
    if (Object.hasOwn(CODE_LABELS, code)) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export async function loadIncidents(opts?: {
  dryRun?: boolean;
  slice?: DemoSlice["name"];
}): Promise<IngestReport> {
  const slices = opts?.slice
    ? DEMO_SLICES.filter((s) => s.name === opts.slice)
    : [...DEMO_SLICES];
  if (opts?.slice && slices.length === 0) {
    throw new Error(`unknown slice ${opts.slice}`);
  }

  const fetched: Record<string, number> = {};
  const drops: string[] = [];
  const now = new Date();
  const byId = new Map<string, IncidentDoc>();
  let duplicatesAcrossSlices = 0;
  let transformed = 0;

  for (const slice of slices) {
    const rows = await fetchSlice(slice);
    fetched[slice.name] = rows.length;
    for (const row of rows) {
      const doc = toIncidentDoc(row, { now, drops });
      if (!doc) continue;
      transformed += 1;
      if (byId.has(doc.incidentId)) {
        duplicatesAcrossSlices += 1;
        continue;
      }
      byId.set(doc.incidentId, doc);
    }
  }

  const docs = [...byId.values()];
  const dropCounts = new Map<string, number>();
  for (const reason of drops) dropCounts.set(reason, (dropCounts.get(reason) ?? 0) + 1);

  let upserted = 0;
  let modified = 0;
  if (!opts?.dryRun && docs.length > 0) {
    const result = await col<IncidentDoc>(INCIDENTS).bulkWrite(
      docs.map((d) => {
        const { createdAt, ...rest } = d;
        return {
          updateOne: {
            filter: { incidentId: d.incidentId },
            update: { $set: rest, $setOnInsert: { createdAt } },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
    upserted = result.upsertedCount;
    modified = result.modifiedCount;
  }

  return {
    fetched,
    transformed,
    duplicatesAcrossSlices,
    dropped: [...dropCounts.entries()].map(([reason, count]) => ({ reason, count })),
    upserted,
    modified,
    familyHistogram: tally(docs.map((d) => d.callTypeFamily)),
    unlabeledCodes: verifyCodeLabels(docs),
    samples: docs.slice(0, 3),
  };
}

export async function computePitchNumbers(opts?: { refresh?: boolean }): Promise<PitchNumbers> {
  if (!opts?.refresh) {
    try {
      const raw = await readFile(PITCH_NUMBERS_PATH, "utf8");
      return JSON.parse(raw) as PitchNumbers;
    } catch {
      // cache missing or unreadable — fall through to a live fetch
    }
  }

  const counts = new Map<string, { value: number; where: string | null }>();
  for (const spec of PITCH_COUNTS) {
    const params: Record<string, string> = { $select: "count(1) AS n" };
    if (spec.where) params.$where = spec.where;
    const value = readCount(await socrataGet(params));
    counts.set(spec.key, { value, where: spec.where });
  }

  const metrics: PitchMetric[] = PITCH_COUNTS.map((spec) => {
    const got = counts.get(spec.key) ?? { value: 0, where: spec.where };
    return {
      key: spec.key,
      where: spec.where,
      value: got.value,
      expected: spec.expected,
      drift: drifted(got.value, spec.expected, false),
    };
  });

  for (const spec of PITCH_DERIVED) {
    const numer = counts.get(spec.numer)?.value ?? 0;
    const denom = counts.get(spec.denom)?.value ?? 0;
    const value = denom === 0 ? 0 : roundTo((numer / denom) * 100, spec.decimals);
    metrics.push({
      key: spec.key,
      where: null,
      value,
      expected: spec.expected,
      drift: drifted(value, spec.expected, true),
    });
  }

  const numbers: PitchNumbers = {
    computedAt: new Date().toISOString(),
    source: "socrata:76xm-jjuj",
    metrics,
  };
  await mkdir(dirname(PITCH_NUMBERS_PATH), { recursive: true });
  await writeFile(PITCH_NUMBERS_PATH, `${JSON.stringify(numbers, null, 2)}\n`, "utf8");
  return numbers;
}

interface GroupRow {
  initialCallType: string;
  dispatchArea: string | null;
  finalCallType: string;
  n: number;
}

async function fetchGroups(opts: { night: boolean; byArea: boolean }): Promise<GroupRow[]> {
  const where = [PRIORS_YEAR_FLOOR, PRIORS_CALL_TYPES];
  if (opts.night) where.push(NIGHT_WHERE);
  const select = opts.byArea
    ? "initial_call_type,incident_dispatch_area,final_call_type,count(1) AS n"
    : "initial_call_type,final_call_type,count(1) AS n";
  const group = opts.byArea
    ? "initial_call_type,incident_dispatch_area,final_call_type"
    : "initial_call_type,final_call_type";
  const rows = await socrataGet({
    $select: select,
    $where: where.join(" AND "),
    $group: group,
    $order: "n DESC",
    $limit: String(GROUP_LIMIT),
  });
  return rows.flatMap((row) => {
    const initialCallType = row.initial_call_type?.trim();
    const finalCallType = row.final_call_type?.trim();
    if (!initialCallType || !finalCallType) return [];
    const area = row.incident_dispatch_area?.trim() || null;
    if (opts.byArea && !area) return [];
    return [{
      initialCallType,
      dispatchArea: opts.byArea ? area : null,
      finalCallType,
      n: readN(row),
    }];
  });
}

function priorsFromGroups(
  rows: GroupRow[],
  nightOnly: boolean,
  topN: number,
  minSampleSize: number,
): ReclassPrior[] {
  const buckets = new Map<string, { initialCallType: string; dispatchArea: string | null; nByFinal: Map<string, number> }>();
  for (const row of rows) {
    const key = `${row.initialCallType}\0${row.dispatchArea ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        initialCallType: row.initialCallType,
        dispatchArea: row.dispatchArea,
        nByFinal: new Map(),
      };
      buckets.set(key, bucket);
    }
    bucket.nByFinal.set(row.finalCallType, (bucket.nByFinal.get(row.finalCallType) ?? 0) + row.n);
  }

  const out: ReclassPrior[] = [];
  for (const bucket of buckets.values()) {
    const sampleSize = [...bucket.nByFinal.values()].reduce((s, n) => s + n, 0);
    if (sampleSize < minSampleSize) continue;
    const top = [...bucket.nByFinal.entries()]
      .map(([finalCallType, n]) => ({
        finalCallType,
        family: callTypeFamily(finalCallType),
        pct: roundTo((n / sampleSize) * 100, 1),
        n,
      }))
      .sort((a, b) => b.pct - a.pct || b.n - a.n)
      .slice(0, topN);
    out.push({
      initialCallType: bucket.initialCallType,
      dispatchArea: bucket.dispatchArea,
      nightOnly,
      sampleSize,
      top,
    });
  }
  return out;
}

export async function computeReclassPriors(opts?: {
  topN?: number;
  minSampleSize?: number;
}): Promise<ReclassPrior[]> {
  const topN = opts?.topN ?? 3;
  const minSampleSize = opts?.minSampleSize ?? 8;
  const priors: ReclassPrior[] = [];
  let shortfall = false;

  async function take(night: boolean, byArea: boolean): Promise<GroupRow[]> {
    try {
      return await fetchGroups({ night, byArea });
    } catch (error) {
      shortfall = true;
      const detail = error instanceof Error ? error.message : String(error);
      if (night) {
        console.warn(`Night-hours SoQL failed; emitting only nightOnly:false priors. ${detail}`);
      } else {
        console.warn(`Group query failed; writing priors from partial results. ${detail}`);
      }
      return [];
    }
  }

  const [areaAll, agnosticAll] = await Promise.all([
    take(false, true),
    take(false, false),
  ]);
  priors.push(...priorsFromGroups(areaAll, false, topN, minSampleSize));
  priors.push(...priorsFromGroups(agnosticAll, false, topN, minSampleSize));

  const [areaNight, agnosticNight] = await Promise.all([
    take(true, true),
    take(true, false),
  ]);
  if (areaNight.length > 0 || agnosticNight.length > 0) {
    priors.push(...priorsFromGroups(areaNight, true, topN, minSampleSize));
    priors.push(...priorsFromGroups(agnosticNight, true, topN, minSampleSize));
  }

  priors.sort((a, b) => {
    const call = a.initialCallType.localeCompare(b.initialCallType);
    if (call !== 0) return call;
    const areaA = a.dispatchArea ?? "";
    const areaB = b.dispatchArea ?? "";
    if (areaA !== areaB) {
      if (a.dispatchArea === null) return -1;
      if (b.dispatchArea === null) return 1;
      return areaA.localeCompare(areaB);
    }
    return Number(a.nightOnly) - Number(b.nightOnly);
  });

  if (shortfall) {
    console.warn(`Priors shortfall: wrote ${priors.length} entries from partial grouped rows.`);
  }

  await mkdir(dirname(RECLASS_PRIORS_PATH), { recursive: true });
  await writeFile(RECLASS_PRIORS_PATH, `${JSON.stringify(priors, null, 2)}\n`, "utf8");
  return priors;
}
