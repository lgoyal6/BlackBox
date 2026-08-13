# Phase 14 — Judge-Facing Dashboard

**Status:** PENDING
**Tasks:** US-027, US-028
**Depends on:** PHASE-01 only (contracts + fakes + fixtures)
**Budget:** 75 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Build the read-only dashboard that lets judges watch the black box fill up, matching `reference.png` pixel for pixel. It must render its complete final state from `fixtures/event-stream.json` with no database, no worker, and no API running, and it must switch to a live Server-Sent Events feed by changing one environment variable.

## Reference Files (read before implementing)

- `reference.png` — **the pixel target.** Open it beside your browser the entire time. Every layout, color, and string decision in this spec was transcribed from it, and where this spec and the image disagree, the image wins.
- `.ralph/contracts.md` §8 — the `BlackboxEvent` discriminated union. This is the only data shape the dashboard consumes. Do not add a field to it; see the Contract Gaps section at the end of this spec.
- `.ralph/contracts.md` §6 — the `Hit` type, rendered in the vector search card.
- `.ralph/contracts.md` §4 — `GraphNode`, `GRAPH_NODE_ORDER`, and `IncidentStatus`, all rendered in the footer and header.
- `.ralph/contracts.md` §10 — `GET /api/events` (the SSE contract, including the 200-event replay frame) and `GET /api/counters` (the bootstrap).
- `.ralph/contracts.md` §11 — `fixtures/event-stream.json`, which is the entire input for fixture mode.
- `.ralph/overview.md` → Judge-Facing Dashboard — the section-by-section description this spec expands.
- `.ralph/specs/phase-01-contracts-and-scaffold.md` — the scaffold you are building on, including which Tailwind setup exists and what `fixtures/event-stream.json` is guaranteed to contain.

## Parallel-Safe Contract

### Files this phase owns

Exactly these, from the ownership table in `overview.md`:

- `app/page.tsx`
- `app/layout.tsx`
- `app/globals.css`
- `src/components/**`
- `tailwind.config.ts`

Nothing else. In particular this phase **must not touch `package.json`**. No charting library, no component library, no icon package, no animation library. The dashboard is a header, three cards, and a footer; every dependency you would add costs more minutes in install, bundling, and version debugging than it saves in markup. Both glyphs in `reference.png` are inline SVG. If you find yourself wanting a dependency, that is the signal to write twenty lines of flexbox instead.

Two of the owned files are shared surfaces that PHASE-13 will render inside, since it owns `app/voice/**`:

- `app/layout.tsx` must contain **only** the `html`/`body` elements, base classes, font wiring, and `metadata`. No grid, no `h-dvh`, no fixed header, no `overflow-hidden` on `body`. Dashboard layout lives in `app/page.tsx` and `src/components/dashboard.tsx`. A viewport lock in the root layout silently breaks a page written by another agent who never reads this file.
- `app/globals.css` must contain only the Tailwind directives, the design token definitions, base resets, and shared utilities. No page-specific or component-specific selectors.

### What it consumes, and how to build it with nothing else running

Set this and the dashboard is fully functional with zero backend:

```env
NEXT_PUBLIC_EVENTS_MODE=fixture
```

In that mode the only input is `fixtures/event-stream.json`, which PHASE-01 owns and which reproduces the exact state in `reference.png`: incident `260813-0442`, cardiac arrest, dispatch area B3, unit 14B, four voice turns at clocks `42:19`, `43:02`, `44:10`, and `44:31`, one `decision` event (airway deferred, rationale recorded, no protocol conflict), one `readback` event in state `awaiting`, one `retrieval` event with three hits scoring 0.91, 0.87, and 0.84, `write` counters at decisions 7 and timeline 34, active node `readback_gate`, and checkpoint count 34.

The browser never touches a port. Ports are server-side abstractions; this phase consumes the event *contract*, not `EventsPort`. That is why fixture mode needs no registry, no `EVENTS_MODE`, and no import from `@/lib/registry` — and why it works in a production `next build` with the network cable unplugged.

Fixture mode is not only a build convenience. It is the pitch's insurance policy: if the worker, the tunnel, or Atlas is broken at 3:00 pm, appending `?mode=fixture` to the dashboard URL puts the full reference state back on the projector in one reload. Build it as a first-class mode, not a test harness.

### Ports implemented

None. This phase implements no port and exposes no server-side module to any other phase. It is a leaf.

### Import discipline

`src/components/**` and `app/page.tsx` may import from `@/lib/contracts` only. Use `import type` for every type. Runtime imports from `@/lib/contracts` are limited to pure constants such as `GRAPH_NODE_ORDER`. Never import `@/lib/db/client`, `@/lib/registry`, `@/lib/env`, or any `@/lib/<phase-module>` from anything in the client tree — the Mongo driver in a browser bundle is a build failure with a confusing error message, and `env.ts` fails fast on missing server secrets that the browser will never have.

## Visual Contract (transcribed from `reference.png`)

### Page frame

The page is a full-viewport column with three bands. The header sits at natural height, followed by a one-pixel divider. The main region takes the remaining height. A second one-pixel divider precedes the footer, which sits at natural height. Horizontal padding is 28px on both edges; the header, main region, and footer all align to the same left and right gutters.

Only one region in the entire page scrolls: the voice timeline's interior. The main region is a flex child with `min-h-0` so that the timeline card can be height-constrained and scroll internally. Omitting `min-h-0` on a flex child is the single most common reason an `overflow-y-auto` region grows past the viewport instead of scrolling, and it will cost you fifteen minutes if you skip it.

### Header

A single row, vertically centered, with content pushed to both ends.

On the left, a 20px recorder glyph in muted red, then a two-line block:

1. `Incident 260813-0442` — 20px, semibold, primary white. The word "Incident" and the `ref` are one string, not two styled spans.
2. `Cardiac arrest · dispatch area B3 · unit 14B` — 14px, regular, muted gray, joined by a middle dot with a space on each side. The call type is sentence-cased from `status.payload.label`; the second and third segments are the literal prefixes `dispatch area ` and `unit `, followed by `dispatchArea` and `unit`. Omit the `unit` segment and its separator entirely when `unit` is absent rather than rendering an empty tail.

