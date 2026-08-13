# Phase 05 — NASEMSO Runbook Corpus

**Status:** PENDING
**Tasks:** US-009
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 25 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Download the NASEMSO National Model EMS Clinical Guidelines (2022, v3) from the Utah mirror, split it into clinically coherent chunks that carry page numbers and a breadcrumb path, embed them, and write them to `runbooks`. These chunks get read aloud by a TTS voice during the demo, so chunk boundaries are a user-facing decision rather than an implementation detail.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §5 — `RunbookDoc`. Every field is required, including `pageStart`, `pageEnd`, `chunkIndex`, and `embeddedText`.
- `.ralph/contracts.md` §14 — `RUNBOOK_CHAPTER_FILTER`, the frozen demo-scale chapter list and its documented fallback. Import it; do not restate the chapter names here.
- `.ralph/contracts.md` §9 — `EmbeddingsPort`, the only port this phase consumes.
- `.ralph/contracts.md` §13 — every vector write sets both `embedding` and `embeddedText`.
- `.ralph/overview.md` — "Runbook corpus — NASEMSO", the 403 on the nasemso.org URL, the Utah mirror and its byte count, and the Scope Guardrail, which is why attribution matters.
- `fixtures/runbook-chunks.json` — PHASE-01 ships four `RunbookDoc` objects without embeddings. Use them to check the output shape and the write path before the chunker produces anything.
- `.ralph/specs/phase-02-collections-and-indexes.md` — PHASE-02 creates `runbooks`, its `sectionTitle` index, and `vs_runbooks`. This phase creates none of those and must run whether or not PHASE-02 has finished.

## Parallel-Safe Contract

### Files this phase owns

Exactly two, from the ownership table in `overview.md`:

- `src/lib/ingest/runbooks.ts`
- `scripts/ingest-runbooks.ts`

`package.json` already has `"ingest:runbooks": "tsx scripts/ingest-runbooks.ts"` from PHASE-01, and `next.config.ts` already lists `unpdf` in `serverExternalPackages`. Neither needs editing, and neither may be edited here.

This phase writes three artifacts under gitignored `data/`, all prefixed `nasemso-` so they cannot collide with PHASE-04's files: `data/nasemso-2022.pdf`, `data/nasemso-pages.json`, and optionally `data/nasemso-chunks.json` from a dry run.

### Ports consumed

`EmbeddingsPort` only, resolved through `src/lib/registry.ts`. Never import `@/lib/embeddings` directly — that is PHASE-03's module and importing it defeats the whole arrangement.

Build and verify everything with:

```
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake MEMORY_MODE=fake LLM_MODE=fake EVENTS_MODE=fake GRAPH_MODE=fake VOICE_MODE=fake
```

`EMBEDDINGS_MODE=fake` is what makes this phase genuinely independent of PHASE-03. The fake returns a deterministic unit vector of exactly `env.embeddingDim` floats with no network call and no API key, so the download, the extraction, the chunker, the sanity gate, and the write path are all fully verifiable before an embeddings provider exists. That is also the cheap way to iterate: the chunker will get rewritten three or four times, and re-embedding several hundred chunks on each attempt is wasted API spend and wasted minutes. Switch to `EMBEDDINGS_MODE=real` once, at the end, when the chunk statistics look right.

Note the one consequence to remember: chunks written with the fake are semantically meaningless, so a corpus embedded with the fake must be re-ingested with `real` before any retrieval work is believable. Because the script deletes and re-inserts by `source`, that is a single re-run rather than a cleanup.

### Ports implemented

None. Nothing here is default-exported or resolved through the registry. The deliverable is documents in the `runbooks` collection.

## Files to Create

### `src/lib/ingest/runbooks.ts`

Download, extraction, hygiene, section detection, chunking, and the write. Every step is a separately exported function so the chunker can be iterated on without re-downloading or re-extracting.

