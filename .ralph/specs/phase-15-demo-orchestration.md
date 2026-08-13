# Phase 15 — Demo Orchestration and Rehearsal

**Status:** PENDING
**Tasks:** US-029, US-030
**Depends on:** PHASE-01 only (contracts + fakes + fixtures)
**Budget:** 45 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Ship the three operator scripts and the three documents that turn a working build into a three-minute pitch: fire either demo call on cue, run a mechanical go/no-go twenty minutes before stage, reset cleanly between rehearsals, and script the two-call scenario, the kill-and-resume drill, and the spoken framing verbatim so nothing is improvised under time pressure.

## Reference Files (read before implementing)

- `.ralph/overview.md` — the measured 15.0% number, the locked demo scenario pair, the cut list, the Stage Moment section, the Scope Guardrail, and the Critical Rules. Most of this phase is transcription and choreography around facts already settled there.
- `.ralph/contracts.md` §10 — the exact request and response shapes for `POST /api/demo/fire`, `POST /api/demo/reset`, `GET /api/counters`, `GET /api/voice/signed-url`, and `POST /api/tools/[tool]`, including the `X-BlackBox-Secret` header. Every script here is a client of those routes and must not invent a shape.
- `.ralph/contracts.md` §2 — `VECTOR_COLLECTIONS`, `vectorIndexName()`, and `WATCH_STATE`, used by the preflight checks.
- `.ralph/contracts.md` §5 — `GroundTruth`, specifically `incidentResponseSeconds`, which is where the closing number comes from.
- `.ralph/contracts.md` §13 — the rule that `_groundTruth` is read only by seeding scripts and the closing metrics computation.
- `.ralph/specs/phase-01-contracts-and-scaffold.md` — the `FAKE PORT` warning the registry emits, which the preflight greps for, and the shape of `scripts/check-atlas.ts`, which the preflight complements rather than duplicates.
- `reference.png` — what the judges will actually be looking at during beats 0:20 through 2:20. The run of show references specific elements of it by name, so know which is which.

## Parallel-Safe Contract

### Files this phase owns

Exactly these, from the ownership table in `overview.md`:

- `scripts/demo-fire.ts`
- `scripts/demo-preflight.ts`
- `scripts/demo-reset.ts`
- `docs/run-of-show.md`
- `docs/preflight.md`
- `docs/pitch-notes.md`

The ownership entry is `scripts/demo-*.ts` and `docs/**`, so any additional file must match one of those globs. Resist adding a fourth script; see the note on the closing number below.

**This phase must not touch `package.json`.** `contracts.md` §12 already defines `demo:fire` and `preflight`, which cover two of the three scripts. There is deliberately no `demo:reset` entry, so invoke that one as `npx tsx scripts/demo-reset.ts`. Adding a script line means editing a file PHASE-01 owns, which is a contract change requiring an edit to `contracts.md` §12 and a note in `agents.md` — not worth it for a one-word convenience during a 45-minute budget.

### What it consumes, and how to build it with nothing else running

The scripts import only from `@/lib/contracts` (collection and index names), `@/lib/db/client` (`getDb`, `col`, `ping`), `@/lib/env`, and `@/lib/registry` (used solely to detect fake ports). Every route they call belongs to PHASE-11, and every collection they read is populated by PHASE-02 through PHASE-06.

Each script therefore ships a mode that proves it works with **nothing running at all**, which is what makes this phase parallel-safe:

| Script | Zero-dependency mode | What it proves |
|---|---|---|
| `demo-fire.ts` | `--dry-run` | Argument parsing, pattern validation, the exact URL and JSON body it would POST, and the exit codes |
| `demo-preflight.ts` | `--offline` | The full check list renders with every network and database check as `SKIP`, the table formats, and the exit code is 0 |
| `demo-reset.ts` | `--dry-run` | The deletion plan prints, including the protected-collection allowlist, without deleting anything |

Import `env` from `@/lib/env`; `tsx` resolves the `@/*` alias from `tsconfig.json`. If it does not resolve in this repo, use a relative import rather than adding a path-resolution dependency.

The three documents have no runtime dependency on anything and can be written first. That is also the right order — see Build Order.

### Ports implemented

None. This phase implements no port, exposes no module, and is imported by nothing. It is the outermost leaf in the build.

## Files to Create

### `scripts/demo-fire.ts` (US-029)

Fires either demo call by pattern. Thin client over `POST /api/demo/fire`.

```ts
export type DemoPattern = "arrest" | "cardiac";

export interface FireArgs {
  pattern: DemoPattern;
  incidentId?: string;
  baseUrl: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): FireArgs;

export async function fire(a: FireArgs): Promise<{
  incidentId: string;
  ref: string;
  displayId: string;
}>;
```

