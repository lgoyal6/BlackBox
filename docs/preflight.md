# Preflight — T-minus 20 minutes

Run in this order. One person owns the go/no-go call; see the bottom of this file.

Start with the automated block as a single command:

```powershell
npm run preflight
```

It exits `0` on `GO` and `1` on `NO-GO`. `WARN` and `SKIP` do not fail the run.
Re-check a single item after a fix with `--only=<id>`, e.g. `npm run preflight -- --only=tunnel`.

## The eleven checks

These are exactly the eleven entries in `CHECKS` in `scripts/demo-preflight.ts`. **The two
lists must stay the same length** — if you add a check to the script, add a row here, so
nothing falls between the two.

| # | id | Automated? | What it asserts | On failure |
|---|---|---|---|---|
| 1 | `vector-indexes` | automated | All four names from `VECTOR_COLLECTIONS` exist via `listSearchIndexes()` and report `status === "READY"` | `npm run indexes`, then wait for Atlas to finish building |
| 2 | `postmortem-floor` | automated | `postmortems` count is at or above the floor (default 6) | `npm run seed` |
| 3 | `decisions-empty` | automated | `decisions` count is exactly `0` | `npx tsx scripts/demo-reset.ts --yes` |
| 4 | `runbook-chunks` | automated | `runbooks` count falls inside `[--runbook-min, --runbook-max]` | `npm run ingest:runbooks` |
| 5 | `elevenlabs-agent` | automated | `ELEVENLABS_AGENT_ID` and `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` are set and equal, and `GET /api/voice/signed-url` returns 200 with a `url` | `npm run agent:setup`, copy the id into both vars |
| 6 | `tunnel` | automated | `PUBLIC_BASE_URL` is https, and `POST /api/tools/log_timeline` returns 200 **with** the `X-BlackBox-Secret` header and 401 **without** it | Restart the tunnel, fix `TOOL_SHARED_SECRET` |
| 7 | `pitch-number` | automated | `data/pitch-numbers.json` exists, parses, and carries ~15.0 alongside a ~5,653,498 denominator | `npm run pitch` |
| 8 | `worker-mode` | automated (WARN only) | `TRIGGER_MODE` is `changestream` or `poll`, and `_watch_state` holds at least one document | See the manual worker-liveness note below |
| 9 | `fake-ports` | automated | No `*_MODE` env var equals `fake`, no resolver logs `FAKE PORT`, and `NEXT_PUBLIC_EVENTS_MODE` is not `fixture` | Unset the vars; land the missing real modules |
| 10 | `audio-levels` | **manual** | Cannot be automated — see below | — |
| 11 | `window-layout` | **manual** | Cannot be automated — see below | — |

### Notes on three of them

**`vector-indexes` checks `READY`, not existence.** A `PENDING` Atlas Search index returns
zero results with no error, so the entire memory story returns nothing on stage while every
log line looks healthy.

**`decisions-empty` is a hard FAIL, not a warning.** Critical Rule 5 says the collection
fills live on stage. A non-zero starting count means the previous rehearsal was not reset,
and the "watch it fill live" beat is what the MongoDB track submission rests on.

**`pitch-number` reads a file and never the network.** `data/` is gitignored, so the file
must be regenerated with `npm run pitch` **on the demo machine**. Never make a live network
call for the pitch number during the demo — conference wifi is the most reliable way to
lose a pitch, and that number is the first sentence out of the presenter's mouth.

**Record the real runbook count here the first time PHASE-05 completes**, so subsequent runs
catch a regression. The defaults are deliberately wide because no correct value is known
until the ingestion has actually run.

> Observed `runbooks` count after first successful ingestion: **_______**
> (then re-run with `--runbook-min=` / `--runbook-max=` set close to it)

### The two manual items, in full

**10. `audio-levels`.** Phone volume, laptop output, microphone gain. Run a ten-second
two-way test **using the actual first medic line from the run of show**, not a
count-to-three — the real line is what reveals whether barge-in cuts the agent off cleanly.

**11. `window-layout`.** Two browser windows positioned side by side, sized so that nothing
needs alt-tabbing. Window A is the dashboard at `/?incidentId=<id>`; window B is the voice
page. **Alt-tabbing on stage is the single most common stumble** — the audience briefly
sees a desktop and the whole thing stops looking like a product.

## Additional stage hygiene

These are **not** in `CHECKS` and deliberately do not count toward the eleven. They are
stage logistics, not system state.

- [ ] **Worker liveness.** Look at the worker terminal and confirm it printed its trigger
      mode. Check 8 can only warn — the contract gives `_watch_state` no update cadence, so
      a script cannot honestly assert the worker is alive.
- [ ] **Tunnel URL written on paper.** Tunnels rotate and the URL is unmemorable.
- [ ] **Phone on Do Not Disturb**, except for the demo number.
- [ ] **Laptop on power, display sleep disabled.** A screen that dims during the 2:00 beat
      is an unforced loss.
- [ ] **Fixture-mode fallback confirmed.** Load `/?mode=fixture` once and confirm the
      reference state renders. This is the insurance policy: if the backend dies mid-pitch,
      that URL puts a full dashboard back on the projector in one reload.
- [ ] **Reset run.** `npx tsx scripts/demo-reset.ts --yes`, and confirm from its output that
      `runbooks` and the seeded postmortems are identical before and after. The script exits
      non-zero if a protected count moved.

## Go / no-go

**One person makes this call:** ________________________

A **NO-GO means run the demo in fixture mode and say so.** Load `/?mode=fixture`, tell the
judges the backend is not live and that they are looking at a recorded run, and deliver the
same three minutes. That is a recoverable outcome.

Improvising a live run that fails on stage is not. Do not attempt it because a fix "should
only take a minute" — at T-minus 20 it never does.