```ts
import type { RunbookDoc } from "@/lib/contracts";

export const PDF_URL =
  "https://ems.utah.gov/wp-content/uploads/sites/34/2024/05/National-Model-EMS-Clinical-Guidelines_2022.pdf";
export const PDF_PATH = "data/nasemso-2022.pdf";
export const PAGES_CACHE_PATH = "data/nasemso-pages.json";
export const PDF_BYTES = 5_040_475;
export const SOURCE = "NASEMSO-2022-v3" as const;

export const MAX_CHUNK_CHARS = 1600;
export const OVERLAP_CHARS = 200;
export const MIN_EXPECTED_CHUNKS = 50;
export const MAX_EXPECTED_CHUNKS = 3000;
/** Below this many filter matches, section detection has not isolated the chapters. See contracts §14. */
export const CHAPTER_FILTER_MIN_SECTIONS = 15;

export const ANCHOR_HEADINGS: readonly string[];      // starts a guideline
export const SUBSECTION_HEADINGS: readonly string[];  // splits within a guideline

export interface Page { pageNumber: number; text: string }

export async function ensurePdf(opts?: { url?: string; path?: string }):
  Promise<{ path: string; bytes: number; downloaded: boolean }>;

/** Per-page extraction. Uses the pages cache unless force is set. */
export async function extractPages(opts?: { path?: string; force?: boolean }): Promise<Page[]>;

export interface StripResult {
  pages: Page[];
  /** Lines removed as running headers/footers, kept for chapter attribution. */
  headerByPage: Map<number, string[]>;
  boilerplate: string[];
}
export function stripBoilerplate(pages: Page[], opts?: { threshold?: number }): StripResult;

export interface Section {
  title: string;
  chapter: string;
  pageStart: number;
  pageEnd: number;
  /** Ordered subsections; a guideline with no detected subsections has one entry titled "". */
  parts: { heading: string; text: string; pageStart: number; pageEnd: number }[];
}
export function detectSections(stripped: StripResult): Section[];

export type UnembeddedChunk = Omit<RunbookDoc, "embedding">;
export function chunkSection(
  section: Section,
  opts?: { maxChars?: number; overlapChars?: number },
): UnembeddedChunk[];

/** Narrows to contracts §14's chapter list, falling back to all sections. Reports which happened. */
export function filterChapters(
  sections: Section[],
): { sections: Section[]; matched: number; fellBack: boolean };

export function dehyphenate(text: string): string;
export function collapseBlankLines(text: string): string;
export function isPageNumberOnly(line: string): boolean;
export function buildEmbeddedText(chunk: Omit<UnembeddedChunk, "embeddedText">): string;

/** Throws before any embedding call when detection has clearly failed. */
export function assertChunkCountSane(n: number): void;

export async function ingestRunbooks(opts?: {
  dryRun?: boolean;
  onProgress?: (stage: string, detail: string) => void;
}): Promise<{ pages: number; sections: number; chunks: number; inserted: number }>;
```

#### Downloading

**Do not use the nasemso.org URL.** `https://nasemso.org/wp-content/uploads/National-Model-EMS-Clinical-Guidelines_2022.pdf` returns HTTP 403 even with a browser `User-Agent`; the origin blocks non-browser clients outright. This was verified live, and defeating a WAF is not a thing to spend hackathon minutes on.

The Utah mirror serves the identical document: 200, `application/pdf`, **5,040,475 bytes**.

`ensurePdf` checks whether `data/nasemso-2022.pdf` already exists with a size of exactly `PDF_BYTES` and skips the download when it does. Compare the byte count on download too, and warn (do not throw) if it differs — a mirror can be updated, and a warning is the right signal that the page numbers in the corpus may have shifted. Create `data/` if it is missing.

#### Extraction

Use `unpdf`, extracting **per page** so that page numbers travel with the text from the very beginning. Retrofitting page attribution after chunking means reverse-mapping character offsets back through the hygiene pass, which is fiddly and gets subtly wrong at page boundaries — exactly the chunks whose attribution someone will check.