On the right, the elapsed timer `04 : 42` in monospace with tabular figures, then the recording pill. The timer's colon has visible space on both sides; render minutes, separator, and seconds as three elements with a small gap rather than padding a string, so the separator never wraps or shifts.

The recording pill reads `Recording`, title case, 14px, on a dark red surface with light red text, fully rounded, with roughly 10px of horizontal and 3px of vertical padding.

### Main region

A two-column grid split 60/40 — `grid-cols-[3fr_2fr]` with a 16px gap — aligned to the top so each card sizes to its content. The left column holds one card at full band height. The right column is a vertical stack of two cards with a 12px gap, each sized to its content, which is why the right column visibly ends higher than the left card in the reference.

Below roughly 1024px the columns stack. Do not spend time beyond that one breakpoint; the target is a 1440×900 or 1920×1080 browser window on a projector, and phone layout is not a judged criterion.

### Card shell

All three cards share one shell: surface one shade lighter than the page, a one-pixel border, 12px corner radius, 18px padding, and a title in 14px medium muted gray with slightly loosened letter spacing, separated from the body by 14px. Titles are exactly `Voice timeline`, `Atlas vector search`, and `Writes this call`.

### Voice timeline entry anatomy

Entries are separated by 16px of vertical space and append at the bottom.

A voice turn is a two-column row. The left column is a fixed 44px lane holding the clock — `42:19`, monospace, 14px, muted gray, top-aligned to the first line of text. The right column holds one continuous paragraph beginning with the speaker label, then a space, then the utterance. Wrapped lines align to the start of the speaker label, not to the clock lane, producing the hanging indent visible in the reference.

The speaker label is `Agent` in blue or `Medic` in primary white, both 16px semibold. The utterance is 16px medium primary white. Label and utterance are inline within one text flow, so a long utterance wraps around the label naturally.

The four entries in the reference, verbatim:

| Clock | Speaker | Text |
|---|---|---|
| `42:19` | Agent | Dispatched as sick. Heads up, this call type in B3 reclassifies to cardiac 18% of the time overnight. |
| `43:02` | Medic | Patient unresponsive, no radial pulse, starting compressions. |
| `44:10` | Medic | Skipping the supraglottic, family says recent neck surgery. |
| `44:31` | Agent | Confirming epinephrine, 1 milligram, IV push. Say confirm. |

### Decision capture block

This sits between the `44:10` and `44:31` entries and is the visually loudest thing inside the timeline. It is the novel artifact — the reasoning no other system records — so it must not look like an ordinary turn.

It spans the card's full inner width, occupying the clock lane as well, with no timestamp. Treatment is a saturated navy surface, a 3px brighter-blue bar down the left edge, a 4px corner radius, and 10px of vertical with 14px of horizontal padding. Two stacked lines:

1. `Decision captured` — 14px medium, light blue.
2. `Airway deferred · rationale recorded · no protocol conflict` — 15px medium, lighter blue, joined by the same spaced middle dot as the header subtitle.

The second line is composed from the `decision` event payload: `actionChosen` verbatim, then `rationale recorded` when `rationaleRecorded` is true and `rationale missing` when it is false, then `no protocol conflict` when `protocolConflict` is false and `protocol conflict` when it is true. The negative phrasings are deliberate: `no protocol conflict` is a positive statement about the recording, and a block that renders nothing when a flag is false would let a judge assume the field does not exist.

### Awaiting readback pill

Below the `44:31` entry, indented to align with the speaker label rather than the clock lane. Fully rounded, dark amber surface, amber text, 14px medium, roughly 10px horizontal and 4px vertical padding, reading `Awaiting readback`.

The three readback states render as three distinct pills:

| `readback.payload.state` | Text | Treatment |
|---|---|---|
| `awaiting` | `Awaiting readback` | amber surface, amber text |
| `confirmed` | `Readback confirmed` | neutral surface, muted text |
| `rejected` | `Readback rejected — repeat` | neutral surface, stronger border, primary text |

`rejected` is deliberately not red. Red appears exactly once on this screen, in the recording pill, so that red always and only means "we are capturing." That is the claim the entire product rests on, and spending the color on an error state weakens it.

### Vector search rows

Three rows, each a flex row with the title left and the score right, 12px of vertical padding, and a hairline divider between rows but not above the first or below the last.

| Title | Score |
|---|---|
| `Incident 4471` | `0.91` |
| `Incident 2208` | `0.87` |
| `Protocol: cardiac arrest` | `0.84` |

Titles are 15px medium primary white. Scores are 15px monospace with tabular figures, right-aligned, formatted to exactly two decimals. Tabular figures matter here because these numbers change live and a proportional `1` would make the whole right edge twitch.

The title is derived from `Hit`, not stored: a hit whose `source` is `runbooks` renders `Protocol: ` followed by `title`; any other source renders `Incident ` followed by `displayId`, falling back to `title` when `displayId` is null. Truncate to one line with an ellipsis.

### Nested retrieved snippet

Directly below the third row, inset within the card: a surface one shade lighter than the card, 8px radius, 12px padding, and 15px text in a brighter muted gray than the card title. Exactly one hit is expanded. The text in the reference is `Prior run: nearest facility was on diversion, 11 minutes lost. Route to the second closest.`, with `Prior run:` in semibold as a label prefix and the rest regular.

The label prefix is a UI convention keyed on `source`: `Prior run:` for `decisions` and `postmortems`, `Protocol:` for `runbooks`. The body is `Hit.text`, which the contract describes as the full snippet intended for exactly this card. Clamp to four lines.

Choose the expanded hit as the one with the highest `rrf`, breaking ties by array order. Do not expand the highest `score`; scores come from different collections and are not comparable across sources, which is the entire reason `rrf` exists.

### Write counter tiles

A two-column grid with a 12px gap. Each tile has its own surface one shade lighter than the card, a one-pixel border, 8px radius, and 12px of padding, containing a 14px regular muted label above a 28px semibold primary-white value with tabular figures.

The reference shows `decisions` at `7` and `timeline` at `34`. Render tiles in the fixed order `decisions`, `timeline`, `postmortems`, `remediations`, `events`, showing only buckets that have actually appeared, and cap the display at four tiles. Dropping a fifth tile is strictly better than letting this card grow mid-demo and push the footer off a projector.

### Footer node chain

A single row, content pushed to both ends.

