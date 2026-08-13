# Workstreams — four people, disjoint files

Four branches, four owners. File ownership is already disjoint in `overview.md`. Merge in any order after PHASE-01 is on `master`. Do not edit a file your workstream does not own.

| Branch | Owner slot | Phases | Budget | What it is |
|---|---|---|---|---|
| `ws/data` | Member 1 | 01–06 | ~2.5 h | Foundation + NYC slice + NASEMSO + seed memory |
| `ws/graph` | Member 2 | 07–09 | ~2.75 h | Retrieval fan-out + LangGraph + decision/ePCR writers |
| `ws/runtime` | Member 3 | 10–13 | ~3 h | SSE event bus, tool routes, worker, ElevenLabs |
| `ws/demo` | Member 4 | 14–16 | ~2.8 h | Judge dashboard, run of show, fake-to-real cutover |

```
master
  ├─ ws/data      PHASE-01 … 06
  ├─ ws/graph     PHASE-07 … 09
  ├─ ws/runtime   PHASE-10 … 13
  └─ ws/demo      PHASE-14 … 16
```

## Sequence

1. **Everyone starts by pulling `master`.** Specs and contracts are already there.
2. **Member 1 lands PHASE-01 on `ws/data` and merges it to `master` first.** Everyone else rebases onto that. Until then, other streams can still write against the specs and fakes, but they cannot typecheck a real app.
3. **Then all four work in parallel.** Set every port you do not own to `fake`. Your phase's acceptance criteria must pass that way.
4. **Merge back to `master` whenever a phase is green.** Disjoint files mean these should not conflict.
5. **Member 4 runs PHASE-16 last**, after 01–15 are on `master`. Build 14 and 15 against fixtures while waiting.

## Do not touch

| You are on | Never edit |
|---|---|
| `ws/data` | anything under `src/lib/graph`, `src/lib/retrieval`, `src/lib/voice`, `src/lib/events`, `app/`, `worker/`, `src/components`, `docs/` |
| `ws/graph` | `package.json`, `src/lib/contracts`, `src/lib/ingest`, `src/lib/embeddings`, `app/`, `worker/`, `src/components` |
| `ws/runtime` | `src/lib/graph`, `src/lib/retrieval`, `src/lib/memory`, `src/lib/ingest`, `src/components`, `docs/` |
| `ws/demo` | `src/lib/**` except reading contracts; no `app/api/**`, no `app/voice/**` |

`src/lib/memory/` is split: Member 1 owns `seed.ts`, Member 2 owns `index.ts`, `decisions.ts`, `postmortem.ts`, `epcr.ts`. Do not both create an extra barrel.

`package.json` is PHASE-01 only. Scripts for later phases are already listed in `contracts.md` §12 — do not add them again.

## Per-branch start

```bash
git fetch origin
git checkout ws/data      # or ws/graph, ws/runtime, ws/demo
git rebase origin/master  # after PHASE-01 lands
```

Read, in order: `.ralph/overview.md` → `.ralph/contracts.md` → `.ralph/agents.md` → your phase spec in `.ralph/specs/`.

## Merge order (if time is short)

1. `ws/data` (especially 01, 02, 06)
2. `ws/graph` (08 is the kill-and-resume)
3. `ws/runtime` (13 is the voice)
4. `ws/demo` (14 can merge earlier; 16 waits)

Never cut: signature match, failure memory, readback gate, kill-and-resume, the second call.