`unpdf` exposes a document proxy and an `extractText` call that can return per-page text rather than one merged string; that per-page form is what this phase needs. If the installed version's return shape differs from what you expect, read its types rather than guessing, and keep the `Page[]` interface above as the boundary so nothing downstream cares.

**Cache the extracted pages to `data/nasemso-pages.json`.** Extraction of a five-megabyte clinical PDF takes tens of seconds, and the chunker is the part that gets rewritten repeatedly. Caching turns a thirty-second edit-test loop into a one-second one, which over four iterations of the chunker is most of this phase's budget. `--force-extract` bypasses the cache.

#### Text hygiene

Run in this order, and the order matters:

1. **Remove running headers and footers.** Collect every line's normalized text across all pages, count how many distinct pages each appears on, and drop lines appearing on more than 20 percent of pages. This catches the recurring document title and any footer band. Record what was removed in `boilerplate` and print it — seeing the removed list is the fastest way to confirm the threshold is behaving.
2. **Keep the removed header lines per page in `headerByPage`** before discarding them, because they are the cheapest available source of chapter attribution.
3. **Remove page-number-only lines.** `isPageNumberOnly` matches a line whose trimmed content is only digits, or digits with surrounding punctuation or a `Page` prefix. Left in, these end up mid-chunk and get read aloud as a bare number.
4. **Join words split by an end-of-line hyphen.** A line ending in `-` immediately followed by a lowercase continuation becomes one word. Left alone, `epi- nephrine` both embeds badly and is unspeakable.
5. **Collapse three or more consecutive newlines to two.** Column-based PDF extraction produces long runs of blank lines that waste chunk budget and make length heuristics meaningless.

Hygiene runs before section detection, not after, because an uncleaned running header is a short title-cased line on every page and is the single most likely thing to be misdetected as a guideline title.

#### Section detection

The corpus is already chunked by protocol, which is why it was chosen. Every guideline has the same internal skeleton: a title, then `Clinical Guideline` or `Patient Care Goals`, then `Patient Presentation` with `Inclusion Criteria` and `Exclusion Criteria`, then `Patient Management` with `Assessment` and `Treatment and Interventions`, then `Patient Safety Considerations`, then `Notes` or `Educational Pearls`, then `References`.

**Detect boundaries on those recurring heading strings, not on font size or layout metadata.** Heading text survives PDF extraction essentially intact; font and position information is inconsistent between extractors and between pages of the same document, and building on it produces a chunker that works on page 40 and fails on page 300.

`ANCHOR_HEADINGS` is the set that marks the start of a guideline: `Clinical Guideline`, `Patient Care Goals`. `SUBSECTION_HEADINGS` is the set that splits within one: `Clinical Guideline`, `Patient Care Goals`, `Patient Presentation`, `Inclusion Criteria`, `Exclusion Criteria`, `Patient Management`, `Assessment`, `Treatment and Interventions`, `Patient Safety Considerations`, `Notes`, `Educational Pearls`, `References`. Match a heading when a trimmed line equals it, case-insensitively, optionally with a trailing colon.

A guideline title is the line immediately preceding an anchor, subject to these tests: at most 80 characters, no terminal period, at least three alphabetic characters, and not itself a heading from either list. Search back up to five lines for a line satisfying those tests, because an extractor sometimes emits a stray blank or a stray fragment between the title and the anchor. Every section runs to the line before the next detected title.

`chapter` comes from the most frequent entry in `headerByPage` for the section's start page, when that entry looks like a chapter name — short, title-cased, not the document title itself. Fall back to the literal `"Guidelines"`. **Timebox chapter attribution to five minutes.** The spoken attribution the Scope Guardrail requires is "per the national model guideline for adult cardiac arrest, page 212," which needs the guideline title and the page number; the chapter only improves the breadcrumb. If detection is not working after five minutes, use `"Guidelines"` for everything and move on.

`sectionPath` is the breadcrumb: `[chapter, title]` for a chunk covering a whole guideline, and `[chapter, title, subsectionHeading]` for a chunk split out of one subsection. It exists so the agent can say what it is reading from, and that attribution is what keeps the agent on the correct side of the Scope Guardrail — it is quoting a named document rather than offering a clinical recommendation.