On the left, the label `Graph` in 14px muted gray, then four pills separated by a chevron glyph in a dim gray, all with 8px gaps. Pills are fully rounded, 14px medium, with roughly 12px horizontal and 5px vertical padding. Inactive pills are transparent with a one-pixel gray border and light gray text. The active pill has amber text, an amber-tinted border, and a faint amber surface.

The four pills read `triage`, `recall`, `readback gate`, and `record`, in that order. These are display stages, not `GraphNode` values, and the mapping must cover all ten nodes so no arriving node lights nothing:

| Pill | `GraphNode` values it covers |
|---|---|
| `triage` | `triage` |
| `recall` | `signature_match`, `brief`, `plan` |
| `readback gate` | `readback_gate` |
| `record` | `execute_record`, `verify`, `record_decision`, `await_input`, `postmortem` |

Assert at module scope that the union of the four stages equals `GRAPH_NODE_ORDER`. Report a mismatch with a development-only `console.error` and render no active pill; do not throw. A thrown error in a client component blanks the whole screen, and a screen with no amber pill is recoverable on stage while a blank one is not.

On the right, a 16px green document-with-check glyph, then `checkpoint 34` in green: the word at 15px medium and the numeral at 17px bold with tabular figures.

**The checkpoint counter is the single most important pixel on this screen.** The presenter points at it and reads the number out loud immediately before killing the process in front of the judges, then points at it again after the restart. Keep the reference's exact position, color, and wording, but make the numeral heavier and two pixels larger than the label, and flash a 400ms ring around the counter whenever the value changes so an increment is impossible to miss from six meters. Suppress the flash under `prefers-reduced-motion`; the number still changes, which is what actually matters.

### Color tokens

Values transcribed from `reference.png`. Match within a shade; do not substitute a Tailwind palette default that is visibly off.

| Token | Hex | Used for |
|---|---|---|
| `--bb-bg` | `#0A0A0B` | page background |
| `--bb-surface` | `#101013` | card surfaces |
| `--bb-surface-2` | `#17171B` | retrieved snippet, counter tiles |
| `--bb-border` | `#1F1F23` | card borders, header and footer dividers, row hairlines |
| `--bb-border-strong` | `#2A2A30` | inactive graph pills, scrollbar thumb |
| `--bb-text` | `#F4F4F5` | utterances, medic label, hit titles, counter values |
| `--bb-muted` | `#8A8A93` | card titles, clocks, header subtitle, tile labels, `Graph`, chevrons |
| `--bb-muted-bright` | `#A1A1AA` | retrieved snippet body |
| `--bb-blue` | `#60A5FA` | the `Agent` speaker label |
| `--bb-blue-accent` | `#3B82F6` | decision block left bar |
| `--bb-blue-surface` | `#1E3A8A` | decision block background |
| `--bb-blue-label` | `#93C5FD` | `Decision captured` |
| `--bb-blue-text` | `#BFDBFE` | decision block body line |
| `--bb-amber` | `#FBBF24` | awaiting-readback text, active node text |
| `--bb-amber-surface` | `#3B2A08` | awaiting pill, active node pill |
| `--bb-amber-border` | `#7C5410` | active node pill border |
| `--bb-green` | `#4ADE80` | checkpoint glyph, label, and numeral |
| `--bb-red-surface` | `#7F1D1D` | recording pill background |
| `--bb-red-text` | `#FEE2E2` | recording pill text |
| `--bb-red-glyph` | `#E06C5C` | header recorder glyph |

### Typography

Sans for everything except the four monospace cases: turn clocks, the elapsed timer, similarity scores, and the checkpoint numeral. Use whatever font PHASE-01's scaffold wired up. **Do not add a webfont fetch.** A font that downloads at first paint is a font that fails on conference wifi, and the system stack renders this layout correctly.

| Element | Size | Weight | Family |
|---|---|---|---|
| Incident title | 20px | 600 | sans |
| Header subtitle | 14px | 400 | sans |
| Elapsed timer | 15px | 500 | mono, tabular |
| Recording pill | 14px | 500 | sans |
| Card title | 14px | 500 | sans |
| Turn clock | 14px | 400 | mono, tabular |
| Speaker label | 16px | 600 | sans |
| Utterance | 16px | 500 | sans |
| Decision label | 14px | 500 | sans |
| Decision body | 15px | 500 | sans |
| Readback pill | 14px | 500 | sans |
| Hit title | 15px | 500 | sans |
| Hit score | 15px | 400 | mono, tabular |
| Snippet | 15px | 400 (label 600) | sans |
| Tile label | 14px | 400 | sans |
| Tile value | 28px | 600 | sans, tabular |
| Graph label and pills | 14px | 500 | sans |
| Checkpoint label / numeral | 15px / 17px | 500 / 700 | sans, tabular |

**Nothing on this screen renders below 14px, with no exceptions.** This is a projector viewed from six meters, and every string in the table above is something a judge is expected to read. Never place thin light-gray type on the dark surface for load-bearing content; `--bb-muted` is the floor and it is reserved for labels, not values.

## Design Constraints

Keep it calm. Emergency dashboards pull hard toward flashing red, sirens, and pulsing alerts, and every one of those reads as theater to a judge who has seen four demos already. A clean recorder readout reads as a product. The only motion on the entire screen is the elapsed timer advancing, values changing in place, new entries appending, and the 400ms checkpoint flash.

New entries append at the bottom and the timeline auto-scrolls to follow them, **but auto-scroll must pause the moment the operator scrolls up.** Without that, pointing at something on stage is impossible: the presenter scrolls back to the decision block, an event arrives, and the view yanks away mid-sentence. Re-pin when the operator scrolls back to within 48px of the bottom. Add no scroll-to-latest button; it is not in the reference and manual scrolling is sufficient.

The events are a discriminated union, so **reduce them with an exhaustive switch**. In the default branch, assign the narrowed event to a `never`-typed local so that adding a `kind` to the contract becomes a compile error rather than a frame the dashboard silently drops. At runtime that branch must return the view unchanged and increment a counter, never throw.

Say out loud in the pitch that the medic never looks at a screen. This dashboard is a window into the black box for the benefit of judges, not the product. Every design decision here optimizes for legibility from the audience, which is why the layout is fixed, the type is large, and there is nothing interactive on it.

## Files to Create

Fifteen files. Build order is at the end of this section.