Accepts the pattern as a bare positional argument (`npx tsx scripts/demo-fire.ts arrest`) or as `--pattern=cardiac`, plus `--incident-id=`, `--base-url=`, and `--dry-run`. `baseUrl` defaults to `PUBLIC_BASE_URL` and then to `http://localhost:3000`.

The two patterns are the two locked demo calls, and the names come straight from `contracts.md` §10: `arrest` is call one, dispatched `UNC` and turning out to be `ARREST`; `cardiac` is call two, dispatched `SICK` and turning out to be an occult cardiac event.

On success, print three lines and nothing else, because this runs on stage and a wall of output means the operator is reading instead of talking:

1. The returned `ref` in `YYMMDD-NNNN` form, so it can be compared against the dashboard header at a glance.
2. The returned `incidentId`, which is also the LangGraph `thread_id` and the value needed by every other stage command.
3. The dashboard URL, `<baseUrl>/?incidentId=<incidentId>`, ready to paste. Fumbling a query string in front of judges costs ten seconds of dead air.

Exit codes: `0` success, `1` network or non-2xx HTTP failure with the response body printed, `2` bad arguments. Use a 10-second `AbortSignal.timeout` on the fetch. A hung request that never returns is worse on stage than a fast failure, because the operator cannot tell whether to press it again.

`--dry-run` prints the method, URL, headers, and JSON body it would send, then exits 0 without touching the network.

### `scripts/demo-preflight.ts` (US-029)

The go/no-go, run twenty minutes before the pitch. It automates every mechanical item in `docs/preflight.md` and explicitly surfaces the ones it cannot.

```ts
export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fixHint: string | null;
  ms: number;
}

export interface PreflightOptions {
  baseUrl: string;
  only: string[] | null;
  json: boolean;
  offline: boolean;
  allowFixture: boolean;
  postmortemFloor: number;
  runbookMin: number;
  runbookMax: number;
}

export type Check = (o: PreflightOptions) => Promise<CheckResult>;

export const CHECKS: readonly { id: string; label: string; run: Check }[];

export async function runPreflight(
  o: PreflightOptions,
): Promise<{ results: CheckResult[]; ok: boolean }>;
```

The checks, in this order:

| id | What it asserts | Status on failure |
|---|---|---|
| `vector-indexes` | Every name from `VECTOR_COLLECTIONS` mapped through `vectorIndexName()` exists via `listSearchIndexes()` and reports `status === "READY"` | FAIL |
| `postmortem-floor` | `postmortems` document count is at or above `postmortemFloor` | FAIL |
| `decisions-empty` | `decisions` document count is exactly `0` | FAIL |
| `runbook-chunks` | `runbooks` count falls within `[runbookMin, runbookMax]` | FAIL |
| `elevenlabs-agent` | `ELEVENLABS_AGENT_ID` and `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` are both set and equal, and `GET /api/voice/signed-url` returns 200 with a `url` and a matching `agentId` | FAIL |
| `tunnel` | `PUBLIC_BASE_URL` is set and https, and `POST <PUBLIC_BASE_URL>/api/tools/log_timeline` returns 200 with the correct `X-BlackBox-Secret` **and** 401 without it | FAIL |
| `pitch-number` | `data/pitch-numbers.json` exists, parses, and carries the 15.0% figure and the 5,653,498 denominator | FAIL |
| `worker-mode` | `TRIGGER_MODE` is `changestream` or `poll`, and the `_watch_state` collection has at least one document | WARN |
| `fake-ports` | No `*_MODE` env var equals `fake`, and resolving all six ports through `@/lib/registry` logs no `FAKE PORT` warning | FAIL |
| `audio-levels` | Cannot be automated | SKIP (manual) |
| `window-layout` | Cannot be automated | SKIP (manual) |

Details that are not obvious and will cost time if guessed:

**`vector-indexes` must check `READY`, not existence.** A `PENDING` Atlas Search index returns zero results with no error, which is the same silent-empty failure mode `contracts.md` §13 warns about for dimension mismatches. An index that exists but is still building will make the entire memory story return nothing on stage while every log line looks healthy.

**`decisions-empty` is a hard FAIL, not a warning.** Critical Rule 5 says the collection fills live, and a non-zero starting count means the previous rehearsal was not reset. The visible consequence is that the `decisions` write counter on the dashboard starts at a non-zero number, which destroys the "watch it fill live" beat that the whole MongoDB track submission rests on.

