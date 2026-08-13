# BlackBox

Voice-native flight recorder for EMS crews. During a call it captures the decisions medics make and the reasons they give, writes them to MongoDB Atlas, and retrieves that reasoning to brief the next crew.

**One in seven New York EMS calls (15.0% since 2023) turns out to be something other than what it was dispatched as.** That reasoning currently dies in radio chatter. BlackBox stores it.

## Setup

```bash
cp .env.example .env.local
# fill MONGODB_URI and API keys; keep EMBEDDING_DIM matched to EMBEDDING_MODEL
npm install
npm run check
npm run dev
```

The cluster must be **Flex or dedicated**. M0 free clusters cap at 3 Atlas Search indexes; this project needs 4.

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
