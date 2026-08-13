# Phase 16 — Fake-to-Real Cutover and End-to-End Smoke

**Status:** PENDING
**Tasks:** US-031, US-032
**Depends on:** PHASE-01 plus every phase whose port it flips (02–15). This is the **only serial phase after 01.** Do not start it until the parallel wave has landed its files, even if some acceptance criteria are still being polished.
**Budget:** 50 min
**Parallel:** no — this is the seam. Fourteen fakes becoming six real ports is one job, not fourteen.

## Objective

Flip every `*_MODE` from `fake` to `real`, prove no port is still silently faked, and run one smoke path that is the demo minus the voice: fire a live incident, brief from real retrieval, interrupt at readback, resume, write a decision with a rationale, close, and show a live postmortem on the dashboard.

## Why This Phase Exists

Every other phase was designed to pass with the other ports faked. That is what made them parallel. It is also what makes a working-looking system that has never actually talked to Atlas Vector Search, never actually checkpointed, and never actually called ElevenLabs. The failure mode is a pitch where the dashboard is driven by `fixtures/event-stream.json` and the agent is a TTS layer reading pre-generated text — exactly what the judging criteria filter out.

This phase is the missing hour in the original four-hour estimate. Budget it. Do not skip it to start rehearsing.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §9 (ports + registry), §10 (routes), §14 (demo corpus)
- `.ralph/overview.md` — Critical Rules, the stage moment, environment variables
- `scripts/demo-preflight.ts` (PHASE-15 owns the file; this phase **calls** it, does not edit it)
- `scripts/kill-resume-drill.ts` (PHASE-08 owns it; this phase **calls** it)

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `scripts/integrate.ts` | Env audit, fake-port detection, index readiness, corpus floors |
| `scripts/smoke.ts` | One scripted call through fire → brief → readback → decision → close |

Do not edit `.env.example` (PHASE-01) or `package.json` — `"integrate"` and `"smoke"` are already in the contract script list. Do not edit another phase's implementation to make the smoke pass; if a real port is wrong, that is a bug in that phase, log it in `agents.md`, and fix it in that phase's files.

### Ports consumed

All seven, in `real` mode. That is the point.

```
EMBEDDINGS_MODE=real
RETRIEVAL_MODE=real
LLM_MODE=real
EVENTS_MODE=real
GRAPH_MODE=real
VOICE_MODE=real
NEXT_PUBLIC_EVENTS_MODE=real
```

### Ports implemented

None.

## Files to Create

### `scripts/integrate.ts`

A go/no-go for the cutover. Prints a table, exits non-zero on any failure. Checks, in order:

1. **Env audit.** Every required key in `overview.md` is set. `assertEmbeddingConfig()` passes. `PUBLIC_BASE_URL` is reachable from this machine.
2. **Fake-port detection.** Import the registry, resolve all six ports, and fail if any resolution logged `FAKE PORT` or if `info()`/`constructor.name` still looks like a fake. The cheapest reliable check: call `embeddings().info()` and assert `provider` is `voyage` or `openai`, not `fake`. For the others, assert the module path that was loaded does not contain `/fakes/`.
3. **Cluster.** `ping()` succeeds. Replica set name is present. Four `vs_*` indexes exist and all report `READY`. `numDimensions` on each equals `env.embeddingDim`.
4. **Corpus floors**, using the §14 constants, not the old warehouse numbers:

| Check | Floor |
|---|---|
| `incidents` with `isLive: false` | 100 |
| `UNC`→`ARREST` historical | 20 |
| `SICK`→`CARD` historical | 20 |
| `postmortems` with `origin: "seeded"` | 30 |
| `postmortems` with `origin: "curated"` | 2 |
| `remediations` with `outcome: "failure"` | 10 |
| `runbooks` | 30 |
| `decisions` | **exactly 0** |

5. **Pitch cache.** `data/pitch-numbers.json` exists and is less than 24 hours old. Do not re-query Socrata here.
6. **Tunnel.** `GET ${PUBLIC_BASE_URL}/api/counters` returns 200.
7. **Agent.** `ELEVENLABS_AGENT_ID` is set. Do not place a live call in this script — that is PHASE-13's job.

Print every check as `PASS` or `FAIL` with the observed number. A single `FAIL` is a non-zero exit.

### `scripts/smoke.ts`

One incident, no voice, no human. This is the mechanical skeleton of the three-minute demo.