**`postmortem-floor` and `runbook-chunks` are parameterized, not hard-coded.** A partially failed seed leaves retrieval technically functional while returning nothing relevant, and a truncated PDF parse leaves `runbooks` with a handful of chunks. Default `postmortemFloor` to `6`, matching the fixture postmortem count in `contracts.md` §11. The runbook bounds have no known correct value until PHASE-05 has actually run, so default them wide, and record the real observed count in `docs/preflight.md` the first time the ingestion completes so subsequent runs catch a regression. Do not invent a precise bound and present it as verified.

**`tunnel` must check both directions.** A 200 with the secret proves the tunnel and the route work; a 401 without it proves the secret is actually enforced. Testing only the happy path hides a misconfigured secret until an ElevenLabs server tool gets a 401 mid-call, which is unrecoverable inside a three-minute pitch. Probe with `log_timeline` because it is the cheapest tool at a 150 ms budget and its only side effect is appending a timeline entry, so send `incidentId: "preflight"` and leave the demo incidents untouched.

**`pitch-number` reads a file, never the network.** `data/` is gitignored per PHASE-01, so the file must be regenerated with `npm run pitch` on the demo machine. **Never make a live network call for the pitch number during the demo.** Conference wifi is the most reliable way to lose a pitch, and the number is the first sentence out of the presenter's mouth. `scripts/compute-pitch-number.ts` belongs to PHASE-04, so do not assume its exact JSON shape: check that the file parses, is non-empty, and contains a percentage near 15.0 alongside a denominator near 5,653,498, and adapt the check to whatever PHASE-04 wrote rather than asking PHASE-04 to change.

**`worker-mode` is a WARN because the contract does not guarantee a heartbeat.** `WATCH_STATE` exists in `contracts.md` §2 so the worker can persist a resume token or poll cursor, but nothing specifies an update cadence, so a script cannot honestly assert the worker is alive. Report the collection's presence and the most recent timestamp field if one exists, warn when it is absent or older than 120 seconds, and put the reliable version in `docs/preflight.md` as a manual step: look at the worker terminal and confirm it printed its trigger mode.

**`fake-ports` needs two independent detectors.** Check the `*_MODE` environment variables directly, and separately capture `console.warn` and `console.error` while awaiting all six registry resolvers, failing if any captured line contains `FAKE PORT`. Those are two different failure modes: someone deliberately setting `fake` and forgetting, versus the registry silently falling back because a real module is missing. At hour seven somebody will demo something that ran on fakes, and one of these two checks is what stops it. Also inspect `NEXT_PUBLIC_EVENTS_MODE`: a dashboard replaying a fixture is precisely the same failure. Fail on `fixture` by default, and let `--allowFixture` downgrade it to WARN for a deliberate fixture-mode dress rehearsal.

**The manual checks appear in `CHECKS` as `SKIP`** rather than being omitted. The item count in the script output and the item count in `docs/preflight.md` must match, so nothing is silently dropped between the two.

Output is a fixed-width table of id, status, duration, and detail, then a `fixHint` line under each non-passing row, then a single final line reading `GO` or `NO-GO: n check(s) failed`. Exit `0` when no check failed and `1` otherwise; `WARN` and `SKIP` do not fail the run. `--json` emits `CheckResult[]` instead. `--only=vector-indexes,tunnel` runs a subset for quick re-checks after a fix.

Give every check a 5-second timeout and keep the whole run under 20 seconds. The operator has a twenty-minute window and one hung DNS lookup should not consume it.

### `scripts/demo-reset.ts` (US-029)

Clean slate between rehearsals.

```ts
export interface ResetOptions {
  baseUrl: string;
  direct: boolean;
  dryRun: boolean;
  yes: boolean;
}

export interface ResetReport {
  deleted: Record<string, number>;
  protectedBefore: Record<string, number>;
  protectedAfter: Record<string, number>;
}

export async function reset(o: ResetOptions): Promise<ResetReport>;
```

By default it calls `POST /api/demo/reset`, because PHASE-11 owns the deletion rules and a second implementation of those rules is a second place for them to drift. `--direct` connects to Atlas through `@/lib/db/client` for when the Next app is not running, and must implement the identical allowlist from `contracts.md` §10:

- all documents in `decisions`
- `postmortems` where `origin` is `"live"`
- `remediations` where `origin` is `"live"`
- all documents in `events`
- all documents in `checkpoints` and `checkpoint_writes`
- `incidents` where `isLive` is `true`

**It must never touch `runbooks`, seeded postmortems, or seeded remediations.** Re-embedding the seed corpus twenty minutes before the pitch is the self-inflicted wound `contracts.md` §10 names explicitly, and it costs both API spend and the one window in which nothing else can be fixed.