### `src/components/view-state.ts` (US-028)

The pure reducer. No React, no DOM, no network — which is what makes it the one part of this phase that is trivially verifiable from a `tsx` one-liner.

```ts
import type { BlackboxEvent, GraphNode, Hit, IncidentStatus } from "@/lib/contracts";

export interface VoiceTurn {
  seq: number;
  speaker: "medic" | "agent";
  text: string;
  clock: string;
}

export interface DecisionCapture {
  seq: number;
  decisionId: string;
  actionChosen: string;
  rationaleRecorded: boolean;
  protocolConflict: boolean;
}

/** Turns and decisions interleave in one ordered list; `seq` is the ordering key. */
export type TimelineItem =
  | { type: "turn"; seq: number; turn: VoiceTurn }
  | { type: "decision"; seq: number; decision: DecisionCapture };

export interface ReadbackView {
  state: "awaiting" | "confirmed" | "rejected";
  readbackText: string;
  /** seq of the newest timeline item when this readback arrived; the pill renders after it. */
  afterSeq: number;
}

export interface HeaderView {
  ref: string | null;
  label: string | null;
  dispatchArea: string | null;
  unit: string | null;
  status: IncidentStatus | null;
  /** Anchor for the elapsed timer. See Contract Gaps — §8 has no start-time field. */
  startedAtMs: number | null;
}

export interface RetrievalView {
  query: string;
  hits: Hit[];
  /** docId of the hit rendered as the expanded snippet: highest rrf, ties by array order. */
  primaryDocId: string | null;
}

export interface DashboardView {
  header: HeaderView;
  timeline: TimelineItem[];
  readback: ReadbackView | null;
  retrieval: RetrievalView | null;
  writes: Record<string, number>;
  checkpointCount: number;
  activeNode: GraphNode | null;
  pcrPreview: string | null;
  /** Highest seq applied, keyed by `incidentId ?? "__global"`. Drives replay dedupe. */
  appliedSeq: Record<string, number>;
  gapCount: number;
  unknownKindCount: number;
}

export const EMPTY_VIEW: DashboardView;

/** Idempotent. Applying the same event twice is a no-op. Returns the same object when skipped. */
export function reduceEvent(view: DashboardView, e: BlackboxEvent): DashboardView;

export function reduceAll(events: readonly BlackboxEvent[]): DashboardView;

/** Revives `t` into a Date and shape-checks `kind`. Returns null on malformed input. */
export function parseEvent(raw: unknown): BlackboxEvent | null;
```

Per-kind reduction rules, all of which exist to survive the SSE replay frame described in `contracts.md` §10:

- `status` — replaces the header fields. Sets `startedAtMs` from the event's `t` only if it is still null, so the first status event seen wins and a later one during the same call does not restart the clock.
- `node` — sets `activeNode` on `phase: "enter"`; clears it on `phase: "exit"` only when the exiting node is the currently active one. Without that guard, an out-of-order exit clears a node that has already advanced and the footer goes dark.
- `voice` — appends a `turn` item.
- `decision` — appends a `decision` item.
- `readback` — replaces `readback` and records `afterSeq` as the newest timeline item's seq, or `-1` when the timeline is empty.
- `retrieval` — replaces `retrieval` and recomputes `primaryDocId`.
- `write` — **treats `count` as the absolute total for that bucket, not a delta.** Last write wins. A delta would double-count every event in the 200-event replay frame on every browser reload, and the write counters are the numbers the presenter points at.
- `checkpoint` — sets `checkpointCount` to `Math.max(previous, payload.count)`. It must never decrease, because the presenter has already read the old number aloud.
- `pcr` — stores `preview`.
- default — assign to a `never` local for compile-time exhaustiveness, increment `unknownKindCount`, return the view unchanged.

Dedupe and gap detection both live here, keyed by `incidentId ?? "__global"` because `contracts.md` §8 makes `seq` monotonic per incident and allows a null `incidentId`. Skip any event whose `seq` is less than or equal to the applied high-water mark. Increment `gapCount` when an accepted `seq` exceeds the mark by more than one.

### `src/components/format.ts` (US-027)

Pure formatting and the node-to-stage mapping. No React.

```ts
import type { GraphNode, Hit } from "@/lib/contracts";

/** Returns null when the anchor is unknown, so the caller can render "-- : --". */
export function formatElapsed(
  startedAtMs: number | null,
  nowMs: number,
): { mm: string; ss: string } | null;

/** Exactly two decimals, e.g. 0.9 -> "0.90". */
export function formatScore(score: number): string;

/** "Incident 4471" | "Protocol: cardiac arrest" */
export function hitTitle(hit: Hit): string;

/** "Prior run:" for decisions and postmortems, "Protocol:" for runbooks. */
export function snippetLabel(hit: Hit): string;

/** "Cardiac arrest" from "cardiac arrest". First letter only; the rest is left alone. */
export function sentenceCase(s: string): string;

export interface GraphStage {
  id: "triage" | "recall" | "readback_gate" | "record";
  label: string;
  nodes: readonly GraphNode[];
}

export const GRAPH_STAGES: readonly GraphStage[];

export function activeStageId(node: GraphNode | null): GraphStage["id"] | null;

export const DOT = " \u00b7 ";
```

`formatElapsed` returns null rather than `00 : 00` when there is no anchor. A timer reading zero during a live call looks like the dashboard is dead; `-- : --` reads as "not started yet," which is the truth.

### `src/components/fixture-source.ts` (US-027)

The zero-network event source.

```ts
import type { BlackboxEvent } from "@/lib/contracts";

export interface FixturePlayerOptions {
  events: readonly BlackboxEvent[];
  /** 0 applies every event synchronously (the reference.png state). 1 spaces them 250ms apart. */
  speed: 0 | 1;
  onEvent: (e: BlackboxEvent) => void;
}

export interface FixturePlayer {
  start(): void;
  stop(): void;
}

export function createFixturePlayer(o: FixturePlayerOptions): FixturePlayer;

/** Statically bundled. Never fetched, so it works offline in a production build. */
export function loadFixtureEvents(): BlackboxEvent[];

/** Last-resort minimum so the dashboard is never blank. Not the primary source. */
export const FALLBACK_EVENTS: readonly BlackboxEvent[];
```