What to skip and what to keep:

- **Skip front matter.** Discard every page before the first detected guideline title; that is where the table of contents, foreword, and contributor lists live, and they embed as noise that surfaces as hits nobody can usefully speak.
- **Skip reference lists.** Drop any section whose title matches `/^references?$/i` or `/acknowledg/i`, and drop the `References` subsection from within every guideline body. Citation strings are dense, distinctive text, which means they retrieve well and are worthless read aloud.
- **Keep the 2022 Field Triage of Injured Patients appendix.** It comes after the last regular guideline, so a naive "stop at the last title" rule drops it. Guard for a title matching `/field triage/i` explicitly. It is directly relevant to the undertriage story that the pitch's 7.1 percent number sets up, so losing it costs a demo beat.

#### Chapter filter

`contracts.md` §14 freezes the demo corpus to the chapters this demo can actually reach: `RUNBOOK_CHAPTER_FILTER`. `filterChapters` keeps a section when any entry in that list appears, case-insensitively, in either its `chapter` or its `title` — matching on the title as well is what catches `Field Triage` and the cardiac guidelines when chapter attribution has fallen back to `"Guidelines"`.

Detect the corpus first and filter second, never the reverse. Section detection is the step that can be broken, and its health is measured by the unfiltered count; filtering first would hide a detection failure behind a plausible-looking small number.

When fewer than `CHAPTER_FILTER_MIN_SECTIONS` sections match, **fall back to the full set of detected sections**, print a clear line saying so, and continue. That fallback is the contract's own instruction and it is the right trade: embedding the whole guideline document costs a few hundred extra chunks and about a minute, whereas building a better splitter to rescue the filter costs twenty minutes for a corpus the demo touches four times. A filtered corpus is preferable when the filter works, because a smaller corpus makes retrieval results easier to reason about at hour seven, but it is not worth chasing.

Expect roughly 60 to 250 chunks with the filter applied and 200 to 600 without it. Print both counts.

#### Chunking

**Prefer one chunk per guideline whenever the whole thing fits under `MAX_CHUNK_CHARS`.** This is the most consequential decision in the phase and it is driven by the output medium: the retrieved chunk gets read aloud by an ElevenLabs voice. A chunk that begins mid-sentence sounds broken in a way that a chunk in a text box does not, and the demo's credibility rests on the agent sounding like it is reading a document rather than emitting fragments.

The fallback ladder, in order:

1. Whole guideline as one chunk if `text.length <= MAX_CHUNK_CHARS`.
2. Otherwise one chunk per subsection, each starting at its heading, since a heading is a clean opening for a spoken passage.
3. Only if a single subsection exceeds the budget, split it into character windows of `MAX_CHUNK_CHARS` with `OVERLAP_CHARS` of overlap, breaking at the last sentence boundary inside the window rather than mid-word.

| Field | Value |
|---|---|
| `source` | `SOURCE` (`"NASEMSO-2022-v3"`). |
| `sectionTitle` | The guideline title. Identical across every chunk of one guideline, which is what `runbooks_sectionTitle` indexes and what `vs_runbooks` filters on. |
| `sectionPath` | `[chapter, title]` or `[chapter, title, subsectionHeading]`. |
| `text` | The clean passage, exactly what gets read aloud. |
| `pageStart` / `pageEnd` | Inclusive 1-based page range the chunk's text came from. Equal when a chunk sits on one page. |
| `chunkIndex` | 0-based **within its guideline**, so `(sectionTitle, chunkIndex)` identifies a chunk and a single-chunk guideline always has `chunkIndex: 0`. `contracts.md` does not state the scope; this is the choice, and it goes in `agents.md`. |
| `embeddedText` | `buildEmbeddedText(chunk)` — the breadcrumb followed by the text. |
| `embedding` | Filled in by the port at ingest time. |