Require `--yes` unconditionally. Between rehearsals somebody will paste a command into the wrong terminal, and a destructive script that runs on a bare invocation is a matter of when, not if.

Print a per-collection deleted count, and print the `runbooks` and seeded-`postmortems` counts before and after. Those two lines turn "reset is probably safe" into a fact verified on every single run, which is worth the four lines of code because the failure is unrecoverable inside the demo window.

`--dry-run` prints the exact filters it would apply and the count each would match, deletes nothing, and exits 0.

### `docs/run-of-show.md` (US-030)

The stage script. Written for someone holding a phone and a clicker with no time to think.

**Section 1 — the locked two-call scenario.** Both calls verbatim, because `overview.md` fixes them and any drift breaks the retrieval story:

- **Call one.** Dispatched `UNC`, which `CODE_LABELS` expands to "unconscious or unresponsive". It turns out to be `ARREST`, "cardiac arrest". This transition is 14,987 real NYC incidents in 2023 and later.
- **Call two.** Dispatched `SICK`, "general illness", with different presenting symptoms: weakness and nausea in an older patient, no chest pain. Same latent pattern, an occult cardiac event. The `SICK` to `CARD` transition is 15,966 real incidents.

State why this matters, because it is the reason a reviewer cannot dismiss the second call as a repeat: different dispatch labels and different presenting symptoms with the same underlying pattern is what makes call two a **variant**, so vector retrieval visibly does semantic work. Two identical calls would make vector search look like a string lookup, and the memory thesis would collapse into a cache demo.

**Section 2 — the three-minute beat table.** Columns: time code, who acts, the spoken line verbatim, what the judges see on screen, the command that fires it, and the fallback if it fails.

| Time | Who | Spoken line | On screen | Trigger | Fallback |
|---|---|---|---|---|---|
| 0:00 | Presenter | The number, then the black box line: aviation solved this with a black box and EMS never got one | Title with the 15.0% figure | — | — |
| 0:20 | System, then agent | Agent briefs: dispatched as unconscious, new signature, no prior history for this pattern | Header populates, `triage` then `recall` light in the footer, first agent turn appears | `npx tsx scripts/demo-fire.ts arrest` | Cut-list item 2: `TRIGGER_MODE=poll` |
| 0:50 | Medic, then agent | Medic narrates by voice; agent reads back the dose and waits; medic confirms; then the attempt fails and the agent says out loud that it is recording the failure with the reason | Turns append, `readback gate` goes amber, the `Awaiting readback` pill appears, then the decision block renders | Live voice | Fire the readback from the tool route directly |
| 1:10 | Agent | Second approach works; call closes; the postmortem writes itself | `record` active, the postmortem write counter increments, the report preview appears | `close_call`, or `POST /api/demo/close` | Read the counter increment aloud |
| 1:30 | Medic, then agent | Medic gives the different symptoms; agent says this resembles incident 4471, the nearest facility was on diversion there and cost eleven minutes, route to the second closest | `Atlas vector search` fills with the scored hits and the diversion snippet expands | `npx tsx scripts/demo-fire.ts cardiac` | Cut-list item 1: simulate the routing action |
| 2:00 | Presenter | Point at the checkpoint counter, read the number aloud, kill the process, restart, agent resumes | Footer checkpoint counter, then the dashboard refilling by itself | See Section 5 | Rehearsed three times so there is no fallback needed |
| 2:20 | Presenter | Every number on this screen arrived through an Atlas change stream | The Atlas UI with writes streaming | Switch to the second window | The dashboard write counters |
| 2:40 | Presenter | The response-time delta, one number, large | Closing card with the single number | — | — |

Two notes belong directly under the table. First, the agent's line at 1:30 speaks a `displayId`, not the eight-digit `incidentId` — `contracts.md` §3 forbids speaking the long form because a TTS voice reading "one six nine seven five nine four two" is unusable and sounds terrible on stage. Second, the diversion narrative comes from the seeded postmortem corpus, so it is retrieved and not scripted; if `postmortem-floor` fails in preflight, this beat produces nothing.

**Section 3 — play real audio.** This is one of the two things that make or break the demo, so it gets its own section rather than a bullet. Put a teammate on a phone as the medic, or pre-record the medic side and let the agent respond live. **Do not narrate a text log.** The ElevenLabs criteria explicitly reward low latency and lifelike interaction, and neither is observable in a transcript — a judge watching text appear cannot tell a 400 ms tool round-trip from a four-second one, which means the single hardest engineering result in the build becomes invisible. Include the assignment: who holds the phone, what they say, and what they do if the agent talks over them.