`loadFixtureEvents` uses a static `import raw from "../../fixtures/event-stream.json"`, types it as `unknown`, and maps it through `parseEvent`, dropping anything malformed. A static import is required rather than a `fetch`: `fixtures/` is not `public/`, this phase does not own `public/**`, and bundling the fixture at build time is exactly what makes fixture mode survive a dead network. JSON gives `t` as an ISO string while `BlackboxEvent.t` is a `Date`, so the revival step in `parseEvent` is mandatory and not optional cleanup.

`FALLBACK_EVENTS` is roughly twelve hand-written events reproducing the reference state, used only when the fixture file is missing or yields zero valid events. It exists for two reasons: this phase can start the minute PHASE-01's typecheck passes, without waiting for the fixture's contents to be finalized, and the dashboard can never render an empty shell on stage. It must never become the primary source — when the fixture file parses, it wins.

Default `speed` is `0`. The pixel comparison against `reference.png` needs a deterministic final state, and a timed replay would make the screenshot a race. `?replay=1` selects `speed: 1` for dress rehearsals where motion is the point.

### `src/components/use-event-stream.ts` (US-028)

```ts
import type { DashboardView } from "./view-state";

export type ConnectionState =
  | "idle" | "fixture" | "connecting" | "open" | "reconnecting";

export interface EventStreamOptions {
  incidentId: string | null;
  mode: "real" | "fixture";
  replay: boolean;
}

export interface EventStreamResult {
  view: DashboardView;
  connection: ConnectionState;
  reconnectAttempts: number;
  lastEventAtMs: number | null;
}

export function useEventStream(o: EventStreamOptions): EventStreamResult;
```

Fixture mode drives `createFixturePlayer` and reports `connection: "fixture"`. No `EventSource`, no `fetch`, no timers beyond the optional replay pacing.

Real mode does three things, in this order:

1. Bootstraps counters with `GET /api/counters`, mapping `counts` into `writes` and `checkpointCount` into the view. The counters endpoint is authoritative for totals, so this is what makes a mid-call browser reload come back with correct numbers instead of whatever the 200-event replay window happens to still contain.
2. Opens `new EventSource("/api/events?incidentId=" + encodeURIComponent(incidentId))`, parses each `MessageEvent.data` through `parseEvent`, and reduces it.
3. On `error`, closes the source and reconnects with backoff.

**Reconnection is the requirement that matters most in this file.** The dashboard gets reloaded and the dev server gets killed repeatedly during rehearsal, and the mid-demo kill-and-resume beat depends on this screen refilling by itself. Four rules:

- **Never clear the view on reconnect.** Keep the last-known state and merge the incoming replay frame. The reducer's dedupe by `seq` makes re-applying the replay a no-op, which is the whole reason it is idempotent.
- **Never stop retrying.** Backoff is 1s, 2s, 4s, 8s, then a 10s ceiling with a small random jitter, forever. Report `reconnecting` while waiting. An attempt cap means the one time the operator restarts the dev server during a two-minute Q&A, the screen is permanently stale.
- **Do not rely on `EventSource`'s built-in retry.** It retries on a clean connection close but not on every failure mode, and it gives you no attempt count to display. Close and re-create explicitly.
- **Re-bootstrap counters after any reconnect that detected a gap.** A missed `write` event would otherwise leave a counter wrong for the rest of the call, and re-reading `/api/counters` is a cheap and total repair. Do not try to backfill individual events.

Everything here is browser-only. Guard the `EventSource` construction inside `useEffect` and clean up both the source and the pending backoff timer on unmount, or a fast refresh in dev leaves a growing pile of open connections against the SSE route.

### `src/components/ui.tsx` (US-027)

Shared primitives and both inline SVG glyphs.

```tsx
import type { ReactNode } from "react";

export interface CardProps { title: string; children: ReactNode; className?: string }
export function Card(p: CardProps): React.JSX.Element;

export interface PillProps {
  tone: "red" | "amber" | "neutral" | "neutral-strong";
  children: ReactNode;
}
export function Pill(p: PillProps): React.JSX.Element;

export function SectionLabel(p: { children: ReactNode }): React.JSX.Element;
export function RecorderGlyph(p: { className?: string }): React.JSX.Element;
export function CheckpointGlyph(p: { className?: string }): React.JSX.Element;
export function ChevronGlyph(p: { className?: string }): React.JSX.Element;
export function EmptyLine(p: { children: ReactNode }): React.JSX.Element;
```

React 19 removed the global `JSX` namespace, so annotate returns as `React.JSX.Element` or `ReactElement`. A bare `JSX.Element` will not compile.

`EmptyLine` renders one muted 14px line inside a card that has no data yet. Every card needs an empty state even though `reference.png` shows none, because in real mode the first twenty seconds of the demo are nothing but empty states, and a card that renders as a floating title with a void beneath it reads as a bug from the audience.

### `src/components/header-bar.tsx` (US-027)

```tsx
import type { HeaderView } from "./view-state";

export interface HeaderBarProps {
  header: HeaderView;
  recording: boolean;
  nowMs: number;
}
export function HeaderBar(p: HeaderBarProps): React.JSX.Element;
```

`recording` is computed by the caller as `header.status !== null && header.status !== "closed"`. This is a UI inference, not an event: §8 has no signal for "audio capture is live." See Contract Gaps.

When `header.ref` is null, render `Incident ——` and an empty subtitle rather than collapsing the header, so the layout does not jump when the first `status` event lands.

### `src/components/voice-timeline.tsx` (US-027)

```tsx
import type { ReadbackView, TimelineItem, VoiceTurn, DecisionCapture } from "./view-state";

export interface VoiceTimelineProps {
  items: readonly TimelineItem[];
  readback: ReadbackView | null;
}
export function VoiceTimeline(p: VoiceTimelineProps): React.JSX.Element;

export function TimelineTurn(p: { turn: VoiceTurn }): React.JSX.Element;
export function DecisionBlock(p: { decision: DecisionCapture }): React.JSX.Element;
export function ReadbackPill(p: {
  state: ReadbackView["state"];
  readbackText: string;
}): React.JSX.Element;

/** Returns the ref to attach to the scroll container. Pins within 48px of the bottom. */
export function useAutoScroll(dep: unknown): React.RefObject<HTMLDivElement | null>;
```

