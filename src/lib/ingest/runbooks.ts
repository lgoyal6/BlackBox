import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractText } from "unpdf";
import {
  RUNBOOK_CHAPTER_FILTER,
  RUNBOOKS,
  type RunbookDoc,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { embeddings } from "@/lib/registry";

export const PDF_URL =
  "https://ems.utah.gov/wp-content/uploads/sites/34/2024/05/National-Model-EMS-Clinical-Guidelines_2022.pdf";
export const PDF_PATH = "data/nasemso-2022.pdf";
export const PAGES_CACHE_PATH = "data/nasemso-pages.json";
export const CHUNKS_CACHE_PATH = "data/nasemso-chunks.json";
export const PDF_BYTES = 5_040_475;
export const SOURCE = "NASEMSO-2022-v3" as const;

export const MAX_CHUNK_CHARS = 1600;
export const OVERLAP_CHARS = 200;
export const MIN_EXPECTED_CHUNKS = 50;
export const MAX_EXPECTED_CHUNKS = 3000;
/** Below this many filter matches, section detection has not isolated the chapters. See contracts §14. */
export const CHAPTER_FILTER_MIN_SECTIONS = 15;

export const ANCHOR_HEADINGS: readonly string[] = [
  "Clinical Guideline",
  "Patient Care Goals",
];

export const SUBSECTION_HEADINGS: readonly string[] = [
  "Clinical Guideline",
  "Patient Care Goals",
  "Patient Presentation",
  "Inclusion Criteria",
  "Exclusion Criteria",
  "Patient Management",
  "Assessment",
  "Treatment and Interventions",
  "Patient Safety Considerations",
  "Notes",
  "Educational Pearls",
  "References",
];

const WRITE_BATCH = 200;
const DOCUMENT_TITLE_RE = /national model|clinical guidelines/i;
const FIELD_TRIAGE_RE = /field triage/i;
const REFERENCES_TITLE_RE = /^references?$/i;
const ACKNOWLEDGE_RE = /acknowledg/i;
const CLEAN_OPENING_RE = /^[A-Z0-9\u2022\u2023\u25E6\u2043\u2219*\-–—]/;
const CHAPTER_HEADER_RE = /^(.+?)\s+Rev\.\s+/i;
const SKIP_TITLE_RE = /^(aliases?|none|none noted|contents|introduction|purpose and notes|target audience)$/i;

export interface Page {
  pageNumber: number;
  text: string;
}

export interface StripResult {
  pages: Page[];
  /** Lines removed as running headers/footers, kept for chapter attribution. */
  headerByPage: Map<number, string[]>;
  boilerplate: string[];
}

export interface Section {
  title: string;
  chapter: string;
  pageStart: number;
  pageEnd: number;
  /** Ordered subsections; a guideline with no detected subsections has one entry titled "". */
  parts: { heading: string; text: string; pageStart: number; pageEnd: number }[];
}

export type UnembeddedChunk = Omit<RunbookDoc, "embedding">;

interface TaggedLine {
  page: number;
  text: string;
}

interface IngestOpts {
  dryRun?: boolean;
  forceExtract?: boolean;
  section?: string;
  sample?: number;
  onProgress?: (stage: string, detail: string) => void;
}

let lastSectionCount = 0;

function abs(rel: string): string {
  return resolve(process.cwd(), rel);
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeHeading(line: string): string {
  return normalizeLine(line).replace(/:+$/, "");
}

function headingEquals(line: string, heading: string): boolean {
  return normalizeHeading(line) === normalizeHeading(heading);
}

function isListedHeading(line: string, headings: readonly string[]): boolean {
  return headings.some((heading) => headingEquals(line, heading));
}

function alphabeticCount(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

export function isPageNumberOnly(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^(?:page\s*)?[\s.\-–—]*\d{1,4}[\s.\-–—]*$/i.test(trimmed);
}

function chapterFromHeader(line: string): string | null {
  const match = line.trim().match(CHAPTER_HEADER_RE);
  if (!match?.[1]) return null;
  const name = match[1].trim();
  if (DOCUMENT_TITLE_RE.test(name)) return null;
  if (name.length < 3 || name.length > 60) return null;
  return name;
}

function isTitlePageHeader(line: string, pageNumber: number): boolean {
  const trimmed = line.trim();
  return new RegExp(`\\s+${pageNumber}\\s*$`).test(trimmed) && alphabeticCount(trimmed) >= 3;
}

function stripTrailingPageNumber(line: string): string {
  return line.trim().replace(/\s+\d{1,3}\s*$/, "").trim();
}

export function dehyphenate(text: string): string {
  return text.replace(/-\r?\n(?=[a-z])/g, "");
}

export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function mergeOrphanListMarkers(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (/^\d{1,2}\.$/.test(trimmed)) {
      let next = i + 1;
      while (next < lines.length && !(lines[next] ?? "").trim()) next += 1;
      const following = lines[next];
      if (following !== undefined && following.trim()) {
        out.push(`${trimmed} ${following.trim()}`);
        i = next;
        continue;
      }
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

export function buildEmbeddedText(chunk: Omit<UnembeddedChunk, "embeddedText">): string {
  return `${chunk.sectionPath.join(" > ")}\n${chunk.text}`;
}

export function assertChunkCountSane(n: number, sectionCount = lastSectionCount): void {
  if (n >= MIN_EXPECTED_CHUNKS && n <= MAX_EXPECTED_CHUNKS) return;
  const hint =
    n < MIN_EXPECTED_CHUNKS
      ? "Anchor detection is likely not matching — the corpus is a handful of enormous blobs."
      : "Every line is likely being treated as a boundary.";
  throw new Error(
    `chunk count ${n} is outside [${MIN_EXPECTED_CHUNKS}, ${MAX_EXPECTED_CHUNKS}] ` +
      `(sections=${sectionCount}). ${hint}`,
  );
}

export async function ensurePdf(opts?: { url?: string; path?: string }): Promise<{
  path: string;
  bytes: number;
  downloaded: boolean;
}> {
  const url = opts?.url ?? PDF_URL;
  const path = abs(opts?.path ?? PDF_PATH);
  await mkdir(dirname(path), { recursive: true });

  try {
    const existing = await stat(path);
    if (existing.size === PDF_BYTES) {
      return { path, bytes: existing.size, downloaded: false };
    }
  } catch {
    // missing — download below
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; BlackBox/0.1; +https://github.com/mongodb-local/blackbox)",
      Accept: "application/pdf,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`PDF download failed: HTTP ${response.status} from ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== PDF_BYTES) {
    console.warn(
      `PDF byte count ${bytes.length} differs from expected ${PDF_BYTES}. ` +
        "Page numbers in the corpus may have shifted.",
    );
  }
  await writeFile(path, bytes);
  return { path, bytes: bytes.length, downloaded: true };
}

export async function extractPages(opts?: { path?: string; force?: boolean }): Promise<Page[]> {
  const pdfPath = abs(opts?.path ?? PDF_PATH);
  const cachePath = abs(PAGES_CACHE_PATH);

  if (!opts?.force) {
    try {
      const raw = await readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw) as Page[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.pageNumber === 1) {
        return parsed;
      }
    } catch {
      // cache miss
    }
  }

  const buffer = await readFile(pdfPath);
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: false });
  const pages = text.map((pageText, index) => ({
    pageNumber: index + 1,
    text: pageText ?? "",
  }));
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(pages), "utf8");
  return pages;
}

export function stripBoilerplate(pages: Page[], opts?: { threshold?: number }): StripResult {
  const threshold = opts?.threshold ?? 0.2;
  const pageCount = Math.max(pages.length, 1);
  const pagesByNorm = new Map<string, Set<number>>();
  const originalByNorm = new Map<string, string>();

  for (const page of pages) {
    const seen = new Set<string>();
    for (const line of page.text.split(/\r?\n/)) {
      const norm = normalizeLine(line);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      let set = pagesByNorm.get(norm);
      if (!set) {
        set = new Set();
        pagesByNorm.set(norm, set);
        originalByNorm.set(norm, line.trim());
      }
      set.add(page.pageNumber);
    }
  }

  const boilerplateNorms = new Set<string>();
  const boilerplate: string[] = [];
  for (const [norm, seenOn] of pagesByNorm) {
    if (seenOn.size / pageCount > threshold) {
      boilerplateNorms.add(norm);
      boilerplate.push(originalByNorm.get(norm) ?? norm);
    }
  }

  const headerByPage = new Map<number, string[]>();
  const cleaned = pages.map((page) => {
    const headers: string[] = [];
    const kept: string[] = [];
    for (const line of page.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      const norm = normalizeLine(line);
      if (norm && boilerplateNorms.has(norm)) {
        headers.push(trimmed);
        continue;
      }
      if (chapterFromHeader(trimmed) || isTitlePageHeader(trimmed, page.pageNumber)) {
        headers.push(trimmed);
        continue;
      }
      if (isPageNumberOnly(line)) continue;
      kept.push(line);
    }
    headerByPage.set(page.pageNumber, headers);
    const text = collapseBlankLines(mergeOrphanListMarkers(dehyphenate(kept.join("\n"))));
    return { pageNumber: page.pageNumber, text };
  });

  return { pages: cleaned, headerByPage, boilerplate };
}

const MONTH_PREFIX_RE =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\s*/i;

function stripDatePrefix(line: string): string {
  return line.replace(MONTH_PREFIX_RE, "").trim();
}

function dedupeRepeatedTitle(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const half = Math.floor(words.length / 2);
  if (half > 0 && words.slice(0, half).join(" ") === words.slice(half).join(" ")) {
    return words.slice(0, half).join(" ");
  }
  return title;
}

function isGuidelineTitle(line: string, opts?: { fieldTriage?: boolean }): boolean {
  const trimmed = stripDatePrefix(stripTrailingPageNumber(line));
  if (!trimmed) return false;
  if (/\.{3,}|_{3,}/.test(trimmed)) return false;
  if (SKIP_TITLE_RE.test(trimmed)) return false;
  if (/^[a-z]/.test(trimmed)) return false;
  if (/^\d+\.\s/.test(trimmed)) return false;
  if (MONTH_PREFIX_RE.test(trimmed)) return false;
  if (/model process/i.test(trimmed)) return false;
  if (/documentation guideline/i.test(trimmed)) return false;
  if ((trimmed.match(/®/g) ?? []).length >= 2) return false;
  if (trimmed.endsWith(".") || trimmed.endsWith(",")) return false;
  if (/, we | should | include[sd]?\b|when transporting/i.test(trimmed)) return false;
  if (isListedHeading(trimmed, ANCHOR_HEADINGS) || isListedHeading(trimmed, SUBSECTION_HEADINGS)) {
    return false;
  }
  if (opts?.fieldTriage || FIELD_TRIAGE_RE.test(trimmed)) {
    return trimmed.length <= 160 && alphabeticCount(trimmed) >= 3;
  }
  if (trimmed.length > 80) return false;
  if (alphabeticCount(trimmed) < 3) return false;
  return true;
}

function chapterFor(headerByPage: Map<number, string[]>, page: number): string {
  const nearby = [page, page - 1, page + 1, page - 2, page + 2];
  const counts = new Map<string, number>();
  for (const p of nearby) {
    for (const header of headerByPage.get(p) ?? []) {
      const key = chapterFromHeader(header);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best || "Guidelines";
}

function chapterNamesFrom(headerByPage: Map<number, string[]>): Set<string> {
  const names = new Set<string>();
  for (const headers of headerByPage.values()) {
    for (const header of headers) {
      const name = chapterFromHeader(header);
      if (name) names.add(name.toLowerCase());
    }
  }
  return names;
}

function flattenPages(pages: Page[]): TaggedLine[] {
  const lines: TaggedLine[] = [];
  for (const page of pages) {
    for (const text of page.text.split(/\r?\n/)) {
      lines.push({ page: page.pageNumber, text });
    }
  }
  return lines;
}

function matchSubsectionHeading(line: string): string | null {
  const trimmed = line.trim().replace(/:+$/, "");
  if (!trimmed) return null;
  if (/^notes\s*\/\s*educational pearls$/i.test(trimmed)) return "Notes";
  if (/^assessment,\s*treatment/i.test(trimmed)) return "Assessment";
  for (const heading of SUBSECTION_HEADINGS) {
    if (headingEquals(trimmed, heading)) return heading;
  }
  return null;
}

function findTitleBefore(
  lines: TaggedLine[],
  anchorIndex: number,
  chapterNames: Set<string>,
): { index: number; title: string; page: number } | null {
  let start = anchorIndex;
  for (let back = 1; back <= 16; back += 1) {
    const line = lines[anchorIndex - back];
    if (!line) break;
    if (/^aliases?$/i.test(line.text.trim())) {
      start = anchorIndex - back;
      break;
    }
  }

  let i = start - 1;
  let inspected = 0;
  while (i >= 0 && inspected < 8) {
    const line = lines[i];
    if (!line) break;
    const trimmed = line.text.trim();
    if (!trimmed) {
      i -= 1;
      inspected += 1;
      continue;
    }
    if (SKIP_TITLE_RE.test(trimmed) || chapterNames.has(trimmed.toLowerCase())) {
      i -= 1;
      inspected += 1;
      continue;
    }
    if (!isGuidelineTitle(trimmed)) {
      i -= 1;
      inspected += 1;
      continue;
    }

    let title = dedupeRepeatedTitle(stripDatePrefix(stripTrailingPageNumber(trimmed)));
    let index = i;
    let page = line.page;
    const previous = lines[i - 1];
    if (previous) {
      const prevText = stripDatePrefix(stripTrailingPageNumber(previous.text));
      const continuation = /^[a-z(]/.test(line.text.trim()) || trimmed.length < 28;
      if (
        continuation &&
        isGuidelineTitle(prevText) &&
        !chapterNames.has(prevText.toLowerCase()) &&
        !SKIP_TITLE_RE.test(prevText)
      ) {
        title = dedupeRepeatedTitle(`${prevText} ${title}`.replace(/\s+/g, " ").trim());
        index = i - 1;
        page = previous.page;
      }
    }
    return { index, title, page };
  }
  return null;
}

function skipSectionTitle(title: string): boolean {
  const trimmed = title.trim();
  if (FIELD_TRIAGE_RE.test(trimmed)) return false;
  return (
    REFERENCES_TITLE_RE.test(trimmed) ||
    ACKNOWLEDGE_RE.test(trimmed) ||
    /documentation guideline/i.test(trimmed) ||
    /model process/i.test(trimmed) ||
    /national association of state/i.test(trimmed)
  );
}

function isAliasOnlyPart(part: Section["parts"][number], title: string): boolean {
  if (part.heading) return false;
  const stripped = part.text
    .replace(title, "")
    .replace(/aliases?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length < 120;
}

function splitParts(lines: TaggedLine[], title: string): Section["parts"] {
  const parts: { heading: string; lines: TaggedLine[] }[] = [{ heading: "", lines: [] }];

  for (const line of lines) {
    const heading = matchSubsectionHeading(line.text);
    if (heading) {
      if (REFERENCES_TITLE_RE.test(heading)) break;
      parts.push({ heading, lines: [line] });
      continue;
    }
    parts[parts.length - 1]?.lines.push(line);
  }

  const usable = parts.filter((part) => part.lines.some((line) => line.text.trim()));
  const normalized = usable.length > 0 ? usable : [{ heading: "", lines }];

  return normalized
    .map((part) => {
      const text = collapseBlankLines(
        mergeOrphanListMarkers(part.lines.map((line) => line.text).join("\n")),
      ).trim();
      const pages = part.lines.map((line) => line.page);
      return {
        heading: part.heading,
        text,
        pageStart: pages[0] ?? 1,
        pageEnd: pages[pages.length - 1] ?? pages[0] ?? 1,
      };
    })
    .filter((part) => !isAliasOnlyPart(part, title) && part.text.length > 0);
}

export function detectSections(stripped: StripResult): Section[] {
  const lines = flattenPages(stripped.pages);
  const chapterNames = chapterNamesFrom(stripped.headerByPage);
  const starts: { index: number; title: string; page: number }[] = [];

  const pushStart = (index: number, title: string, page: number): void => {
    const last = starts[starts.length - 1];
    if (last && last.title === title && index - last.index < 40) return;
    if (starts.some((start) => start.index === index)) return;
    starts.push({ index, title, page });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !isListedHeading(line.text, ANCHOR_HEADINGS)) continue;
    const found = findTitleBefore(lines, i, chapterNames);
    if (!found) continue;
    pushStart(found.index, found.title, found.page);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.page < 400) continue;
    if (!FIELD_TRIAGE_RE.test(line.text)) continue;
    if (!isGuidelineTitle(line.text, { fieldTriage: true })) continue;
    pushStart(i, stripTrailingPageNumber(line.text), line.page);
  }

  starts.sort((a, b) => a.index - b.index);

  const sections: Section[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    if (!start || skipSectionTitle(start.title)) continue;
    const end = starts[i + 1]?.index ?? lines.length;
    const sectionLines = lines.slice(start.index, end);
    const parts = splitParts(sectionLines, start.title);
    if (parts.length === 0) continue;
    const pageEnd = sectionLines[sectionLines.length - 1]?.page ?? start.page;
    sections.push({
      title: start.title,
      chapter: chapterFor(stripped.headerByPage, start.page),
      pageStart: start.page,
      pageEnd,
      parts,
    });
  }

  lastSectionCount = sections.length;
  return sections;
}

export function filterChapters(
  sections: Section[],
): { sections: Section[]; matched: number; fellBack: boolean } {
  const matchedSections = sections.filter((section) =>
    RUNBOOK_CHAPTER_FILTER.some((needle) => {
      const n = needle.toLowerCase();
      return section.chapter.toLowerCase().includes(n) || section.title.toLowerCase().includes(n);
    }),
  );
  if (matchedSections.length < CHAPTER_FILTER_MIN_SECTIONS) {
    return { sections, matched: matchedSections.length, fellBack: true };
  }
  return { sections: matchedSections, matched: matchedSections.length, fellBack: false };
}

function lastSentenceBreak(window: string): number {
  let best = -1;
  for (let i = 0; i < window.length - 1; i += 1) {
    if (!".!?".includes(window[i] ?? "")) continue;
    if (!/\s/.test(window[i + 1] ?? "")) continue;
    let j = i + 1;
    while (j < window.length && /\s/.test(window[j] ?? "")) j += 1;
    if (j < window.length) best = j;
  }
  return best;
}

function lastWhitespaceBreak(window: string): number {
  const idx = window.lastIndexOf(" ");
  return idx;
}

function nextCleanStart(text: string, from: number): number {
  const slice = text.slice(from, from + 280);
  if (CLEAN_OPENING_RE.test(slice) || /^\d+\./.test(slice)) return from;
  const sentence = /(?:[.!?]\s+|\n+)(?=[A-Z0-9\u2022\u2023\u25E6*\-–—])/.exec(slice);
  if (sentence?.index !== undefined) {
    return from + sentence.index + (sentence[0] ?? "").length;
  }
  const word = /\s+(?=[A-Z0-9\u2022\u2023\u25E6*\-–—])/.exec(slice);
  if (word?.index !== undefined) {
    return from + word.index + (word[0] ?? "").length;
  }
  return from;
}

function ensureCleanOpening(text: string): string {
  const trimmed = text.trim();
  if (CLEAN_OPENING_RE.test(trimmed) || /^\d+\./.test(trimmed)) return trimmed;
  const sentence = /(?:[.!?]\s+|\n+)(?=[A-Z0-9\u2022\u2023\u25E6*\-–—])/.exec(trimmed);
  if (sentence?.index !== undefined && sentence.index < trimmed.length * 0.5) {
    return trimmed.slice(sentence.index + (sentence[0] ?? "").length).trim();
  }
  const word = /\s+(?=[A-Z0-9\u2022\u2023\u25E6*\-–—])/.exec(trimmed);
  if (word?.index !== undefined && word.index < 100) {
    return trimmed.slice(word.index + (word[0] ?? "").length).trim();
  }
  return trimmed;
}

function splitWindows(text: string, maxChars: number, overlapChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed ? [trimmed] : [];

  const out: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    let end = Math.min(start + maxChars, trimmed.length);
    if (end < trimmed.length) {
      const window = trimmed.slice(start, end);
      const sentenceAt = lastSentenceBreak(window);
      if (sentenceAt >= Math.floor(window.length * 0.25)) {
        end = start + sentenceAt;
      } else {
        const ws = lastWhitespaceBreak(window);
        if (ws > 0) end = start + ws;
      }
    }
    const raw = trimmed.slice(start, end);
    const orphan = raw.match(/\n(\d{1,2}\.)\s*$/);
    if (orphan?.index !== undefined && end < trimmed.length) {
      end = start + orphan.index;
    }
    const piece = trimmed.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= trimmed.length) break;
    let next = Math.max(start + 1, end - overlapChars);
    next = nextCleanStart(trimmed, next);
    if (next <= start) next = end;
    start = next;
  }
  return out;
}

function makeChunk(
  section: Section,
  path: string[],
  text: string,
  pageStart: number,
  pageEnd: number,
  chunkIndex: number,
): UnembeddedChunk {
  const clean = ensureCleanOpening(collapseBlankLines(mergeOrphanListMarkers(text)));
  const base = {
    source: SOURCE,
    sectionTitle: section.title,
    sectionPath: path,
    text: clean,
    pageStart,
    pageEnd,
    chunkIndex,
  };
  return { ...base, embeddedText: buildEmbeddedText(base) };
}

function wholeGuidelineText(section: Section): string {
  return collapseBlankLines(section.parts.map((part) => part.text).join("\n\n")).trim();
}

function packParts(
  parts: Section["parts"],
  maxChars: number,
): { heading: string; text: string; pageStart: number; pageEnd: number; single: boolean }[] {
  const groups: {
    heading: string;
    texts: string[];
    pageStart: number;
    pageEnd: number;
    count: number;
  }[] = [];

  for (const part of parts) {
    const text = part.text.trim();
    if (!text) continue;
    const last = groups[groups.length - 1];
    if (last && `${last.texts.join("\n\n")}\n\n${text}`.length <= maxChars) {
      last.texts.push(text);
      last.pageEnd = part.pageEnd;
      last.count += 1;
      continue;
    }
    groups.push({
      heading: part.heading,
      texts: [text],
      pageStart: part.pageStart,
      pageEnd: part.pageEnd,
      count: 1,
    });
  }

  return groups.map((group) => ({
    heading: group.count === 1 ? group.heading : "",
    text: group.texts.join("\n\n"),
    pageStart: group.pageStart,
    pageEnd: group.pageEnd,
    single: group.count === 1,
  }));
}

export function chunkSection(
  section: Section,
  opts?: { maxChars?: number; overlapChars?: number },
): UnembeddedChunk[] {
  const maxChars = opts?.maxChars ?? MAX_CHUNK_CHARS;
  const overlapChars = opts?.overlapChars ?? OVERLAP_CHARS;
  const whole = wholeGuidelineText(section);
  if (whole.length <= maxChars) {
    return [
      makeChunk(section, [section.chapter, section.title], whole, section.pageStart, section.pageEnd, 0),
    ];
  }

  const chunks: UnembeddedChunk[] = [];
  let index = 0;
  const path = [section.chapter, section.title];
  for (const group of packParts(section.parts, maxChars)) {
    if (group.text.length <= maxChars) {
      chunks.push(makeChunk(section, path, group.text, group.pageStart, group.pageEnd, index));
      index += 1;
      continue;
    }
    for (const window of splitWindows(group.text, maxChars, overlapChars)) {
      chunks.push(makeChunk(section, path, window, group.pageStart, group.pageEnd, index));
      index += 1;
    }
  }
  return chunks;
}

function printSample(chunks: UnembeddedChunk[], n: number, log: (detail: string) => void): void {
  if (n <= 0 || chunks.length === 0) return;
  const count = Math.min(n, chunks.length);
  const step = Math.max(1, Math.floor(chunks.length / count));
  for (let i = 0; i < count; i += 1) {
    const chunk = chunks[Math.min(i * step, chunks.length - 1)];
    if (!chunk) continue;
    log(
      `sample ${i + 1}/${count} [${chunk.sectionPath.join(" > ")} p.${chunk.pageStart}–${chunk.pageEnd}]\n` +
        chunk.text.slice(0, 300),
    );
  }
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export async function ingestRunbooks(opts?: IngestOpts): Promise<{
  pages: number;
  sections: number;
  chunks: number;
  inserted: number;
}> {
  const log = (stage: string, detail: string): void => {
    opts?.onProgress?.(stage, detail);
  };

  const pdf = await ensurePdf();
  log(
    "pdf",
    `${pdf.path} (${pdf.bytes} bytes) ${pdf.downloaded ? "downloaded" : "reused cached file"}`,
  );

  const cachePath = abs(PAGES_CACHE_PATH);
  let cacheExisted = false;
  try {
    await stat(cachePath);
    cacheExisted = true;
  } catch {
    cacheExisted = false;
  }
  const pages = await extractPages({ force: opts?.forceExtract });
  const usedCache = Boolean(cacheExisted && !opts?.forceExtract);
  log("extract", `${pages.length} pages, cache ${usedCache ? "reused" : "written"}`);

  const stripped = stripBoilerplate(pages);
  log(
    "hygiene",
    `${stripped.boilerplate.length} boilerplate lines removed: ${stripped.boilerplate.join(" | ")}`,
  );

  const detected = detectSections(stripped);
  lastSectionCount = detected.length;
  const previewTitles = detected.slice(0, 10).map((section) => section.title);
  log("sections", `${detected.length} sections. First ten: ${previewTitles.join("; ")}`);

  const unfilteredChunks = detected.flatMap((section) => chunkSection(section));
  assertChunkCountSane(unfilteredChunks.length, detected.length);
  log("chunks", `${unfilteredChunks.length} unfiltered chunks (sanity gate passed)`);

  const filtered = filterChapters(detected);
  if (filtered.fellBack) {
    log(
      "filter",
      `RUNBOOK_CHAPTER_FILTER matched ${filtered.matched} sections (< ${CHAPTER_FILTER_MIN_SECTIONS}); ` +
        "falling back to every detected section",
    );
  } else {
    log(
      "filter",
      `RUNBOOK_CHAPTER_FILTER matched ${filtered.matched} sections; using the filtered set`,
    );
  }

  let corpusSections = filtered.sections;
  if (opts?.section) {
    const needle = opts.section.toLowerCase();
    corpusSections = corpusSections.filter((section) => section.title.toLowerCase().includes(needle));
    log("section", `restricted to titles matching ${JSON.stringify(opts.section)} → ${corpusSections.length}`);
  }

  const chunks = corpusSections.flatMap((section) => chunkSection(section));
  const lens = chunks.map((chunk) => chunk.text.length).sort((a, b) => a - b);
  const over = chunks.filter((chunk) => chunk.text.length > MAX_CHUNK_CHARS).length;
  const whole = chunks.filter((chunk) => chunk.sectionPath.length === 2).length;
  const clean = chunks.filter((chunk) => CLEAN_OPENING_RE.test(chunk.text.trim())).length;
  log(
    "stats",
    `writing ${chunks.length} chunks (unfiltered ${unfilteredChunks.length}) ` +
      `min=${lens[0] ?? 0} median=${median(lens)} max=${lens[lens.length - 1] ?? 0} ` +
      `overBudget=${over} wholeGuideline=${whole} (${pct(whole, chunks.length)}) ` +
      `cleanOpenings=${clean} (${pct(clean, chunks.length)})`,
  );
  if (over > 0) {
    throw new Error(`${over} chunks exceed MAX_CHUNK_CHARS=${MAX_CHUNK_CHARS}`);
  }

  if (opts?.sample) {
    printSample(chunks, opts.sample, (detail) => log("sample", detail));
  }

  if (opts?.dryRun) {
    const out = abs(CHUNKS_CACHE_PATH);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(chunks, null, 2), "utf8");
    log("dry-run", `wrote ${chunks.length} chunks to ${out}; no embedding, no database`);
    return { pages: pages.length, sections: detected.length, chunks: chunks.length, inserted: 0 };
  }

  const port = await embeddings();
  const collection = col<RunbookDoc>(RUNBOOKS);
  await collection.deleteMany({ source: SOURCE });
  log("write", `deleted existing documents with source=${SOURCE}`);

  let inserted = 0;
  for (let i = 0; i < chunks.length; i += WRITE_BATCH) {
    const batch = chunks.slice(i, i + WRITE_BATCH);
    const vectors = await port.embed(
      batch.map((chunk) => chunk.embeddedText),
      "document",
    );
    if (vectors.length !== batch.length) {
      throw new Error(`embed returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    const docs: RunbookDoc[] = batch.map((chunk, index) => ({
      ...chunk,
      embedding: vectors[index] ?? [],
    }));
    if (docs.length > 0) {
      await collection.insertMany(docs, { ordered: false });
    }
    inserted += docs.length;
    log(
      "write",
      `batch ${Math.floor(i / WRITE_BATCH) + 1} inserted ${docs.length} (${inserted}/${chunks.length})`,
    );
  }

  log("done", `inserted ${inserted} documents source=${SOURCE}`);
  return { pages: pages.length, sections: detected.length, chunks: chunks.length, inserted };
}

function pct(part: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}
