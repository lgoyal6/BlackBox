# BlackBox Judge Dashboard - Design (PHASE-14, reduced scope)

**Branch:** `ws/demo` · **Date:** 2026-08-13 · **Supersedes the layout in:** `.ralph/specs/phase-14-judge-dashboard.md`

This document records the four decisions taken with the operator on 2026-08-13 and the
architecture that follows from them. Where it disagrees with `phase-14-judge-dashboard.md`,
this document wins and the deviation is stated explicitly below.

## Decisions taken

| # | Decision | Consequence |
|---|---|---|
| 1 | **Ship a smaller dashboard now, grow later.** | The Atlas vector-search card and the write-counter tiles are not built. Header, voice timeline, call panel, and graph footer are. |
| 2 | **Red = BlackBox, white = human.** | Red carries the agent voice, the decision block, the recording pill, and the brand mark. Amber survives for exactly one thing: the readback gate. Blue and green are dropped. |
| 3 | **The phone fills the right column.** | A call panel driven only by real events. No waveform, no faked motion. |
| 4 | **Recall is marked inline in the timeline.** | An agent turn that follows a `retrieval` event renders a `recalled from incident N · 0.91` tag. This is the on-screen proof that memory did work, replacing the deferred vector-search card. |

Scenario is **undecided** - the operator wants a different EMT presentation than the locked
`UNC→ARREST` / `SICK→cardiac` pair. This design is scenario-agnostic and unblocked by that.
PHASE-15 is blocked by it. See Open Issues.

## Architecture

One client boundary, one pure reducer, two event sources.

```
fixtures/event-stream.json ──┐
                             ├── parseEvent ── reduceEvent ── DashboardView ── components
GET /api/events (SSE)     ───┘                    ▲
GET /api/counters ────────────────────────────────┘  (checkpoint bootstrap only)
```

**`view-state.ts` is reducer-complete and component-minimal.** It handles all nine
`BlackboxEvent` kinds, including `retrieval`, `write`, and `pcr`, which nothing currently
renders. Promoting a deferred card later is then purely additive UI: no reducer edit, no
re-test of the event plumbing, no risk to a working demo at hour seven. This is the whole
point of approach A and the one place we deliberately spend budget on unrendered work.

### Unit boundaries

| Unit | Purpose | Depends on |
|---|---|---|
| `view-state.ts` | Pure reduction of the event union into `DashboardView`. No React, no DOM, no network. | `@/lib/contracts` types only |
| `format.ts` | Pure formatting + the node→stage mapping. | `@/lib/contracts` (`GRAPH_STAGES`) |
| `fixture-source.ts` | Statically-bundled fixture playback. Zero network. | `view-state.ts` |
| `use-event-stream.ts` | SSE lifecycle, reconnect backoff, counter bootstrap. Browser-only. | both of the above |
| `ui.tsx` | Card / Pill / glyph primitives. | - |
| `header-bar`, `voice-timeline`, `call-panel`, `graph-footer` | Presentational. Props in, JSX out. | `view-state` types |
| `dashboard.tsx` | The single `"use client"` boundary. Owns the one 1s interval. | all of the above |
| `app/page.tsx` | Server component. Resolves mode and incident id. | `dashboard.tsx` |