`useAutoScroll` keeps a `pinned` flag in a ref, recomputed on every `scroll` event as `scrollHeight - scrollTop - clientHeight < 48`. When `dep` changes and `pinned` is true, set `scrollTop = scrollHeight` directly. Use instant positioning, not smooth behavior — smooth scrolling fights itself during a burst of events and produces visible stutter.

Render the readback pill immediately after the item whose `seq` equals `readback.afterSeq`, and at the end of the list when `afterSeq` matches nothing. The fallback matters: `afterSeq` is a UI-side inference because the readback payload carries no link to the turn it belongs to, and a pill that vanishes because its anchor scrolled out of the replay window would remove the amber state the kill-and-resume beat depends on.

### `src/components/vector-search-card.tsx` (US-027)

```tsx
import type { Hit } from "@/lib/contracts";
import type { RetrievalView } from "./view-state";

export function VectorSearchCard(p: { retrieval: RetrievalView | null }): React.JSX.Element;
export function HitRow(p: { hit: Hit; showDivider: boolean }): React.JSX.Element;
export function RetrievedSnippet(p: { hit: Hit }): React.JSX.Element;
```

Render at most three rows, matching the reference. Empty state: `No retrieval yet`.

### `src/components/write-counters.tsx` (US-027)

```tsx
export const WRITE_ORDER = ["decisions", "timeline", "postmortems", "remediations", "events"] as const;
export const MAX_TILES = 4;

export function WriteCounters(p: { writes: Record<string, number> }): React.JSX.Element;
export function CounterTile(p: { label: string; value: number }): React.JSX.Element;
```

Note that `timeline` is not a MongoDB collection — timeline entries live in an array inside `incidents`. It appears here because `reference.png` shows it, which means `write.payload.collection` is a display bucket rather than strictly a collection name. See Contract Gaps. Practical consequence: the `/api/counters` bootstrap will not produce a `timeline` key, only `write` events will, so both sources must merge into the same record without either clobbering the other.

Empty state: `No writes yet`.

### `src/components/graph-footer.tsx` (US-027)

```tsx
import type { GraphNode } from "@/lib/contracts";

export interface GraphFooterProps {
  activeNode: GraphNode | null;
  checkpointCount: number;
}
export function GraphFooter(p: GraphFooterProps): React.JSX.Element;

export function CheckpointCounter(p: { count: number }): React.JSX.Element;
```

`CheckpointCounter` holds the previous count in a ref, and when it changes, applies a CSS class for 400ms that draws a green ring. Read `window.matchMedia("(prefers-reduced-motion: reduce)")` and skip the class when it matches.

### `src/components/dashboard.tsx` (US-027, US-028)

The single client boundary.

```tsx
"use client";

export interface DashboardProps {
  incidentId: string | null;
  mode: "real" | "fixture";
  replay: boolean;
}
export function Dashboard(p: DashboardProps): React.JSX.Element;
```

Only this file needs `"use client"`; the boundary is transitive, so adding the directive to the other twelve component files is noise. It owns exactly one `setInterval` at one-second resolution feeding `nowMs` to the header, so the elapsed timer costs one re-render per second for the whole tree rather than one timer per component.

It assembles the frame described in the Visual Contract: header, divider, the 60/40 main grid, divider, footer.

### `app/page.tsx` (US-027)

Server component. Resolves mode and incident id, then renders `<Dashboard />`.

```tsx
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ incidentId?: string; mode?: string; replay?: string }>;
}): Promise<React.JSX.Element>;
```

**Next.js 16 makes `searchParams` a Promise.** Await it. Reading it synchronously is the first thing that will break, and the error message points at React internals rather than at this line.

Mode resolution, in precedence order: a `?mode=fixture` or `?mode=real` query parameter, then `process.env.NEXT_PUBLIC_EVENTS_MODE === "fixture"`, defaulting to `real`.

The query parameter override is not a convenience. `NEXT_PUBLIC_*` values are inlined at build time, so flipping the env var in a production build requires a rebuild — which is not something anyone is doing on stage. With the override, recovering from a dead backend mid-pitch is appending eight characters to the URL and pressing Enter.

### `app/layout.tsx` (US-027)

Root layout. `metadata` with a title of `BlackBox`, `lang="en"`, a dark `colorScheme` so scrollbars and form controls render dark, and the base background and text classes on `body`. Nothing else. PHASE-13 renders `app/voice/**` inside this layout and must not inherit a dashboard viewport lock.

### `app/globals.css` (US-027)

Tailwind directives, the `--bb-*` custom properties from the color table under `:root`, base resets, a `bb-scroll` utility giving the timeline a 6px `--bb-border-strong` scrollbar thumb, and the `bb-checkpoint-flash` keyframes.

Define the palette as CSS custom properties and have `tailwind.config.ts` reference them. That way the tokens behave identically whether PHASE-01's scaffold installed Tailwind v3 with a JS config or v4 with CSS-first `@theme`, and you do not lose ten minutes discovering which one you have.

### `tailwind.config.ts` (US-027)

Content globs covering `./app/**/*.{ts,tsx}` and `./src/**/*.{ts,tsx}`, colors mapped to the `--bb-*` variables, and the sans and mono font families. Nothing else; there is no plugin worth its install time here.

### Build order and what to cut

Work in this order so that the pixel-checkable result exists early: `format.ts`, `view-state.ts`, `globals.css` plus `tailwind.config.ts`, `ui.tsx`, `layout.tsx`, `fixture-source.ts`, the four presentational components, `dashboard.tsx`, `page.tsx`, and `use-event-stream.ts` last.

Real mode is deliberately last because fixture mode is what the acceptance criteria and the pitch insurance both depend on. If the budget runs out with `use-event-stream.ts` half-written, you still have a dashboard that renders the reference state.

If you are behind at the sixty-minute mark, in this order: collapse `TimelineTurn`, `DecisionBlock`, and `ReadbackPill` into `voice-timeline.tsx` and `HitRow` and `RetrievedSnippet` into `vector-search-card.tsx`, which is a file-count reduction with no behavior change since this phase owns all of them; drop the sub-1024px stacking; and drop `FALLBACK_EVENTS` if PHASE-01's fixture has already landed and parses. Do not cut the exhaustive switch, the reconnect backoff, the auto-scroll pause, or the checkpoint flash.

## Acceptance Criteria

