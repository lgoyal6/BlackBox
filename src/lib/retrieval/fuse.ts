import { RRF_K, SOURCE_WEIGHTS, type Hit, type RetrievalSource } from "@/lib/contracts";
import { toSpoken } from "./spoken";

export interface RawRow {
  docId: string;
  source: RetrievalSource;
  score: number;
  title: string;
  text: string;
  displayId: string | null;
  meta: Record<string, unknown>;
}

export function assignRanks(rows: RawRow[]): (RawRow & { rank: number })[] {
  const grouped = new Map<RetrievalSource, RawRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.source) ?? [];
    list.push(row);
    grouped.set(row.source, list);
  }
  const out: (RawRow & { rank: number })[] = [];
  for (const list of grouped.values()) {
    const sorted = [...list].sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
    sorted.forEach((row, index) => out.push({ ...row, rank: index + 1 }));
  }
  return out;
}

export function fuse(rows: RawRow[], limit: number): Hit[] {
  const ranked = assignRanks(rows);
  const withRrf = ranked.map((row) => ({
    ...row,
    rrf: SOURCE_WEIGHTS[row.source] / (RRF_K + row.rank),
  }));
  withRrf.sort(
    (a, b) => b.rrf - a.rrf || b.score - a.score || a.docId.localeCompare(b.docId),
  );
  return withRrf.slice(0, limit).map((row) => ({
    source: row.source,
    docId: row.docId,
    score: row.score,
    rank: row.rank,
    rrf: row.rrf,
    title: row.title,
    text: row.text,
    spoken: toSpoken(row.text),
    displayId: row.displayId,
    meta: row.meta,
  }));
}
