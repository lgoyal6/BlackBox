# BlackBox

Voice-native flight recorder for EMS crews. During a call it captures the decisions medics make and the reasons they give, writes them to MongoDB Atlas, and retrieves that reasoning to brief the next crew.

**One in seven New York EMS calls (15.0% since 2023) turns out to be something other than what it was dispatched as.** That reasoning currently dies in radio chatter. BlackBox stores it.

## Setup

```bash
cp .env.example .env.local
# fill MONGODB_URI (Flex or dedicated Atlas URI) and API keys
# keep EMBEDDING_DIM matched to EMBEDDING_MODEL (voyage-3-large → 1024)
npm install
npm run check
npm run indexes
npm run dev
```

The cluster must be **Flex or dedicated**. M0 free clusters cap at 3 Atlas Search indexes; this project needs 4. `.env.local` is gitignored — without `MONGODB_URI` there, `npm run check` and `npm run indexes` exit 1.

## Indexes (`npm run indexes`)

Mongo cannot be faked. This script needs a live Atlas URI in `.env.local`.

| Need | Why |
|---|---|
| `MONGODB_URI` | Flex or dedicated cluster. M0 cannot hold the four `vs_*` indexes. |
| `EMBEDDING_DIM` = model size | Indexes are built at this width. Default `voyage-3-large` → **1024**. A mismatch returns empty `$vectorSearch` with no error. |
| Wait until READY | First run takes ~2 minutes. A query against a `BUILDING` index returns `[]`, which looks like a broken pipeline. |

PowerShell (inline env, not `VAR=value cmd`):

```powershell
$env:EMBEDDINGS_MODE="fake"
npm run indexes
```

The script creates 8 collections, the `decisions` rationale validator, 10 standard indexes (including a 24h TTL on `events.t`), and four vector indexes: `vs_decisions`, `vs_remediations`, `vs_runbooks`, `vs_postmortems`. It does not create `checkpoints` / `checkpoint_writes` — LangGraph's saver owns those.

Re-runs skip existing indexes and finish in a few seconds. Flags: `--skip-wait` (vector queries may be empty until READY) and `--drop-vector` (recreate all four `vs_*` after an `EMBEDDING_DIM` change).

## Script run order

| When | Command | What it does |
|---|---|---|
| First | `npm run check` | Atlas preflight: ping, replica set, search indexes, write access, fake-port report |
| After check | `npm run indexes` | Collections, validators, vector indexes |
| Data | `npm run ingest:incidents` then `npm run ingest:runbooks` then `npm run seed` | Demo corpus |
| Optional | `npm run pitch` | Cached city-wide 15.0% figure from Socrata COUNTs |
| Voice | `npm run agent:setup` | ElevenLabs agent + tools |
| Demo | `npm run dev` + `npm run worker` + `npm run demo:fire` | Live call |
| Before pitch | `npm run preflight` then `npm run smoke` | Fail closed if anything is still on a fake port |

Port isolation while a phase is in progress: set `EMBEDDINGS_MODE=fake` (and the other `*_MODE` vars) in `.env.local`. The registry logs `FAKE PORT` when it falls back.

## Seed memory (PHASE-06)

`--templated` is the default. LLM narratives are opt-in via `--llm`. **Never seed `decisions`** — that collection stays empty until the live demo.

**Needed for a real write**

- `MONGODB_URI` in `.env.local` (Flex or dedicated; not M0) and `MONGODB_DB` (default `blackbox`)
- Incidents already ingested (`npm run ingest:incidents`), **or** `--from-fixtures`
- `EMBEDDINGS_MODE=fake` and `LLM_MODE=fake` until you intentionally cut over

**PowerShell** (set env vars on their own lines; do not prefix the command):

```powershell
$env:EMBEDDINGS_MODE='fake'
$env:LLM_MODE='fake'
npx tsx scripts/seed-memory.ts --templated
```

PowerShell `npm run seed -- --target=20` is swallowed as an npm config. Use `npx tsx` or `cmd /c "npm run seed -- --target=20 ..."`.

**No Atlas / no ingest** (select and generate only):

```powershell
npx tsx scripts/seed-memory.ts --target=20 --templated --from-fixtures --dry-run
```

**Before going on stage**, run against ingested incidents (no `--from-fixtures`). Default `--target=40` should print at least 15 `UNC->ARREST` and 15 `SICK->CARD`, and `decisionsCount 0 OK (must be 0)`.

## NYC ingest and pitch numbers

`npm run ingest:incidents` pulls ~180 real 2024 NYC EMS rows from Socrata (no auth) and upserts them as historical `incidents` with finals quarantined under `_groundTruth`. `npm run pitch` never downloads a row — only `count(1)` / `$group` aggregates — and caches the 15.0% headline plus reclass priors under `data/` (gitignored).

**Needed**

| For | Required | Notes |
|---|---|---|
| Ingest | `MONGODB_URI` in `.env.local` | Atlas Flex/dedicated, or local Mongo. PHASE-02 indexes are **not** required; upserts key on `incidentId`. |
| Ingest / pitch | Network to `data.cityofnewyork.us` | No API key. Optional `SOCRATA_APP_TOKEN` raises the shared rate limit. |
| Pitch | nothing else | Does not use Mongo. |

```bash
cp .env.example .env.local          # set MONGODB_URI
npm run ingest:incidents            # expect 100–250 historical docs, isLive: false
npx tsx scripts/compute-pitch-number.ts --refresh   # once per machine
```

On PowerShell, `npm run pitch -- --refresh` can swallow flags — use `npx tsx` as above. `--offline` exits non-zero if `data/pitch-numbers.json` is missing, so run `--refresh` on the demo laptop well before the pitch. Never hit `rows.csv`. Re-running ingest is idempotent (count and `createdAt` stay put).

## Flip runbooks to real embeddings

The NASEMSO chunker is done (183 chunks, cached under gitignored `data/`). Do **not** set every `*_MODE=real` until PHASE-16. Flip **only** `EMBEDDINGS_MODE` when all three are true:

1. `.env.local` has `MONGODB_URI` on a **Flex or dedicated** cluster (M0 cannot hold 4 vector indexes)
2. `VOYAGE_API_KEY` is set, with `EMBEDDING_PROVIDER=voyage` and `EMBEDDING_DIM=1024`
3. `npm run indexes` has finished and all four `vs_*` indexes report `READY` at 1024 dimensions

Then run it **once**:

```powershell
$env:EMBEDDINGS_MODE="real"
npm run ingest:runbooks
```

Skip a fake write if the URI and Voyage key are already present. A corpus written with `EMBEDDINGS_MODE=fake` is semantically meaningless and must be re-ingested with `real` before PHASE-07 judges retrieval. Re-embedding on every chunker tweak wastes the key.