Everything above the divider is checkable with **no database, no worker, no API route, and no network**, using only `NEXT_PUBLIC_EVENTS_MODE=fixture`.

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] `git diff --exit-code package.json` is clean — this phase added no dependency
- [ ] `npm run build` with the network disabled succeeds, proving no webfont or remote asset is fetched at build time
- [ ] With `NEXT_PUBLIC_EVENTS_MODE=fixture` and nothing else running, `/` renders the header text `Incident 260813-0442`
- [ ] The header subtitle renders `Cardiac arrest · dispatch area B3 · unit 14B` with spaced middle dots
- [ ] The header shows a `Recording` pill on a dark red surface, and it is the only red element on the page
- [ ] The elapsed timer renders as `mm : ss` in a monospace tabular face with visible space around the separator, and renders `-- : --` when no anchor is known
- [ ] All four voice turns render, in order, with clocks `42:19`, `43:02`, `44:10`, `44:31`
- [ ] `Agent` renders in blue and `Medic` in primary white, both inline with the utterance, and a wrapped utterance's second line aligns to the speaker label rather than the clock lane
- [ ] The decision block renders between the `44:10` and `44:31` turns, spans the card's full inner width including the clock lane, has a blue left bar, and reads `Decision captured` above `Airway deferred · rationale recorded · no protocol conflict`
- [ ] An amber `Awaiting readback` pill renders below the `44:31` turn, indented to the speaker label
- [ ] The vector search card renders exactly three rows reading `Incident 4471`, `Incident 2208`, and `Protocol: cardiac arrest`, with right-aligned monospace scores `0.91`, `0.87`, `0.84`
- [ ] Exactly one nested snippet card renders below the rows, containing `Prior run:` in semibold followed by the diversion text
- [ ] Two counter tiles render, `decisions` at `7` and `timeline` at `34`, values in a tabular face at 28px
- [ ] The footer renders `Graph` followed by the four pills `triage`, `recall`, `readback gate`, `record` separated by chevrons, with `readback gate` in amber and the other three in neutral gray
- [ ] The footer renders `checkpoint 34` in green with the numeral heavier and larger than the label
- [ ] Incrementing the checkpoint count in a browser console or fixture edit produces a visible 400ms ring flash, and no flash when `prefers-reduced-motion: reduce` is emulated
- [ ] No rendered text is below 14px: `rg "text-xs|text-\[1[0-3]px\]" app src/components` returns no matches
- [ ] The two-column split is 60/40 and only the voice timeline's interior scrolls; the page itself does not scroll at 1440×900
- [ ] Scrolling the timeline up and then appending an event leaves the scroll position unchanged; scrolling back to the bottom re-enables following
- [ ] Every card renders a muted empty-state line rather than a bare title when its data is absent
- [ ] `reduceAll` is exhaustive: deleting one `case` from the switch produces a `tsc` error, and an event with an unrecognized `kind` returns the view unchanged without throwing
- [ ] `reduceAll(events)` and `reduceAll([...events, ...events])` produce identical `writes` and `checkpointCount`, proving replay idempotence
- [ ] A `checkpoint` event with a lower count than the current value does not decrease `checkpointCount`
- [ ] `GRAPH_STAGES` covers every value in `GRAPH_NODE_ORDER`, verified by an assertion, and an unmapped node renders no active pill instead of throwing
- [ ] `app/layout.tsx` contains no dashboard layout: `rg "grid|h-dvh|overflow-hidden" app/layout.tsx` returns no matches
- [ ] Nothing under `src/components/` or in `app/page.tsx` imports `@/lib/db/client`, `@/lib/registry`, or `@/lib/env`
- [ ] `?mode=fixture` renders fixture data even when `NEXT_PUBLIC_EVENTS_MODE=real`, and `?mode=real` does the reverse

With the API available (PHASE-10 and PHASE-11 landed):

- [ ] With `NEXT_PUBLIC_EVENTS_MODE=real`, the dashboard bootstraps counters from `GET /api/counters` and then applies live events from `GET /api/events`
- [ ] Killing the SSE producer and restarting it reconnects without the view ever going blank, and `reconnectAttempts` increments
- [ ] A full browser reload mid-call restores the header, timeline, counters, active node, and checkpoint count
- [ ] Backoff intervals are approximately 1s, 2s, 4s, 8s, then capped near 10s, and retrying never stops

## Verification

### Static, no backend

```bash
npm run typecheck
npm run build
git diff --exit-code package.json

# Exhaustiveness, idempotence, and the checkpoint monotonic guard.
npx tsx -e "
import { reduceAll, parseEvent, EMPTY_VIEW, reduceEvent } from './src/components/view-state';
import raw from './fixtures/event-stream.json';
const evs = (raw as unknown[]).map(parseEvent).filter(Boolean) as any[];
console.log('parsed', evs.length, 'of', (raw as unknown[]).length);
const once = reduceAll(evs), twice = reduceAll([...evs, ...evs]);
console.log('writes idempotent', JSON.stringify(once.writes) === JSON.stringify(twice.writes));
console.log('checkpoints idempotent', once.checkpointCount === twice.checkpointCount);
console.log('turns', once.timeline.filter(i => i.type === 'turn').length);
console.log('decisions', once.timeline.filter(i => i.type === 'decision').length);
console.log('activeNode', once.activeNode, 'checkpoint', once.checkpointCount);
console.log('readback', once.readback?.state, 'hits', once.retrieval?.hits.length);
const back = reduceEvent(once, { kind: 'checkpoint', seq: 999, incidentId: null, t: new Date(), payload: { count: 1 } } as any);
console.log('never decreases', back.checkpointCount === once.checkpointCount);
console.log('unknown kind survives', reduceEvent(once, { kind: 'nope', seq: 1000, incidentId: null, t: new Date(), payload: {} } as any).timeline.length === once.timeline.length);
"

# Stage mapping covers all ten contract nodes.
npx tsx -e "
import { GRAPH_STAGES } from './src/components/format';
import { GRAPH_NODE_ORDER } from './src/lib/contracts';
const mapped = new Set(GRAPH_STAGES.flatMap(s => s.nodes));
console.log('unmapped', GRAPH_NODE_ORDER.filter(n => !mapped.has(n)));
"

# No sub-14px type, and no server-only imports in the client tree.
rg "text-xs|text-\[1[0-3]px\]" app src/components
rg "@/lib/(db|registry|env)" app/page.tsx src/components
rg "grid|h-dvh|overflow-hidden" app/layout.tsx
```

