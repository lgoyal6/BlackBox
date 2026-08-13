# Run of Show

Three minutes. Written for someone holding a phone and a clicker with no time to think.

> **Scenario under review.** The operator is reconsidering the presenting problem for the
> live demo. Everything below is written against the pair locked in `.ralph/overview.md`,
> which is what the fixtures, the seeded corpus, and the `DemoFireReq` pattern enum
> (`arrest` | `cardiac`) currently support. **Any replacement must satisfy three
> constraints or the memory thesis collapses:** it must be a dispatch-code mismatch with
> real NYC volume (that is where 15.0% comes from), call two must be a *variant* of call
> one rather than a repeat, and the seeded postmortem corpus (PHASE-06) must be reseeded to
> match or call two retrieves nothing. Changing it touches `fixtures/event-stream.json`,
> PHASE-06's seed, this file, and the two incident counts below. It does not touch the
> dashboard.

## 1. The locked two-call scenario

**Call one.** Dispatched `UNC` — `CODE_LABELS` expands it to "unconscious or unresponsive".
It turns out to be `ARREST`, "cardiac arrest". That transition is **14,987** real NYC
incidents in 2023 and later.

**Call two.** Dispatched `SICK`, "general illness". Different presenting symptoms: weakness
and nausea in an older patient, no chest pain. Same latent pattern — an occult cardiac
event. The `SICK` → `CARD` transition is **15,966** real incidents.

**Why this matters, and why call two is not a repeat.** Different dispatch label, different
presenting symptoms, same underlying pattern. That makes call two a **variant**, so vector
retrieval visibly does semantic work. Two identical calls would make vector search look
like a string lookup and the memory thesis would collapse into a cache demo. If a reviewer
can dismiss call two as "it just found the same string again," the submission is dead.

## 2. The three-minute beat table

On-screen column describes the dashboard **as built** — see `docs/superpowers/specs/2026-08-13-blackbox-dashboard-design.md`.
The Atlas vector-search card and the write-counter tiles are deliberately not on screen;
the memory proof is the `recalled from incident N · 0.91` marker under an agent turn.

| Time | Who | Spoken line | On screen | Trigger | Fallback |
|---|---|---|---|---|---|
| 0:00 | Presenter | The number, then the black box line: aviation solved this with a black box and EMS never got one | Title card with the 15.0% figure | — | — |
| 0:20 | System, then agent | Agent briefs: dispatched as unconscious, new signature, no prior history for this pattern | Header populates, phone goes to `connected`, `triage` then `recall` light in the footer, first agent turn appears | `npx tsx scripts/demo-fire.ts arrest` | Cut-list item 2: `TRIGGER_MODE=poll` |
| 0:50 | Medic, then agent | Medic narrates by voice; agent reads back the dose and waits; medic confirms; the attempt then fails and the agent says out loud that it is recording the failure with the reason | Turns append, `readback gate` goes amber in the footer, `Awaiting readback` appears on both the timeline and the phone, then the red decision block renders | Live voice | Fire the readback from the tool route directly |
| 1:10 | Agent | Second approach works; call closes; the postmortem writes itself | `record` active in the footer, checkpoint counter advances, phone reads `ended` | `close_call`, or `POST /api/demo/close` | Read the checkpoint increment aloud |
| 1:30 | Medic, then agent | Medic gives the different symptoms; agent says this resembles incident 4471, the nearest facility was on diversion there and cost eleven minutes, route to the second closest | New agent turn appears with **`↳ recalled from incident 4471 · 0.91`** beneath it | `npx tsx scripts/demo-fire.ts cardiac` | Cut-list item 1: simulate the routing action |
| 2:00 | Presenter | Point at the checkpoint counter, read the number aloud, kill the process, restart, agent resumes | Footer checkpoint counter, then the dashboard refilling by itself | See Section 5 | Rehearsed three times, so there is no fallback |
| 2:20 | Presenter | Every number on this screen arrived through an Atlas change stream | The Atlas UI with writes streaming | Switch to the second window | The checkpoint counter on the dashboard |
| 2:40 | Presenter | The response-time delta, one number, large | Closing card with the single number | — | — |

Two notes belong directly under this table.

**The agent speaks a `displayId`, not the eight-digit `incidentId`.** Contracts §3 forbids
the long form, because a TTS voice reading "one six nine seven five nine four two" is
unusable and sounds terrible on stage. The line at 1:30 says "incident 4471".

**The diversion narrative is retrieved, not scripted.** It comes from the seeded postmortem
corpus. If `postmortem-floor` fails in preflight, this beat produces nothing at all — no
recall marker, no spoken recall, and the 1:30 beat is silent.

