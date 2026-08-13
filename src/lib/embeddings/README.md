# EmbeddingsPort (PHASE-03)

Default export from this folder is the real `EmbeddingsPort`. Dimension today: **1024** (`voyage-3-large`).

The registry loads this module when `EMBEDDINGS_MODE=real`. Until the keys below are set, PHASE-05 and PHASE-06 should keep `EMBEDDINGS_MODE=fake`.

## What you need to go live

Copy `.env.example` to `.env.local` and fill:

| Variable | Required for | Notes |
|---|---|---|
| `VOYAGE_API_KEY` | Real Voyage calls | Primary provider. Get a key from [voyageai.com](https://www.voyageai.com/). |
| `MONGODB_URI` | `_embed_cache` | Flex or dedicated Atlas (not M0). Cache misses degrade to a warning if URI is missing; ingest still works, it just re-embeds. |
| `MONGODB_DB` | Cache collection | Defaults to `blackbox`. |
| `EMBEDDINGS_MODE` | Registry | `real` to use this module. `fake` keeps hash vectors. |
| `EMBEDDING_PROVIDER` | Provider pick | `voyage` (default) or `openai`. No automatic failover. |
| `EMBEDDING_MODEL` | API + cache key | Default `voyage-3-large`. Must agree with `EMBEDDING_DIM`. |
| `EMBEDDING_DIM` | Assert + indexes | Default `1024`. A mismatch with the model throws at import. |
| `OPENAI_API_KEY` | OpenAI fallback only | Unused while provider is `voyage`. |

Then run PHASE-02 indexes so `_embed_cache.hash` is unique and the four `vs_*` indexes are `1024` / `READY`:

```powershell
$env:EMBEDDINGS_MODE="fake"
npm run indexes
```

After that, flip embeddings real and re-embed the corpus once:

```powershell
$env:EMBEDDINGS_MODE="real"
npm run ingest:runbooks
npx tsx scripts/seed-memory.ts --templated
```

Do not embed a real corpus twice. Fake-embedded runbooks/postmortems must be rewritten after this switch or retrieval looks mediocre for no obvious reason.

## OpenAI fallback (four minutes, env-only)

There is no automatic Voyage → OpenAI failover. That would change 1024 → 1536 mid-run and empty `$vectorSearch`.

1. Set `EMBEDDING_PROVIDER=openai`, `EMBEDDING_MODEL=text-embedding-3-small`, `EMBEDDING_DIM=1536`.
2. `npm run indexes` — PHASE-02 recreates all four vector indexes at 1536.
3. Re-run `npm run ingest:runbooks` and `npm run seed`.

## Live checks (verified 2026-08-13)

Against the configured Atlas cluster and Voyage key:

- Upserting the same cache row twice leaves one document; `getCached` returns it.
- A cache row whose `dim` ≠ `env.embeddingDim` is ignored.
- Embedding 5 texts twice hits `_embed_cache` on the second call (provider invoked once).
- `embedVoyage(..., "query")` returns length 1024; the same text as `"document"` vs `"query"` is not identical.

PHASE-05 / PHASE-06 can set `EMBEDDINGS_MODE=real` and embed the corpus once.