`buildEmbeddedText` prefixes the breadcrumb: `` `${sectionPath.join(" > ")}\n${text}` ``. That is why `embeddedText` is a separate contract field from `text`. A chunk whose body is a `Treatment and Interventions` list is nearly context-free on its own, and a query like "adult cardiac arrest airway" will not match it; prefixing the guideline title puts the topic into the vector. Meanwhile `text` stays clean so nothing speaks a breadcrumb aloud.

#### The sanity gate

`assertChunkCountSane` throws when the count is below `MIN_EXPECTED_CHUNKS` (50) or above `MAX_EXPECTED_CHUNKS` (3000). **Apply it to the unfiltered chunk count**, before the chapter filter narrows anything, because the unfiltered number is the one that measures whether section detection worked. Expect roughly 200 to 600 chunks unfiltered in a healthy run.

**Call it before the first embedding call, never after.** A count of 12 means anchor detection is not matching and the corpus is twelve enormous blobs. A count of 5000 means every line is being treated as a boundary. Both are obvious in one number and invisible in a corpus you have already paid to embed. The throw message should print the count, the two bounds, and the section count, because the ratio of chunks to sections says immediately which of the two failures happened.

#### Writing

Delete then insert, scoped by `source`:

```ts
await col<RunbookDoc>(RUNBOOKS).deleteMany({ source: SOURCE });
// then insertMany in batches of 200
```

**Delete-then-insert rather than upsert, and this is deliberate.** The chunker changes between runs, so chunk boundaries and therefore chunk identities change. Upserting on any key derived from the text leaves the previous strategy's chunks alongside the new ones, and a corpus containing two chunking strategies produces retrieval results that cannot be reasoned about at all — you cannot tell whether a mediocre hit means a bad query, a bad embedding, or a stale chunk. Scoping the delete to `{ source: SOURCE }` keeps it from touching anything another phase wrote.

Batch `insertMany` in groups of 200 with `ordered: false`. Each document carries `env.embeddingDim` doubles, which is roughly eight kilobytes of BSON on top of the text, so 200 documents is a few megabytes per batch — comfortably inside limits and few enough round trips to be fast.

Embed in one call to `EmbeddingsPort.embed(texts, "document")` per batch, passing `embeddedText` values in chunk order and zipping the results back positionally. **`"document"` is mandatory here.** Voyage embeds documents and queries into deliberately different regions of the space, so a corpus written with `"query"` retrieves measurably worse for every search PHASE-07 ever runs, with no error to indicate it. PHASE-03 asserts that the returned array length matches the input, which is what makes the positional zip safe.

### `scripts/ingest-runbooks.ts`

Behind `npm run ingest:runbooks`. Steps, each printing progress, because a silent script that takes a minute looks broken:

1. `ensurePdf` — print the path, byte count, and whether it downloaded or reused.
2. `extractPages` — print the page count and whether the cache was used.
3. `stripBoilerplate` — print the number of boilerplate lines removed and list them.
4. `detectSections` — print the section count and the first ten titles.
5. `chunkSection` across all detected sections, then `assertChunkCountSane` on that unfiltered total.
6. `filterChapters`, printing how many sections matched `RUNBOOK_CHAPTER_FILTER` and whether it fell back, then print chunk statistics for the corpus that will actually be written: total, min/median/max character length, how many exceed `MAX_CHUNK_CHARS` (must be zero), how many are whole-guideline single chunks, and the share starting with an uppercase letter or a digit.
7. Embed and write, printing batch progress.
8. Print the final inserted count and exit 0, or the failure and exit 1.

Flags:

- `--dry-run` — everything through step 6, plus writing `data/nasemso-chunks.json`, with no embedding and no database access. This is the loop to iterate the chunker in, and it needs neither Mongo nor an API key.
- `--sample=<n>` — print the first 300 characters of `n` chunks spread across the corpus. Read a few out loud, honestly. The mid-sentence heuristic in step 6 is a proxy; your ear is the actual acceptance test for a corpus that gets spoken.
- `--force-extract` — bypass the pages cache after changing the hygiene pass.
- `--section=<substring>` — chunk only guidelines whose title matches, for debugging one protocol.