```
POST /api/demo/reset          # narrow delete; seeded corpus must survive
POST /api/demo/fire { pattern: "cardiac" }
  wait until GraphPort.state(id).next includes readback_gate
  OR until state.values.brief is non-empty, then inject a pending readback
POST /api/tools/propose_readback  { incidentId, utterance: "pushing one milligram of epi, IV",
                                    drug: "epinephrine", dose: "1 milligram", route: "IV" }
POST /api/tools/confirm_readback  { incidentId, confirmed: true, verbatimOk: true }
POST /api/tools/record_decision   { incidentId, utterance: "skipping the supraglottic, family reports recent neck surgery" }
POST /api/tools/close_call        { incidentId }
GET  /api/counters
GET  /api/events?incidentId=     # read the SSE replay, then abort
```

Assert, in order:

- After `fire`, `incidents` has one new `isLive: true` document and the graph has a checkpoint for that `incidentId`.
- `brief` is ≤ 55 words and contains either a `displayId` or the exact phrase `new signature, no prior history`.
- `plan.excludedPaths` is an array. On the cardiac pattern it **should** be non-empty; if it is empty, print a warning (do not fail — fake retrieval during earlier phases may have left a thin corpus) and tell the operator to re-run `npm run seed` with real embeddings.
- `propose_readback` returns a `readbackText` containing `1 milligram` and `epinephrine` with no rounding.
- After `confirm_readback`, `getState().next` no longer sits at `readback_gate`.
- After `record_decision`, `decisions` contains exactly one document, `rationale` is non-empty, and `embeddedText` contains the rationale.
- After `close_call`, one `postmortems` document exists with `origin: "live"`, and `GET /api/counters` shows `decisions >= 1` and `postmortems` increased by one.
- The SSE replay contains at least one `decision` event and one `write` event.
- **Seeded counts are unchanged** from the start of the script — `reset` did not eat the corpus.

Then run the kill-resume drill in-process:

```
npm run drill -- --incident-id <the smoke id>
```

If `drill` cannot target an existing incident, fire a second one with `--stop-before-resume` semantics. The acceptance criterion is the same as PHASE-08: a fresh process resumes with `timeline` intact.

Timebox the whole script to 90 seconds of wall clock. If it hangs past that, dump the current graph `next` and exit 1 — a hung smoke is a hung demo.

## Acceptance Criteria

- [ ] `npm run integrate` exits 0 against the live cluster with all `*_MODE=real`
- [ ] `npm run integrate` exits non-zero if any port resolves to a fake
- [ ] `npm run integrate` exits non-zero if any `vs_*` index is not `READY`
- [ ] `npm run integrate` exits non-zero if `decisions` is not empty
- [ ] `npm run integrate` uses the §14 floors (100 historical incidents, 30 seeded postmortems), not the old 2000/300 warehouse numbers
- [ ] `npm run smoke` completes in under 90 seconds and exits 0
- [ ] After smoke, `decisions.countDocuments({}) === 1` and that document has a non-empty `rationale`
- [ ] After smoke, exactly one `postmortems` document has `origin: "live"`
- [ ] Seeded postmortem and runbook counts are identical before and after `smoke`
- [ ] `npm run drill` exits 0 on the smoke incident or a dedicated drill incident
- [ ] Dashboard at `/` with `NEXT_PUBLIC_EVENTS_MODE=real` shows the smoke incident's timeline without a page refresh (SSE)
- [ ] `npm run typecheck` and `npm run build` still pass
- [ ] No `FAKE PORT` line appears in the smoke or integrate logs

## Verification

```bash
# cutover
export EMBEDDINGS_MODE=real RETRIEVAL_MODE=real LLM_MODE=real
export EVENTS_MODE=real GRAPH_MODE=real VOICE_MODE=real
export NEXT_PUBLIC_EVENTS_MODE=real

npm run integrate
npm run smoke

# visual: open / and /voice side by side, confirm the smoke incident is on the timeline
# then hand off to PHASE-15 rehearsal
```

## If Something Fails

Fix it in the owning phase's files, not here. The common cutover failures, in the order they actually happen:

| Symptom | Likely cause | Owner |
|---|---|---|
| Empty retrieval, no error | Vector index not `READY`, or `EMBEDDING_DIM` ≠ `numDimensions` | 02 / 03 |
| `plan.excludedPaths` empty on cardiac | Seed ran with fake embeddings, so real queries miss | 06 — re-run `npm run seed` with `EMBEDDINGS_MODE=real` |
| Resume does not continue | A `MemorySaver` leaked in, or `thread_id` is not `incidentId` | 08 |
| Dashboard blank after refresh | SSE route not sending a replay frame | 10 |
| Agent talks, no tool calls | Server tools pointed at localhost instead of `PUBLIC_BASE_URL` | 13 |
| `reset` wiped runbooks | Delete filter too broad | 11 |