The three `rg` commands must all return nothing.

```bash
# The demo-insurance path: a production build serving the reference state offline.
NEXT_PUBLIC_EVENTS_MODE=fixture npm run build
NEXT_PUBLIC_EVENTS_MODE=fixture npm start
# Then disconnect the network and reload http://localhost:3000/ — the page must be unchanged.
```

### Manual visual check against `reference.png`

Open `reference.png` and `http://localhost:3000/?mode=fixture` side by side in a 1440×900 window and confirm each item. Do not skip this; the acceptance criteria catch missing content but not wrong proportions.

1. Page background is near-black and card surfaces are visibly but only slightly lighter, with a one-pixel border on each card.
2. The header divider and the footer divider are both present and the same weight.
3. The recorder glyph sits left of the incident title and is muted red.
4. The left card is visibly wider than the right column at roughly a 3:2 ratio, and the right column's lower card ends higher than the left card's bottom edge.
5. Card titles are muted gray, not white.
6. Clock lane width is constant across all four turns and the clocks are monospace.
7. The first turn wraps to a second line that starts under `Agent`, not under `42:19`.
8. The decision block is the loudest element inside the timeline and carries no timestamp.
9. The `Awaiting readback` pill is amber and is the only amber element inside the left card.
10. Vector search scores are right-aligned on a single vertical edge.
11. Hairline dividers separate the three hit rows but do not appear above the first or below the last.
12. The nested snippet is inset with its own lighter surface, distinguishable from the card it sits in.
13. Both counter tiles have their own border and the numerals dominate their labels.
14. The active footer pill is amber and the other three are neutral, with chevrons dimmer than the pill text.
15. The checkpoint indicator is green, sits at the far right of the footer, and is legible from across the room — stand up and walk six meters back to check this one specifically.

### Interaction checks

```bash
NEXT_PUBLIC_EVENTS_MODE=fixture npm run dev
# 1. Load /?mode=fixture&replay=1 and confirm entries append at the bottom over ~3 seconds.
# 2. Scroll the timeline up mid-replay; confirm it does not yank back down.
# 3. Scroll to the bottom; confirm following resumes.
# 4. Emulate prefers-reduced-motion in devtools and confirm the checkpoint flash is gone
#    while the number still updates.
# 5. Resize to 1920x1080 and confirm the page still does not scroll.
```

With PHASE-10 running:

```bash
NEXT_PUBLIC_EVENTS_MODE=real npm run dev
# 1. Load /?incidentId=<id>; confirm counters populate before any event arrives.
# 2. Kill the dev server; confirm the view stays populated and shows a reconnecting state.
# 3. Restart it; confirm the view refills with no reload and no blank frame.
# 4. Hard-reload the browser mid-call; confirm the full state returns.
```

Step 3 is the one that matters. It is the same mechanic as the kill-and-resume beat in PHASE-15, and the presenter will do it in front of judges.

## Contract Gaps (report these; do not fix them here)

`reference.png` shows several things that `contracts.md` §8 cannot express. Each is handled locally in this phase with the stated inference, and each needs a one-line clarification in the contract rather than a workaround that quietly diverges from what PHASE-10 and PHASE-11 emit.

1. **No call start time.** The header's elapsed timer has no source field. `status.payload` carries `status`, `ref`, `label`, `dispatchArea`, and `unit`, but no `startedAt`. This phase anchors on the `t` of the first `status` event it sees, which breaks after a reload once the 200-event replay window has rolled past that event. A `startedAt` field in the `status` payload would fix it outright. Note also that the reference's header reads `04 : 42` while its newest turn clock reads `44:31`; those are independent values and neither derives from the other.
2. **No recording state.** Nothing expresses "audio capture is live." This phase infers it from `status !== "closed"`, which conflates the incident lifecycle with the voice session — the pill would stay lit if the ElevenLabs connection dropped mid-call.
3. **`write.payload.count` semantics are undefined.** Absolute total or delta is unspecified, and this phase must assume absolute to stay idempotent under the replay frame. If PHASE-10 emits deltas, every counter double-counts on every reload. This is the highest-consequence gap in the list because those counters are what the presenter points at.
4. **`write.payload.collection` is not a collection name.** The reference shows a `timeline` tile, and there is no `timeline` collection — timeline entries are an array inside `incidents`. The field is really a display bucket, which also means the `/api/counters` bootstrap and the `write` event stream produce different key sets that have to be merged.
5. **No node display labels or stage grouping.** `GRAPH_NODE_ORDER` has ten entries; the footer shows four pills reading `triage`, `recall`, `readback gate`, and `record`. Both the grouping and the human labels are invented here. `CODE_LABELS` exists for call types for exactly this reason, and a `GRAPH_NODE_LABELS` plus stage grouping belongs beside it in §4.
6. **`readback` has no link to the turn it belongs to.** The reference pins the pill under the `44:31` agent turn, and the payload carries only `state` and `readbackText`. This phase infers the anchor as the newest timeline item at reduce time, which is wrong if events arrive out of order. An `afterSeq` or a turn id in the payload would make it exact.
7. **Which score to display is ambiguous.** `Hit` carries both `score` and `rrf`, and the reference shows one number per row. This phase renders `score` because it is described as the raw per-collection score, and separately uses `rrf` to pick the expanded snippet. Nothing in the contract says which one belongs on screen.
8. **No primary-hit marker.** `retrieval.payload.hits` is a flat array with nothing indicating which hit gets expanded into the nested snippet card. This phase picks the highest `rrf`.
9. **Row and snippet prefixes are not fields.** `Incident `, `Protocol: `, and `Prior run:` are all derived from `Hit.source` by this phase. They are spoken and displayed strings, so like `CODE_LABELS` they arguably belong in the contract rather than in a component.
10. **Connection state has no representation,** which is correct — it is local UI state — but worth stating so that no one later tries to emit an event for it. The dashboard's `reconnecting` indicator is intentionally invisible in the reference layout.

## Handoff Note

The moment fixture mode renders the reference state, tell PHASE-15. That is the point at which the pitch has a guaranteed visual regardless of what happens to the backend, and it changes what the run of show can safely promise.