Step 6's "share starting with an uppercase letter or a digit" is the objective stand-in for "does not begin mid-sentence." Require at least 95 percent. Bullet and dash prefixes count as acceptable openings; a chunk starting with a lowercase word does not.

Close the Mongo client in a `finally` block so the script exits rather than hanging on an open pool.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `ensurePdf` downloads `data/nasemso-2022.pdf` at exactly 5,040,475 bytes from the Utah mirror
- [ ] A second run does not re-download, confirmed by a printed line saying the cached file was reused
- [ ] `extractPages` returns pages with strictly increasing `pageNumber` starting at 1, and writes `data/nasemso-pages.json`
- [ ] `stripBoilerplate` prints at least one removed boilerplate line, and no chunk in the final corpus contains any string listed in `boilerplate`
- [ ] No chunk's `text` contains a page-number-only line
- [ ] No chunk's `text` contains a lowercase letter immediately preceded by `-\n`
- [ ] No chunk's `text` contains three consecutive newlines
- [ ] `detectSections` returns at least 40 sections, each with a non-empty `title` and `pageStart <= pageEnd`
- [ ] At least one section's title matches `/field triage/i`
- [ ] No section title matches `/^references?$/i` or `/acknowledg/i`, and no chunk's `sectionPath` ends with `References`
- [ ] Unfiltered chunk count is between 50 and 3000, and `assertChunkCountSane` throws on 12 and on 5000
- [ ] `filterChapters` prints its matched-section count, and either it matched at least 15 sections or the run printed the fallback line and used every detected section
- [ ] Every chunk's `text.length` is at most 1600
- [ ] At least 40 percent of chunks are whole-guideline single chunks, so the TTS-friendly path is the common case rather than the exception
- [ ] At least 95 percent of chunks begin with an uppercase letter, a digit, or a bullet or dash
- [ ] Every chunk has `pageStart >= 1` and `pageEnd >= pageStart`, and `chunkIndex` is 0-based and contiguous within each `sectionTitle`
- [ ] Every chunk's `embeddedText` begins with its `sectionPath` joined by `" > "` and its `text` does not
- [ ] `--dry-run` writes `data/nasemso-chunks.json`, touches neither Mongo nor an embeddings provider, and produces an identical chunk count on two consecutive runs
- [ ] **Verifiable with all other ports faked:** with `EMBEDDINGS_MODE=fake`, `npm run ingest:runbooks` completes end to end with no API key, and every written document has `embedding.length === env.embeddingDim` and a non-empty `embeddedText`
- [ ] Every written document has `source: "NASEMSO-2022-v3"`
- [ ] Running the ingest twice leaves the same document count in `runbooks`, with no duplicate `(sectionTitle, chunkIndex)` pair
- [ ] Ingestion succeeds against a database where `npm run indexes` has never run, creating no indexes of its own
- [ ] The embed call passes `"document"` as the input type, verified by reading the call site
- [ ] Reading three sampled chunks aloud produces no passage that starts mid-sentence

## Verification

On PowerShell, set inline environment variables with `$env:VAR="value"` before the command instead of the `VAR=value cmd` prefix shown here.

```bash
npm run typecheck

# The iteration loop: no Mongo, no embeddings, no API key.
npx tsx scripts/ingest-runbooks.ts --dry-run
npx tsx scripts/ingest-runbooks.ts --dry-run --sample=6

# Full ingest with fake embeddings, then again to prove delete-then-insert is clean.
EMBEDDINGS_MODE=fake npm run ingest:runbooks
EMBEDDINGS_MODE=fake npm run ingest:runbooks
```

The PDF and the extraction:

