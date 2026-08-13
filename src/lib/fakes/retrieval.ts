import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RRF_K,
  SOURCE_WEIGHTS,
  labelFor,
  type Hit,
  type IncidentDoc,
  type ReclassPrior,
  type RetrievalSource,
  type SignatureMatch,
} from "@/lib/contracts";
import type { RetrievalPort } from "@/lib/ports";

function loadHits(): Hit[] {
  const raw = readFileSync(join(process.cwd(), "fixtures", "hits.json"), "utf8");
  return JSON.parse(raw) as Hit[];
}

function overlaps(query: string, hit: Hit): boolean {
  const hay = `${hit.title} ${hit.text} ${hit.spoken} ${hit.displayId ?? ""}`.toLowerCase();
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return hay.includes(query.trim().toLowerCase());
  return tokens.some((token) => hay.includes(token));
}

function fuse(hits: Hit[]): Hit[] {
  const grouped = new Map<RetrievalSource, Hit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.source) ?? [];
    list.push(hit);
    grouped.set(hit.source, list);
  }
  const fused: Hit[] = [];
  for (const [source, list] of grouped) {
    const ranked = [...list].sort((a, b) => b.score - a.score);
    ranked.forEach((hit, index) => {
      const rank = index + 1;
      fused.push({
        ...hit,
        rank,
        rrf: SOURCE_WEIGHTS[source] / (RRF_K + rank),
      });
    });
  }
  return fused.sort((a, b) => b.rrf - a.rrf);
}

async function fanOut(
  query: string,
  opts?: { kPerSource?: number; limit?: number; callTypeFamily?: string },
): Promise<Hit[]> {
  const filtered = fuse(loadHits().filter((hit) => overlaps(query, hit)));
  const limit = opts?.limit ?? 12;
  return filtered.slice(0, limit);
}

function incidentQuery(incident: IncidentDoc): string {
  return [
    incident.cad.initialCallType,
    labelFor(incident.cad.initialCallType),
    incident.cad.dispatchArea,
    incident.cad.borough,
    ...incident.timeline.map((entry) => entry.text),
  ].join(" ");
}

async function signatureMatch(incident: IncidentDoc): Promise<SignatureMatch | null> {
  const query = incidentQuery(incident);
  if (query.toLowerCase().includes("transfer")) return null;
  const hits = await fanOut(query, { limit: 5 });
  const chosen = hits.length > 0 ? hits : fuse(loadHits()).slice(0, 3);
  const displayId = chosen.find((h) => h.displayId)?.displayId ?? incident.displayId;
  return {
    hits: chosen,
    summary: `This resembles incident ${displayId}.`,
    displayId,
    confidence: chosen[0]?.score ?? 0.7,
  };
}

async function failureMemory(query: string): Promise<Hit[]> {
  const hits = await fanOut(query);
  return hits.filter((hit) => {
    if (hit.source === "remediations") return true;
    if (hit.source === "postmortems") {
      const delta = hit.meta.severityDelta;
      return typeof delta === "number" && delta > 0;
    }
    return false;
  });
}

async function reclassPrior(initialCallType: string, dispatchArea?: string): Promise<ReclassPrior | null> {
  const family = initialCallType.toUpperCase() === "SICK" ? "general" : "altered";
  const topFinal = initialCallType.toUpperCase() === "SICK" ? "CARD" : "ARREST";
  const topFamily = topFinal === "CARD" ? "cardiac" : "cardiac";
  return {
    initialCallType,
    dispatchArea: dispatchArea ?? null,
    nightOnly: Boolean(dispatchArea),
    sampleSize: 48,
    top: [
      { finalCallType: topFinal, family: topFamily, pct: family === "general" ? 12.4 : 16.2, n: family === "general" ? 6 : 8 },
      { finalCallType: initialCallType, family, pct: 71.0, n: 34 },
    ],
  };
}

const retrieval: RetrievalPort = { fanOut, signatureMatch, failureMemory, reclassPrior };
export default retrieval;