**Section 4 — show the second call.** The other make-or-break item. One call demonstrates a dictation tool. Two calls demonstrate memory. If the clock is running out at 1:30, cut anything else in the table to keep this beat, including the postmortem preview and the Atlas UI window.

**Section 5 — the kill-and-resume drill.** Exact keystrokes, in order, for the Windows PowerShell environment this repo is developed on. The mechanical drill is automated by `scripts/kill-resume-drill.ts`, which PHASE-08 owns; this section covers only the human choreography around it and must not redefine the mechanics.

1. Wait until the dashboard footer shows `readback gate` in amber and the `Awaiting readback` pill is visible in the timeline. Do not kill before the gate; without a pending interrupt there is nothing to resume and the beat becomes a restart.
2. Say the line: the agent is holding on a drug-dose confirmation, watch the checkpoint counter. Point at `checkpoint N` in the footer and read the number out loud. **Read the number that is actually on screen** — do not memorize the 34 from `reference.png`, because the live count will differ and a presenter reciting a stale number in front of a counter showing something else undoes the whole point.
3. In the terminal running `npm run dev`, press `Ctrl+C`. If PowerShell prompts to terminate the batch job, press `Y`. **Do not run `taskkill /F /IM node.exe`** — it also kills the worker and the tunnel, turning a fifteen-second beat into a sixty-second recovery in front of judges.
4. Run `npm run dev` again and wait for the ready line.
5. Do nothing to the browser. The dashboard reconnects on its own because PHASE-14's event stream never clears its view and merges the replay frame on reconnect. If the screen goes blank instead, that is a PHASE-14 reconnect defect and it is exactly what rehearsing this three times is meant to catch.
6. Have the medic say "confirm" into the phone. The agent resumes the same thread and writes the decision.
7. Point at the counter again: it has incremented past the number just read aloud. Say the line: same call, same thread, resumed from Atlas.

**Rehearse this three times. Non-negotiable.** Record the wall-clock duration of each rehearsal in the doc; the target is fifteen seconds and the third run is the one that proves it fits. It is thematically perfect and it is the only part of the demo that is hard to fake, which is precisely why it is also the only part where a fumble is expensive.

**Section 6 — the cut list, in order, if behind.** Put the table here so the decision is pre-made under time pressure rather than argued at hour eight, when everyone is tired and the argument itself costs more than the cut.

| Order | Cut | Why it is safe |
|---|---|---|
| 1 | Real execution | Simulate any action. No judge will check whether a route was actually dispatched. |
| 2 | Change streams for the trigger | Swap the worker to `TRIGGER_MODE=poll`. The demo looks identical. |
| 3 | The SF dataset | Already cut by decision in `overview.md`. |
| 4 | NEISS narratives | NASEMSO alone is enough corpus for retrieval to work. |

**Never cut:** the signature match, the failure memory, the readback gate, the kill-and-resume, and the second call. Each of those is load-bearing for a specific judged criterion, and removing any one of them turns this from a memory project into a dictation tool with extra steps.

**Section 7 — the closing number.** The response-time delta between call one and call two, derived from the real response-time fields in the dataset rather than invented. It comes from `_groundTruth.incidentResponseSeconds` on the ingested `incidents`, which `contracts.md` §13 permits the closing metrics computation to read and forbids everywhere else. Document the query in this file so whoever runs it can paste it:

```js
db.incidents.aggregate([
  { $match: {
      "cad.initialCallType": { $in: ["UNC", "SICK"] },
      "_groundTruth.incidentResponseSeconds": { $ne: null },
  } },
  { $group: {
      _id: "$cad.initialCallType",
      meanResponseSeconds: { $avg: "$_groundTruth.incidentResponseSeconds" },
      n: { $sum: 1 },
  } },
]);
```

**Compute it before going on stage** and write the result on the closing card. Two rules about how it is spoken. Do not round in a favorable direction. And do not describe a dataset-derived cohort delta as though the system produced it live — a judge who asks whether that is your number or the city's and gets a hedge loses more trust than the number bought. If `npm run pitch` does not already emit this delta, raise it as a PHASE-04 scope item rather than adding a fourth script here; PHASE-04 already reads the same collection for the same purpose.

### `docs/preflight.md` (US-030)

The human go/no-go checklist, run at T-minus 20 minutes, in execution order. Each item is marked either automated by `npx tsx scripts/demo-preflight.ts` or manual, and the item count must match the script's `CHECKS` list exactly so nothing falls between the two.