```bash
npx tsx -e "
import { ensurePdf, extractPages, PDF_BYTES } from './src/lib/ingest/runbooks';
const p = await ensurePdf();
console.log(p, 'bytes ok', p.bytes === PDF_BYTES);
const pages = await extractPages();
console.log('pages', pages.length);
console.log('numbering ok', pages.every((x, i) => x.pageNumber === i + 1));
process.exit(0);
"
```

Chunk statistics and the hygiene rules, all from the dry-run artifact:

```bash
npx tsx -e "
import { readFileSync } from 'fs';
const chunks = JSON.parse(readFileSync('data/nasemso-chunks.json','utf8'));
const lens = chunks.map((c:any)=>c.text.length).sort((a:number,b:number)=>a-b);
console.log('chunks', chunks.length, 'min', lens[0], 'median', lens[Math.floor(lens.length/2)], 'max', lens[lens.length-1]);
console.log('over budget (want 0)', chunks.filter((c:any)=>c.text.length>1600).length);
const single = chunks.filter((c:any)=>c.sectionPath.length===2).length;
console.log('whole-guideline share', (single/chunks.length*100).toFixed(1) + '%');
const clean = chunks.filter((c:any)=>/^[A-Z0-9\u2022\-]/.test(c.text.trim())).length;
console.log('clean openings', (clean/chunks.length*100).toFixed(1) + '%');
console.log('page-number lines (want 0)', chunks.filter((c:any)=>c.text.split('\n').some((l:string)=>/^[\s.\-]*\d{1,4}[\s.\-]*\$/.test(l))).length);
console.log('broken hyphens (want 0)', chunks.filter((c:any)=>/-\n[a-z]/.test(c.text)).length);
console.log('triple newlines (want 0)', chunks.filter((c:any)=>/\n{3}/.test(c.text)).length);
console.log('references leaked (want 0)', chunks.filter((c:any)=>/^references?\$/i.test(c.sectionPath.at(-1) ?? '')).length);
console.log('field triage kept', chunks.some((c:any)=>/field triage/i.test(c.sectionTitle)));
console.log('breadcrumb prefix ok', chunks.every((c:any)=>c.embeddedText.startsWith(c.sectionPath.join(' > '))));
console.log('pages sane', chunks.every((c:any)=>c.pageStart>=1 && c.pageEnd>=c.pageStart));
process.exit(0);
"
```

The written corpus, after a run with fake embeddings:

```bash
EMBEDDINGS_MODE=fake npx tsx -e "
import { col } from './src/lib/db/client';
import { RUNBOOKS } from './src/lib/contracts';
import { env } from './src/lib/env';
const c = col(RUNBOOKS);
const total = await c.countDocuments({ source: 'NASEMSO-2022-v3' });
console.log('docs', total);
console.log('wrong dim (want 0)', total - await c.countDocuments({ embedding: { \$size: env.embeddingDim } }));
console.log('missing embeddedText (want 0)', await c.countDocuments({ \$or: [{ embeddedText: { \$exists: false } }, { embeddedText: '' }] }));
const dupes = await c.aggregate([
  { \$group: { _id: { s: '\$sectionTitle', i: '\$chunkIndex' }, n: { \$sum: 1 } } },
  { \$match: { n: { \$gt: 1 } } }, { \$count: 'dupes' },
]).toArray();
console.log('duplicate (sectionTitle, chunkIndex) (want none)', JSON.stringify(dupes));
const sample = await c.findOne({}, { projection: { sectionTitle: 1, sectionPath: 1, pageStart: 1, pageEnd: 1, text: 1 } });
console.log(JSON.stringify(sample, null, 2).slice(0, 900));
process.exit(0);
"
```

Read the sampled chunks. If any begins mid-sentence, the fallback ladder is dropping to character windows too eagerly; raise the subsection split's priority before touching `MAX_CHUNK_CHARS`.

## Handoff Note

Announce the chunk count, the whole-guideline share, and whether the corpus was embedded with `fake` or `real`. PHASE-07 cannot judge retrieval quality against a fake-embedded corpus, and that is the single most likely reason for somebody to spend twenty minutes concluding the fan-out pipeline is broken when it is fine.