## 3. Play real audio

This is one of the two things that make or break the demo, which is why it gets a section
rather than a bullet.

Put a teammate on a phone as the medic, or pre-record the medic side and let the agent
respond live. **Do not narrate a text log.** The ElevenLabs criteria explicitly reward low
latency and lifelike interaction, and neither is observable in a transcript — a judge
watching text appear cannot tell a 400 ms tool round-trip from a four-second one, which
means the single hardest engineering result in the build becomes invisible.

Assignments, filled in before the pitch:

| Role | Person | What they do |
|---|---|---|
| Medic voice | | Holds the phone, lies on the ground, speaks the medic lines |
| Operator | | Runs `demo-fire`, performs the kill-and-resume |
| Presenter | | Speaks the framing, points at the checkpoint counter |

**If the agent talks over the medic:** the medic keeps talking. Barge-in is a judged
criterion and interrupting the agent mid-sentence demonstrates it working. Do not stop and
wait politely — that reads as a turn-taking bug.

## 4. Show the second call

The other make-or-break item. **One call demonstrates a dictation tool. Two calls
demonstrate memory.** If the clock is running out at 1:30, cut anything else in the table
to keep this beat — including the postmortem preview and the Atlas UI window at 2:20.

## 5. The kill-and-resume drill

The mechanical drill is automated by `scripts/kill-resume-drill.ts`, which **PHASE-08
owns**. This section covers only the human choreography around it and does not redefine the
mechanics.

1. **Wait until the dashboard footer shows `readback gate` in amber and the `Awaiting
   readback` pill is visible.** Do not kill before the gate — without a pending
   `interrupt()` there is nothing to resume and the beat becomes an ordinary restart.
2. Say the line: the agent is holding on a drug-dose confirmation, watch the checkpoint
   counter. Point at `checkpoint N` in the footer and **read the number that is actually on
   screen.** Do not memorise the 34 from `reference.png`; the live count will differ, and a
   presenter reciting a stale number in front of a counter showing something else undoes
   the whole point.
3. In the terminal running `npm run dev`, press `Ctrl+C`. If PowerShell prompts to
   terminate the batch job, press `Y`. **Do not run `taskkill /F /IM node.exe`** — it also
   kills the worker and the tunnel, turning a fifteen-second beat into a sixty-second
   recovery in front of judges.
4. Run `npm run dev` again and wait for the ready line.
5. **Do nothing to the browser.** The dashboard reconnects on its own: the event stream
   never clears its view and merges the replay frame on reconnect. If the screen goes blank
   instead, that is a PHASE-14 reconnect defect and it is exactly what rehearsing three
   times is meant to catch.
6. Have the medic say "confirm" into the phone. The agent resumes the same thread and
   writes the decision.
7. Point at the counter again: it has incremented past the number just read aloud. Say the
   line — same call, same thread, resumed from Atlas.

**Rehearse three times. Non-negotiable.** Target is fifteen seconds; the third run is the
one that proves it fits.

| Rehearsal | Total run wall-clock | Kill-and-resume duration | What went wrong |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |

## 6. Cut list, in order, if behind

Pre-made so the decision is not argued at hour eight, when everyone is tired and the
argument costs more than the cut.

| Order | Cut | Why it is safe |
|---|---|---|
| 1 | Real execution | Simulate any action. No judge will check whether a route was actually dispatched. |
| 2 | Change streams for the trigger | Swap the worker to `TRIGGER_MODE=poll`. The demo looks identical. |
| 3 | The SF dataset | Already cut by decision in `overview.md`. |
| 4 | NEISS narratives | NASEMSO alone is enough corpus for retrieval to work. |

**Never cut:** the signature match, the failure memory, the readback gate, the
kill-and-resume, and the second call. Each is load-bearing for a specific judged criterion,
and removing any one turns this into a dictation tool with extra steps.

## 7. The closing number

The response-time delta between call one and call two, derived from the real response-time
fields in the dataset rather than invented. It comes from
`_groundTruth.incidentResponseSeconds` on the ingested `incidents`, which contracts §13
permits the closing metrics computation to read and forbids everywhere else.

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

**Compute this before going on stage** and write the result on the closing card.

Two rules about how it is spoken. **Do not round in a favourable direction.** And **do not
describe a dataset-derived cohort delta as though the system produced it live** — a judge
who asks whether that is your number or the city's and gets a hedge loses more trust than
the number bought.

If `npm run pitch` does not already emit this delta, raise it as a PHASE-04 scope item
rather than adding a fourth script here; PHASE-04 already reads the same collection for the
same purpose.

## Result

| Run | Date | Total | Notes |
|---|---|---|---|
| | | | |