Automated block, run first as one command: the four vector indexes report `READY`; the seeded postmortem count is above the floor; `decisions` is empty; the runbook chunk count is in range; the ElevenLabs agent id is set and the agent responds; the tunnel URL resolves and `/api/tools/*` answers correctly with and without the shared secret; `data/pitch-numbers.json` exists and is cached; the worker is in the expected trigger mode; and no port is silently resolving to a fake.

Manual block, with the specific action for each rather than a vague instruction:

- **Worker liveness.** Look at the worker terminal and confirm it printed its trigger mode. The script can only warn here.
- **Audio levels.** Phone volume, laptop output, and microphone gain. Run a ten-second two-way test using the actual first medic line from the run of show, not a count-to-three, because the real line reveals whether barge-in cuts the agent off cleanly.
- **Window layout.** Two browser windows positioned side by side, sized so that nothing needs alt-tabbing. Window A is the dashboard at `/?incidentId=<id>`; window B is the voice page. **Alt-tabbing on stage is the single most common stumble** because the audience briefly sees a desktop and the whole thing stops looking like a product.
- **Tunnel URL written on paper.** Tunnels rotate and the URL is unmemorable.
- **Phone on Do Not Disturb** except for the demo number.
- **Laptop on power with display sleep disabled.** A screen that dims during the 2:00 beat is an unforced loss.
- **Fixture-mode fallback confirmed.** Load `/?mode=fixture` once and confirm the reference state renders. This is the insurance policy: if the backend dies mid-pitch, that URL puts a full dashboard back on the projector in one reload.
- **Reset run.** `npx tsx scripts/demo-reset.ts --yes` and confirm from its output that `runbooks` and the seeded postmortems were untouched.

End the file with a go/no-go decision line naming one person who makes the call, and an explicit statement of what a NO-GO means: run the demo in fixture mode and say so, rather than improvising a live run that fails on stage.

### `docs/pitch-notes.md` (US-030)

The spoken framing. Not slides — the sentences.

**The opening.** Lead with the measured number: **15.0%, one in seven New York EMS calls turns out to be something other than what it was dispatched as.** Say that it was computed from 5,653,498 incidents rather than cited from a paper, because that distinction is the difference between a claim and a result. Then the black box line.

**Three sentences that must be said out loud, each with its reason:**

- **The medic never looks at a screen.** Earpiece and a phone in a chest pocket; the system calls them, not the reverse. This is what makes it credible to anyone who has worked a call, and it preempts the "nobody would use this" objection.
- **The agent never makes a clinical call.** It only records and recalls. It reads back what the medic said or quotes a retrieved NASEMSO passage with attribution, and it never proposes a treatment, dose, or diagnosis. Judges get visibly twitchy about AI making clinical decisions, and the prior Best-ElevenLabs winner this is modeled on won on documentation and retrieval rather than diagnosis.
- **Every number on the dashboard arrived through an Atlas change stream.** MongoDB is the memory, the state, the context, and the transport. There is no Redis, no broker, and no third-party vector store anywhere in the system.

**The production path.** Cite NEMSIS. Its 2025 public-release research dataset covers roughly 63 million EMS activations from nearly 15,000 agencies across 54 states and territories. Add the detail that it is event-based rather than patient-based, so one patient can appear across multiple records — that is a small thing to say and it signals domain knowledge no summary would give you. Note that NEMSIS requires a request form to the NEMSIS TAC, which is why the demo runs on the NYC open dataset instead.

**The winner patterns this is built against.** State them plainly so the pitch can be checked against them:

- Every top tagline leads with a number. This one opens with 15.0%.
- Memory is named as the hero, not the plumbing. Say "it remembers what the last crew decided," not "it uses vector search over embedded documents."
- MongoDB track winners made the database writes visible. That is the entire reason the dashboard's write counters and checkpoint counter exist.
- Voice winners use voice as the workflow channel, never as decoration. The medic's hands are never free, which is why voice is the only capture medium that works here rather than a feature bolted onto a form.

**Anticipated questions with prepared answers.** At minimum: whether the dashboard is real, what happens when the network drops, whether the agent could give a wrong dose, where the rationale comes from if the medic does not explain themselves, and how this differs from an ePCR product. Each answer is two sentences.

**The close.** The response-time delta as one number, large, with the derivation named. Then the one-line statement of what was built: it records what the crew decided and why, and it hands that to the next crew.

## Build Order

Documents first, scripts second. The docs are the deliverable that must exist even if the build slips, because a rehearsed three-minute pitch on a partly broken system outscores an unrehearsed pitch on a working one.