Nothing under `src/components/**` imports `@/lib/db/client`, `@/lib/registry`, or
`@/lib/env`. The Mongo driver in a browser bundle is a build failure with a confusing
error message.

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ ● Incident 260813-0442                            [Recording] │  header
│   Cardiac arrest · dispatch area B3 · unit 14B                │
├───────────────────────────────────────────────────────────────┤
│ ┌── Voice timeline ──────────────┐  ┌── phone ─────────────┐  │
│ │ 42:19  Agent  Dispatched as…   │  │   ● BLACKBOX         │  │
│ │        ↳ recalled from 4471    │  │     connected        │  │  main
│ │ 43:02  Medic  Patient unres…   │  │                      │  │  3fr / 2fr
│ │ ▐█ DECISION CAPTURED           │  │      04 : 42         │  │
│ │ ▐█ Airway deferred · rationa…  │  │                      │  │
│ │ 44:31  Agent  Confirming epi…  │  │   ▸ MEDIC            │  │
│ │        ( Awaiting readback )   │  │     speaking         │  │
│ └────────────────────────────────┘  │  ( Awaiting readback)│  │
│                                     └──────────────────────┘  │
├───────────────────────────────────────────────────────────────┤
│ Graph  triage › recall › readback gate › record  checkpoint 34│  footer
└───────────────────────────────────────────────────────────────┘
```

Only the timeline's interior scrolls. The main region is a flex child with `min-h-0`;
without it an `overflow-y-auto` region grows past the viewport instead of scrolling.

**The elapsed timer lives in the call panel, not the header.** It is a call timer and a
phone is where a call timer belongs. The header keeps the incident ref, the subtitle, and
the recording pill. This is a deviation from `phase-14` and it removes a duplicate clock.

## Call panel - every pixel is event-derived

| Element | Source | Inference |
|---|---|---|
| `connected` / `calling` / `ended` | `status.payload.status` | `dispatched`→calling, `closed`→ended, else connected |
| `04 : 42` | `status.payload.startedAt` | none |
| `▸ MEDIC` / `▸ BLACKBOX` | last `voice` event's `speaker` | yes - see below |
| `speaking` / `listening` | age of the last `voice` event | >8s old ⇒ `listening`, no active speaker |
| readback pill | `readback.payload.state` | none |

The speaking indicator is honestly "who spoke last, recently". During a live call with
sub-second event latency that is the same thing; after eight seconds of silence it degrades
to `listening` rather than claiming someone is talking. **There is no waveform and no
animation.** The spec is right that faked motion reads as theater, and a judge can ask what
drives it.

## Recall marker

When a `retrieval` event is reduced, the top hit with a non-null `displayId` is held as a
pending recall and attached to the **next agent voice turn**, then cleared. Runbook hits
have `displayId: null` and so never name an incident.

Selection is by **`score`, not `rrf`** - a deliberate deviation from the phase-14 rule. The
marker names one prior incident and displays that incident's own score; ranking by a hidden
number while showing a different one would put `4471 · 0.91` beneath a row that `2208`
outranks. With the vector-search card deferred there is no second surface to disagree with.
**If that card is later promoted, revisit this** - the card ranks by `rrf` and the two must
agree.

## Palette

```
--bb-bg          #0A0A0B   page
--bb-surface     #101013   cards
--bb-surface-2   #17171B   nested surfaces
--bb-border      #1F1F23   card borders, dividers
--bb-border-strong #2A2A30 inactive pills, scrollbar thumb
--bb-text        #F4F4F5   utterances, Medic label, checkpoint
--bb-muted       #8A8A93   labels, clocks, chevrons
--bb-muted-bright #A1A1AA  secondary body text
--bb-red         #FF4D4F   Agent label, recorder glyph, decision bar, brand
--bb-red-label   #FF8A8C   "Decision captured"
--bb-red-text    #FFD7D8   decision body line
--bb-red-surface #2A0E0F   decision block background
--bb-red-pill    #7F1D1D / #FEE2E2   recording pill bg / fg
--bb-amber       #FBBF24   readback gate only
--bb-amber-surface #3B2A08
--bb-amber-border  #7C5410
```

Nothing renders below 14px. This is a projector read from six meters.

The checkpoint counter is white and flashes a **red** ring for 400ms on increment,
suppressed under `prefers-reduced-motion`. Red for the flash is coherent with the palette
rule: red means BlackBox just captured something, and a checkpoint increment is exactly that.

## Data flow and failure behaviour

- **Fixture mode** (`?mode=fixture` or `NEXT_PUBLIC_EVENTS_MODE=fixture`) statically imports
  the fixture, revives `t` into a `Date`, and applies every event synchronously. No network,
  no timers. `?replay=1` spaces them 250ms apart for rehearsal.
- **Real mode** bootstraps the checkpoint count from `GET /api/counters` (shape-checked at
  runtime - there is no zod schema for it in `contracts/api.ts`), then opens an `EventSource`.
- **Reconnect never clears the view.** Backoff 1/2/4/8s then a jittered 10s ceiling, forever.
  The mid-demo kill-and-resume depends on this screen refilling by itself.
- Reduction is **idempotent** - dedupe by `seq`, keyed `incidentId ?? "__global"` - so
  re-applying the SSE replay frame after a reload is a no-op.
- `write.payload.count` is an **absolute total**, last write wins. `checkpoint` count is
  monotonic via `Math.max`; the presenter has already read the old number aloud.
- Unknown `kind` assigns to a `never` local for compile-time exhaustiveness, increments
  `unknownKindCount`, and returns the view unchanged. It never throws - a thrown error in a
  client component blanks the whole screen.

## Testing

The reducer is pure, so the meaningful checks run from a `tsx` one-liner with nothing else
running: parse the fixture, assert idempotence of `reduceAll(evs)` vs `reduceAll([...evs, ...evs])`,
assert the checkpoint never decreases, assert an unknown kind is survivable, and assert
`GRAPH_STAGES` covers every value in `GRAPH_NODE_ORDER`. Visual verification is a side-by-side
against the live page at 1440×900.

## Deviations from `phase-14-judge-dashboard.md`

1. Vector-search card and write-counter tiles **not built** (decision 1).
2. Palette replaced (decision 2). Blue and green removed; red re-scoped from "exactly once".
3. Call panel added in the right column (decision 3).
4. Recall marker added to the timeline (decision 4), selected by `score` not `rrf`.
5. Elapsed timer moved from header to call panel.
6. **No `tailwind.config.ts`** - PHASE-01 installed Tailwind v4, which is CSS-first. Tokens
   live in `app/globals.css` under `@theme`. The spec anticipated either version.
7. Empty-state lines are kept, not dropped. A card that renders as a floating title over a
   void reads as a bug from the audience, and in real mode the first twenty seconds are
   nothing but empty states.

## Open issues

- **Scenario undecided.** Whatever pair replaces `UNC→ARREST` / `SICK→cardiac` must be a
  dispatch-code mismatch with real NYC volume, and call two must be a *variant* of call one  - 
  different dispatch label, different symptoms, same latent pattern - or vector search looks
  like a string lookup. Blocks: `fixtures/event-stream.json` (`ws/data`), the seeded
  postmortem corpus (PHASE-06, `ws/data`), `docs/run-of-show.md` (PHASE-15, this branch), and
  the 14,987 / 15,966 counts in the pitch. Does not block PHASE-14.
- If the vector-search card is promoted, reconcile the recall marker's `score` ranking with
  the card's `rrf` ranking.