1. `docs/run-of-show.md` — the beat table and the kill-and-resume drill. Everything else is support.
2. `scripts/demo-preflight.ts` — the highest-leverage script, since it is what catches a broken demo while there is still time to fix it.
3. `scripts/demo-fire.ts` — small, and needed for every rehearsal.
4. `docs/pitch-notes.md`
5. `docs/preflight.md` — write it after the script so the two item lists match by construction.
6. `scripts/demo-reset.ts`

Forty-five minutes for six files is tight and the preflight script is where it will go over, because it has eleven checks that each touch something different. Two cuts, in order. If fifteen minutes remain, drop `scripts/demo-reset.ts` and document a `curl` to `POST /api/demo/reset` in `docs/preflight.md` instead; the route already exists and the script is convenience. If ten minutes remain, ship the preflight with `--only` support and the four database checks (`vector-indexes`, `postmortem-floor`, `decisions-empty`, `runbook-chunks`) plus `fake-ports`, and move the rest to `docs/preflight.md` as manual items. Do not cut `fake-ports`; it is the check that has the highest chance of catching a demo that would otherwise have failed silently.

## Acceptance Criteria

Everything above the divider is checkable with **no database, no Next app, no worker, and no network**.

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] `git diff --exit-code package.json` is clean — this phase added no dependency and no script entry
- [ ] All six owned files exist and no file outside `scripts/demo-*.ts` and `docs/**` was created or modified
- [ ] `npx tsx scripts/demo-fire.ts arrest --dry-run` prints the method, full URL, headers, and JSON body `{"pattern":"arrest"}`, and exits 0
- [ ] `npx tsx scripts/demo-fire.ts cardiac --dry-run` prints `{"pattern":"cardiac"}`
- [ ] `npx tsx scripts/demo-fire.ts nonsense` exits 2 and prints the two valid patterns
- [ ] `npx tsx scripts/demo-preflight.ts --offline` prints all eleven checks, marks every network and database check `SKIP`, prints `GO`, and exits 0
- [ ] `npx tsx scripts/demo-preflight.ts --offline --json` emits valid JSON parsing as an array of eleven objects each having `id`, `label`, `status`, `detail`, `fixHint`, and `ms`
- [ ] `npx tsx scripts/demo-preflight.ts --only=fake-ports` runs exactly one check
- [ ] `EMBEDDINGS_MODE=fake npx tsx scripts/demo-preflight.ts --only=fake-ports` exits 1 and names `EMBEDDINGS_MODE` in the detail
- [ ] `NEXT_PUBLIC_EVENTS_MODE=fixture npx tsx scripts/demo-preflight.ts --only=fake-ports` exits 1 by default and exits 0 with `--allowFixture`
- [ ] `npx tsx scripts/demo-reset.ts` without `--yes` refuses to run, prints why, and exits non-zero
- [ ] `npx tsx scripts/demo-reset.ts --yes --dry-run` prints the deletion plan including the `origin: "live"` and `isLive: true` filters, deletes nothing, and exits 0
- [ ] `rg "runbooks" scripts/demo-reset.ts` shows `runbooks` only in the protected-count reporting, never inside a delete call
- [ ] Every check id in `CHECKS` appears as an item in `docs/preflight.md`, and the item counts match
- [ ] `docs/run-of-show.md` contains a beat table with all eight time codes: 0:00, 0:20, 0:50, 1:10, 1:30, 2:00, 2:20, 2:40
- [ ] `docs/run-of-show.md` states both calls with their dispatch codes and their real incident counts, 14,987 and 15,966
- [ ] `docs/run-of-show.md` explains why call two is a variant rather than a repeat
- [ ] `docs/run-of-show.md` has a kill-and-resume section with numbered keystrokes, the instruction to point at the checkpoint counter first, the warning against `taskkill /F /IM node.exe`, and the requirement to rehearse three times
- [ ] `docs/run-of-show.md` references `scripts/kill-resume-drill.ts` as PHASE-08's and does not redefine the drill mechanics
- [ ] `docs/run-of-show.md` contains the cut list as a four-row ordered table plus the never-cut list of five items
- [ ] `docs/run-of-show.md` contains the closing-number aggregation and states it must be computed before going on stage
- [ ] `docs/run-of-show.md` has a dedicated section for playing real audio and one for showing the second call
- [ ] `docs/preflight.md` marks each item automated or manual and names one person for the go/no-go decision
- [ ] `docs/preflight.md` states that `data/pitch-numbers.json` must be cached and that no live network call is made for the pitch number
- [ ] `docs/pitch-notes.md` opens with 15.0% and the 5,653,498 denominator
- [ ] `docs/pitch-notes.md` contains the medic-never-looks-at-a-screen line and the agent-never-makes-a-clinical-call line
- [ ] `docs/pitch-notes.md` cites NEMSIS with 63 million activations, roughly 15,000 agencies, 54 states and territories, and the event-based rather than patient-based detail
- [ ] `docs/pitch-notes.md` lists the four winner patterns
- [ ] No document contradicts `overview.md` on the scenario pair, the cut list, or the numbers

With the stack running (PHASE-02 through PHASE-12 landed):

- [ ] `npx tsx scripts/demo-fire.ts arrest` returns an `incidentId`, a `ref` in `YYMMDD-NNNN` form, and a pasteable dashboard URL, and the dashboard header shows that same `ref`
- [ ] `npm run preflight` exits 0 on a healthy stack and exits 1 with a named failing check when a vector index is deleted
- [ ] `npm run preflight` exits 1 when a single document is inserted into `decisions`
- [ ] `npx tsx scripts/demo-reset.ts --yes` reports non-zero deletions and identical protected counts before and after
- [ ] The full run of show has been executed end to end three times, and the kill-and-resume drill's three durations are recorded in `docs/run-of-show.md`

## Verification

### Zero-dependency, nothing running

```bash
npm run typecheck
git diff --exit-code package.json

npx tsx scripts/demo-fire.ts arrest --dry-run
npx tsx scripts/demo-fire.ts cardiac --dry-run
npx tsx scripts/demo-fire.ts nonsense; echo "exit=$?"    # expect 2

npx tsx scripts/demo-preflight.ts --offline; echo "exit=$?"          # expect GO, 0
npx tsx scripts/demo-preflight.ts --offline --json | npx tsx -e "
let s=''; process.stdin.on('data', d => s += d).on('end', () => {
  const r = JSON.parse(s);
  console.log('checks', r.length);
  console.log('shape ok', r.every((c:any) => ['id','label','status','detail','fixHint','ms'].every(k => k in c)));
});"

EMBEDDINGS_MODE=fake npx tsx scripts/demo-preflight.ts --only=fake-ports; echo "exit=$?"   # expect 1
NEXT_PUBLIC_EVENTS_MODE=fixture npx tsx scripts/demo-preflight.ts --only=fake-ports; echo "exit=$?"                 # expect 1
NEXT_PUBLIC_EVENTS_MODE=fixture npx tsx scripts/demo-preflight.ts --only=fake-ports --allowFixture; echo "exit=$?"  # expect 0

npx tsx scripts/demo-reset.ts; echo "exit=$?"                        # expect refusal, non-zero
npx tsx scripts/demo-reset.ts --yes --dry-run; echo "exit=$?"        # expect plan, 0
```

Then confirm the protected collections never appear in a delete path, and that the check ids and the checklist agree:

```bash
rg -n "deleteMany|deleteOne" scripts/demo-reset.ts
rg -n "runbooks" scripts/demo-reset.ts
rg -o "id: \"[a-z-]+\"" scripts/demo-preflight.ts | sort
rg -o "^- \*\*|automated|manual" docs/preflight.md | wc -l
```

The first two commands together must show that no `deleteMany` call targets `runbooks`. The last two are a manual reconciliation: every id from the third command must appear in `docs/preflight.md`.

### With the stack running

```bash
npm run dev            # terminal 1
npm run worker         # terminal 2
npm run preflight      # terminal 3 — expect GO

npx tsx scripts/demo-fire.ts arrest
# Confirm the printed ref matches the dashboard header, character for character.

# Prove the preflight actually fails when it should, one failure at a time.
# Insert one decision document, re-run, expect exit 1 naming decisions-empty, then reset.
npx tsx scripts/demo-preflight.ts --only=decisions-empty; echo "exit=$?"

npx tsx scripts/demo-reset.ts --yes
# Confirm from the output that runbooks and seeded postmortems are identical before and after.
```

### Rehearsal, which is the actual deliverable

Run the full three-minute run of show end to end three times, with real audio, both calls, and the kill-and-resume. After each run, record in `docs/run-of-show.md`: total wall-clock duration, the kill-and-resume duration, and anything that went wrong. The third run is the one that has to be clean.

The three most likely failures, all of which are cheaper to find here than on stage: the readback gate is not amber when the operator kills the process, so there is nothing to resume; the dashboard comes back blank after the restart, which is a PHASE-14 reconnect defect; and the second call retrieves nothing because the seeded postmortems were wiped by a reset run with a broader filter than the allowlist.

## Handoff Note

The preflight script is the deliverable that other phases will run against their own work, so announce it the moment `--offline` prints a full table. Anyone can then check whether their phase is silently resolving to a fake, and the `fake-ports` check is the one thing in this repo that catches the most expensive mistake available at hour seven.
