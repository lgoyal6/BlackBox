# Phase 13 — ElevenLabs Voice Layer

**Status:** PENDING
**Tasks:** US-024, US-025, US-026
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 90 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Build the voice layer: a browser WebRTC session driven by `@elevenlabs/react`, an ElevenLabs agent configured with seven server tools pointed at our own Next.js route handlers, a system prompt that carries the scope guardrail and the readback protocol, and the one piece of real local logic — splitting a medic's utterance into an action and a rationale without ever inventing the rationale.

This phase is where three of the four ElevenLabs judging criteria are won: Agentic Depth (the tools are real and write to Atlas mid-call), Interaction Design (barge-in and the tone shift), and Technical Integration (aviation-style readback).

## Do This First (10 minutes, before writing any payload)

**Confirm the current ElevenLabs API surface against live documentation. Do not write the agent configuration from memory.**

ElevenLabs renamed and reshaped this product — Conversational AI became the Agents Platform — and in the process the agent-creation payload, the server-tool definition format, and the turn-taking configuration keys all moved. Anything you remember about this API is probably a version behind. Writing the payload from memory and then debugging a `422` against a moving API is the single most likely way this phase blows its 90-minute budget, and it will happen in the last hour of the build when there is no slack.

Use the Context7 MCP server: `resolve-library-id` for `elevenlabs`, then `query-docs` for each of the following. The `docs-researcher` subagent is an acceptable alternative if Context7 has no coverage.

| What to confirm | Why it blocks you |
|---|---|
| Create/update agent shape in `@elevenlabs/elevenlabs-js` 2.63.0 | `scripts/setup-agent.ts` cannot be written without it |
| Server-tool (webhook tool) definition schema: URL, method, headers, parameter schema, timeout field | Seven tools depend on the exact nesting |
| Turn-taking / interruption configuration keys | Barge-in is mandatory and is a judged criterion |
| The credential a browser WebRTC session needs, and the SDK call that mints it | `GET /api/voice/signed-url` returns it |
| `useConversation` options and callbacks in `@elevenlabs/react` 1.12.0, including how session start receives that credential and which accessor exposes input volume | The operator console reads from these |
| Current lowest-latency TTS model tier identifier | Latency is explicitly judged |
| Whether the platform exposes a server-side way to inject a message into an in-progress conversation | Decides what `VoicePort.speak` can actually do |

**Write the confirmed field names into `.ralph/agents.md` under Technical Decisions before you write the payload.** Nobody should have to re-research this, and the next agent to touch voice will otherwise redo the same ten minutes.

Two conventions throughout this spec: where an exact ElevenLabs field name would be needed, the spec describes the **behaviour** and expects you to bind it to whatever the current docs call it. Where a number is given as a starting point (voice settings), it is a starting point to tune by ear, not a fact.

## Reference Files (read before implementing)

- `.ralph/overview.md` — **Scope Guardrail** (the hard constraint this prompt encodes), Voice Transport Risk, the ElevenLabs criteria table, How It Operates For A Medic (the three phases the prompt has to support).
- `.ralph/contracts.md` §10 — the seven tool request shapes and their latency budgets. The agent's tool parameter schemas must match these exactly or the handlers reject the body with a `400` and the agent goes quiet.
- `.ralph/contracts.md` §9 — `VoicePort`, and the registry rule that the real module default-exports at a fixed path.
- `.ralph/contracts.md` §3 — the three id forms. **Voice always speaks `displayId`, never `incidentId`.**
- `.ralph/contracts.md` §4 — `CODE_LABELS` and `labelFor()`. The agent never says a raw dispatch code aloud.
- `.ralph/contracts.md` §5 — `DecisionDoc`, especially the required non-empty `rationale` (Critical Rule 4).
- `.ralph/contracts.md` §7 — `PendingReadback` and `ReadbackConfirmation`, the shapes on both sides of the gate.
- `fixtures/utterances.json` (PHASE-01) — 8 medic utterances with expected action/rationale splits. This is what `extractRationale` is graded against, including the cases with **no** stated reason.

## Parallel-Safe Contract

### Files this phase owns

From the ownership table in `overview.md`, PHASE-13 owns exactly:

- `src/lib/voice/**`
- `app/voice/**`
- `app/api/voice/**`
- `scripts/setup-agent.ts`

The `agent:setup` npm script already exists from PHASE-01 (`contracts.md` §12) — do not edit `package.json`.

`app/layout.tsx` comes from PHASE-01's scaffold and is **owned by PHASE-14.** Do not create or edit it, and do not add global CSS. If the root layout is missing, that is a PHASE-01 gap to report, not a file to add. Style `app/voice/page.tsx` with the Tailwind classes the scaffold already provides so it renders regardless of what PHASE-14 is doing to the dashboard.

### Ports consumed, and how to build with zero dependencies

| Port | Used for | Fake behaviour that makes this verifiable alone |
|---|---|---|
| `LlmPort` | `extractRationale` | Templated deterministic strings, zero network |
| `EventsPort` | recording what `speak` would have said | In-memory array with `__drain()` |

Build and verify with:

```
LLM_MODE=fake EVENTS_MODE=fake
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake GRAPH_MODE=fake VOICE_MODE=real
```

`VOICE_MODE=real` makes the registry resolve this phase's module rather than `fakes/voice`.

**One acceptance criterion genuinely needs another phase** and it is called out below: the end-to-end conversation depends on PHASE-11's `/api/tools/*` handlers existing, because the agent's tools are HTTP calls to them. Everything else — prompt composition, `composeReadback`, `extractRationale` against the fixtures, the signed-url route, the console rendering — passes with PHASE-01 alone.

Until PHASE-11 lands there is a useful stand-in that tests a genuinely different thing: point the agent's tool URLs at `PUBLIC_BASE_URL/api/tools/*` anyway and confirm that a request through the tunnel reaches our server and returns a `404`. That proves tunnel reachability, DNS, and header plumbing independently of any handler logic, and those are the parts that fail in a way nobody can debug from inside the browser.

### Port implemented

PHASE-13 implements `VoicePort`. Per `contracts.md` §9, it must **default-export an object satisfying `VoicePort` from exactly `src/lib/voice/index.ts`** (registry path `@/lib/voice`). A named export, or the object living in a sibling file with no re-export, makes the registry silently fall back to the fake — and the fake's `speak` only writes to the console, so the failure looks like an agent that has gone mute.

### Transport, locked

| Rank | Transport | Status |
|---|---|---|
| 1 | Browser WebRTC via `@elevenlabs/react`'s `useConversation` | **Primary.** Build this and make the whole demo work on it before considering anything else. Lowest risk, no audio drivers, real barge-in, real latency, and a first-class React hook that belongs in this stack. |
| 2 | Twilio outbound call via ElevenLabs' native integration | **Upgrade, timeboxed to 30 minutes.** An actual phone actually rings on stage, which is worth real points because the pitch claims the system calls the medic. Needs a Twilio account, a purchased number, and the integration configured. If it is not working in 30 minutes, stop and use the browser transport. |
| 3 | Anything requiring native audio bindings | **Never.** There is no time to debug native modules today. |

Because the agent's tools are server tools hitting our own route handlers, **all transports run identical logic.** The upgrade changes who hears the audio and nothing else, which is exactly why it is safe to timebox.

## Files to Create

### `src/lib/voice/prompt.ts`

The system prompt. This is where the "clever prompt engineering for agent personality" criterion is won or lost, and it is the artifact most worth reading with human eyes before going live — hence `--print-prompt` on the setup script.

```ts
export const SYSTEM_PROMPT: string;

/** Appends the live incident context (label, dispatch area, unit, displayId) to SYSTEM_PROMPT. */
export function buildPrompt(ctx?: {
  label?: string; dispatchArea?: string; unit?: string; displayId?: string;
}): string;

export const FIRST_MESSAGE: string;
```

`SYSTEM_PROMPT` must contain every section below. The scope guardrail paragraph is **verbatim** — do not reword it, and do not soften it to make a demo beat land better.

```
IDENTITY
You are BlackBox, a flight recorder for an EMS crew. You listen, you remember, and you
brief. You are not an assistant and you are not a medical adviser. You are the thing that
writes down what happened and what the medic decided, so the next crew does not start
from zero.

SCOPE - this is absolute
You never propose a treatment, drug, dose, or diagnosis. You recall what happened on
similar calls, you read back exactly what the medic said, and you quote retrieved
clinical guidance with attribution. The medic owns every clinical judgment.

BREVITY
The brief is under fifteen seconds. Every other turn is one or two sentences. The medic is
driving or working a patient. Verbose is the exact failure mode this product was designed
against. Never list more than two items aloud.

READBACK PROTOCOL - the hard gate
Before any drug, dose, or route is recorded, call propose_readback and speak the text it
returns exactly as returned. Then stop and wait. Do not paraphrase it. Do not round a
number. Do not correct the medic. If confirmation does not come, do not record. Call
record_decision for anything involving a drug, dose, or route only after
confirm_readback has returned confirmed.

LISTEN FOR REASONING, NOT JUST ACTIONS
When the medic states an action without a reason, ask once, briefly - "reason?" - then
record both the action and the reason. One follow-up, then move on. This is the single
most important behaviour you have.

TONE
Calm and measured during the brief. Clipped and staccato when confirming anything
irreversible: short words, no filler, no pleasantries. No "sure", no "got it", no "I'd be
happy to".

SPEAKING RULES
Never read a raw dispatch code aloud. Say "unconscious or unresponsive", never "UNC". The
tools return expanded labels; use them.
Never invent an incident reference. Cite only a displayId that recall_memory returned to
you. If it returned nothing, say you have no prior record of this pattern.
Never speak an eight-digit incident id.
```

Why each of these is load-bearing:

- **Identity as a recorder, not an assistant,** is what keeps the model from drifting into helpfulness and volunteering clinical opinions.
- **The scope guardrail** is the constraint judges get visibly twitchy about. Eva, the prior Best-ElevenLabs winner this project is modeled on, won on documentation and retrieval, not diagnosis.
- **Brevity** is a product requirement, not a style preference. A medic with their hands in a patient cannot skip a paragraph.
- **The readback protocol stated as a hard rule** is the only reliable way to make a model use a gate. Models skip gates that are merely mentioned.
- **Listening for reasoning** is the product's thesis made audible. Without the one follow-up question, this is a dictation tool.
- **The tone shift** maps directly to the emotional-inflection criterion, and doing it at the prompt level is far cheaper and more reliable than swapping voice settings mid-call.
- **The speaking rules** exist because "UNC" spoken by a TTS voice is unintelligible, and a fabricated incident reference is the one hallucination a judge can catch in real time.

`FIRST_MESSAGE` is the agent's opening line when the session connects. Keep it to one short sentence that invites the brief rather than delivering it, because the brief comes from `recall_memory` and cannot be composed before the tool has run.

### `src/lib/voice/tools.ts`

The one piece of real local logic, plus the deterministic readback formatter.

```ts
export interface DecisionExtraction {
  actionChosen: string;
  rationale: string | null;      // null when the medic gave no reason. NEVER fabricate.
  optionsConsidered: string[];
}

/** One small fast LLM call with a strict JSON schema. Returns rationale: null rather than inventing one. */
export async function extractRationale(utterance: string): Promise<DecisionExtraction>;

/** Deterministic string formatting. NEVER an LLM call. */
export function composeReadback(f: {
  drug?: string; dose?: string; route?: string; utterance?: string;
}): string;
```

**`extractRationale`** uses `llm().json()` with a strict schema and the smallest, fastest model available, because it runs inside `record_decision`'s background task and the medic is still talking.

The prompt must state, as a rule rather than a preference, that `rationale` is `null` when the medic gave no reason. **Never invent a rationale.** A fabricated one is worse than none: it puts a made-up justification in the permanent clinical record, which is precisely the harm this project claims to prevent. The empty-rationale path is not an edge case — three of the utterances in `fixtures/utterances.json` have no stated reason, and the correct output for all three is `null`.

`protocolConflict` is **not** an extraction output. It defaults to `false` on the written document, and the LLM must not set it: labeling a medic's action as a protocol violation from one sentence is exactly the clinical judgment the scope guardrail forbids.

**`composeReadback`** produces exactly:

```
Confirm: <dose> of <drug>, <route>. Say confirm.
```

and when no drug/dose/route was supplied, exactly `Confirm: <utterance>. Say confirm.` No LLM ever touches this string, because the agent must speak it verbatim on this turn and an LLM can paraphrase a dose or round a number. Verbatim means verbatim.

**PHASE-11 carries a second copy of this function** in `app/api/tools/_lib/deps.ts`, because a route handler cannot import a module from a phase that may not exist yet. Both specs pin the same assertion so the copies cannot drift:

```ts
composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" })
  === "Confirm: 300 mg of amiodarone, IV push. Say confirm."
```

PHASE-11's `record_decision` also soft-imports this module for extraction and validates the result at runtime. **The three field names and the `null` convention are load-bearing across that boundary** — renaming one silently degrades PHASE-11 to its fallback path. If either phase wants a compile-time shared type, the correct move is adding `DecisionExtraction` to `contracts.md` §5 and logging it in `agents.md`, not an import.

### `src/lib/voice/agent-config.ts`

The agent payload builder, kept separate from the setup script so `--print-prompt` and a dry run can inspect it without touching the network.

```ts
export interface ServerToolSpec {
  name: string;
  description: string;                 // written for the model
  url: string;                         // `${PUBLIC_BASE_URL}/api/tools/${name}`
  timeoutMs: number;
  parameters: Record<string, { type: "string" | "boolean"; required: boolean; description: string }>;
}

export const SERVER_TOOLS: ServerToolSpec[];

/** Maps SERVER_TOOLS + prompt + voice settings into the current ElevenLabs agent payload shape. */
export function buildAgentConfig(): unknown;
```

`buildAgentConfig` is where the field names you confirmed in the docs get bound. Keep every ElevenLabs-specific key inside this one function so a `422` has exactly one file to debug.

**Every tool sends the shared secret header** `X-BlackBox-Secret: $TOOL_SHARED_SECRET`, or every call returns `401` and the agent talks to itself for the length of the demo.

**Parameter schemas must match `contracts.md` §10 exactly.** A parameter the handler's Zod schema does not expect, or a missing required one, produces a `400` — and from the outside that is indistinguishable from a model that chose not to call the tool. Keep the schemas tight: the fewer free-text parameters, the less the model can invent.

#### The seven tools

Descriptions are written **for the model** — when to call it, not what it does internally.

| Tool | Parameters | Timeout | Description written for the model (summary) |
|---|---|---|---|
| `recall_memory` | `incidentId`, `query` | 3 s | Call at the start of every call, and any time the medic asks what happened before or whether this has been seen. Returns prior decisions, postmortems, and guidance. Speak only the incident references it returns. |
| `get_protocol` | `incidentId`, `topic` | 3 s | Call when the medic asks for a protocol, guideline, dose reference, or contraindication. Quote the returned text with its section title. Never answer a clinical question from your own knowledge. |
| `log_timeline` | `incidentId`, `text`, `source` | 2 s | Call whenever the medic narrates something that happened. Pass their words, not a summary. |
| `propose_readback` | `incidentId`, `utterance`, `drug?`, `dose?`, `route?` | 2 s | **Call this before `record_decision` whenever the medic mentions a drug, a dose, or a route.** Speak the returned text exactly as returned, then wait for the medic to confirm. Never skip this for anything involving a dose. |
| `confirm_readback` | `incidentId`, `confirmed`, `verbatimOk` | 3 s | Call the moment the medic confirms or rejects a readback. `verbatimOk` is false if they corrected any part of it. |
| `record_decision` | `incidentId`, `utterance` | 3 s | Call when the medic states a decision and a reason. **If the utterance involves a drug, dose, or route, you must already have called `propose_readback` and received confirmation; if you have not, call `propose_readback` instead of this.** If the medic gave no reason, ask once for the reason first. |
| `close_call` | `incidentId` | 10 s | Call at transfer of care, when the medic says they are handing off or the call is done. Say that you are drafting the report before you call it. |

**The ordering constraint appears twice on purpose** — once in `propose_readback`'s description and once in `record_decision`'s — plus a third time in the system prompt. Models will skip a gate that a description merely mentions, so it is stated as a hard rule in both directions: the earlier tool says it must come first, and the later tool says it must not run without it.

**Timeouts are aggressive on purpose.** A hung tool call produces dead air, and dead air on stage is indistinguishable from a broken demo. 2–3 seconds gives every handler roughly ten times its contract budget while still failing fast. `close_call` is the one exception at 10 seconds, because its contract budget is 8 seconds — and it is the one tool the agent announces before calling, so the wait is covered by speech rather than silence.

#### Voice and latency settings

| Setting | Value | Why |
|---|---|---|
| TTS model tier | the lowest-latency tier currently offered (confirm the identifier in the docs) | The quality difference is inaudible over a phone-quality earpiece, and latency is explicitly judged |
| Interruption / barge-in | **enabled — mandatory** | A medic who cannot interrupt will hate it, and the criteria reward it directly |
| Voice | calm, low register | An energetic or bright voice reads as a consumer assistant and undercuts a safety-critical framing |
| Stability | mild — start around 0.35–0.45 and tune by ear | Extreme stability flattens the tone shift the prompt is asking for |
| Similarity boost | moderate — start around 0.7 | |

### `app/api/voice/signed-url/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(): Promise<Response>;
// Response { url: string; agentId: string }
```

Mints the browser session credential server-side using `@elevenlabs/elevenlabs-js` and `ELEVENLABS_API_KEY`.

**The ElevenLabs API key never reaches the browser.** Only `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` is public. This route exists solely so the key stays server-side, so it must not accept or echo any client-supplied parameter.

`500` with `{ error: "ELEVENLABS_API_KEY not configured" }` when the key is missing, and `500` with the provider's status code in the message (never its full body) when the mint call fails.

If the WebRTC transport in `@elevenlabs/react` 1.12.0 wants a conversation token rather than a signed URL, **carry it in `url`** rather than changing the response shape mid-build, and note it in `agents.md`. Only this phase consumes this route, so a contract change would be legitimate — but per rule 10 in `overview.md` it means editing `contracts.md` §10 and announcing it, and a one-line note is cheaper than fourteen agents re-reading the contract.

### `src/lib/voice/index.ts`

```ts
export async function speak(incidentId: string, text: string): Promise<void>;
export async function signedUrl(): Promise<{ url: string; agentId: string }>;

const voiceAdapter: VoicePort = { speak, signedUrl };
export default voiceAdapter;
```

`signedUrl` shares its implementation with the route handler — the route is a thin wrapper so both paths mint the credential the same way.

**`speak` needs an honest scope.** With browser WebRTC, the agent's audio is produced inside the ElevenLabs session; a server process cannot push speech into it unless the platform exposes a way to inject a message into a live conversation. That is one of the items to confirm in the docs step.

- If it exists, use it, and also record the utterance.
- If it does not, `speak` **records** the utterance — emit a `voice` event with `speaker: "agent"` and append to the incident timeline — and returns. The audio then comes from the agent reading the result of `recall_memory` on its first turn.

State this in a comment at the top of the function, because it explains an architectural choice that looks like an omission otherwise: **the brief is retrieved by a tool rather than pushed by the server**, so nothing in the demo depends on server-initiated speech. Either outcome of the docs check leaves the demo working.

### `app/voice/page.tsx`

The operator console. A client component (`"use client"`), deliberately minimal, deliberately **separate from the judge dashboard** so the operator drives voice on one screen while judges watch the other.

Contents:

- A **Connect / Disconnect** button that fetches `/api/voice/signed-url` and starts the session via `useConversation`, passing `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`.
- **Connection state** rendered as text — connecting, connected, disconnected, error — from the hook's status value.
- A **mic level** meter from whichever input-volume accessor the hook exposes in 1.12.0. Its job is to answer "is the microphone actually live" in one glance, which is the question you will be asking ten seconds before the pitch.
- The **current incident**: `displayId` and `ref`, plus two buttons calling `POST /api/demo/fire` with `{ pattern: "arrest" }` and `{ pattern: "cardiac" }` so the operator can drive the whole demo from this one screen. That is an HTTP call to PHASE-11, not an import, so it stays inside the ownership rules.
- A rolling list of **tool calls** if the hook surfaces them in a message or debug callback; if it does not, omit it rather than faking it. The authoritative proof of tool invocation is the server log, and the acceptance criteria use that.

**Both windows must be visible without alt-tabbing during the pitch.** Plan for two browser windows side by side — this console and the dashboard — and check it during rehearsal rather than discovering it on stage. Keep this page narrow enough to sit beside the dashboard.

Open this page on `http://localhost:3000/voice`, not through the tunnel. The WebRTC audio path goes directly from the browser to ElevenLabs and never traverses the tunnel; the tunnel exists only so ElevenLabs' servers can reach `/api/tools/*`. Running the console on localhost avoids a second microphone-permission prompt and takes the tunnel off the audio path entirely.

### `scripts/setup-agent.ts`

```ts
async function main(): Promise<void>;
// flags: --print-prompt   dump the resolved system prompt and exit, no network
//        --dry-run        print the full agent payload and exit, no network
```

Behaviour:

- **Idempotent via a stored agent id.** If `ELEVENLABS_AGENT_ID` is set, update that agent; otherwise create one, print the id, and print an explicit reminder to write it into `.env` as both `ELEVENLABS_AGENT_ID` and `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`. Creating a duplicate agent every run is how you end up debugging a stale one.
- **Refuse to run when `PUBLIC_BASE_URL` is empty, or points at `localhost` or `127.0.0.1`.** Exit non-zero with a message saying the tool URLs must be reachable from ElevenLabs' servers. ElevenLabs cannot reach localhost, and the resulting failure is an agent that sounds perfect and never calls a tool — the worst failure mode in this build, and one that survives a full rehearsal unnoticed.
- **Print the seven resolved tool URLs** before sending anything, so a wrong `PUBLIC_BASE_URL` is caught by eye in one second.
- `--print-prompt` writes the resolved prompt to stdout and exits `0` with no network call. The prompt is the part most worth reading with human eyes before going live.

## Acceptance Criteria

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds
- [ ] `src/lib/voice/index.ts` has a **default export** and `const _check: VoicePort = voiceAdapter;` compiles
- [ ] With `VOICE_MODE=real`, `(await voice())` from `@/lib/registry` returns this module with no `FAKE PORT` warning
- [ ] **Verifiable with all other ports faked:** with `LLM_MODE=fake EVENTS_MODE=fake`, `npx tsx scripts/setup-agent.ts --print-prompt` prints the prompt and exits `0` with no network access
- [ ] The printed prompt contains the scope guardrail sentence **verbatim**: "You never propose a treatment, drug, dose, or diagnosis."
- [ ] The printed prompt contains all seven required sections: identity, scope, brevity, readback protocol, listen-for-reasoning, tone, speaking rules
- [ ] `composeReadback({ drug: "amiodarone", dose: "300 mg", route: "IV push" })` returns exactly `Confirm: 300 mg of amiodarone, IV push. Say confirm.`
- [ ] `composeReadback` contains no reference to `llm` and makes zero network calls
- [ ] `extractRationale` run over all 8 entries in `fixtures/utterances.json` returns a non-empty `actionChosen` for every one
- [ ] **`extractRationale` returns `rationale: null` for every fixture utterance that states no reason, and never a fabricated string** — this is the criterion that protects the clinical record
- [ ] `extractRationale` never returns a `protocolConflict` field
- [ ] `SERVER_TOOLS` has exactly seven entries whose names are `recall_memory`, `get_protocol`, `log_timeline`, `propose_readback`, `confirm_readback`, `record_decision`, `close_call`
- [ ] Every tool's parameter set matches its request shape in `contracts.md` §10 — no extra parameters, no missing required ones
- [ ] Every tool URL is `${PUBLIC_BASE_URL}/api/tools/<name>` and every tool sends `X-BlackBox-Secret`
- [ ] Every tool timeout is between 2 and 3 seconds except `close_call`, which is 10
- [ ] The ordering rule appears in **both** `propose_readback`'s and `record_decision`'s descriptions, and in the system prompt
- [ ] Interruption / barge-in is enabled in the payload, verified by inspecting `--dry-run` output
- [ ] `scripts/setup-agent.ts` exits non-zero with a `PUBLIC_BASE_URL` that is empty or points at localhost
- [ ] Running `npm run agent:setup` twice with `ELEVENLABS_AGENT_ID` set updates one agent and creates no second agent
- [ ] `GET /api/voice/signed-url` returns `{ url, agentId }` with a real key, and `500` with a clear error when the key is absent
- [ ] **The API key never reaches the browser:** `ELEVENLABS_API_KEY` appears nowhere under `app/voice/` or `src/components/`, and the key's value appears nowhere in the built client bundle under `.next/static`
- [ ] `/voice` renders, the Connect button starts a session, and the connection state and mic level both change when the microphone is live
- [ ] **Barge-in works in practice:** speaking over the agent mid-sentence stops its audio within roughly a second
- [ ] **The guard against a demo that sounds right but never called a tool:** after a scripted conversation, the server log contains at least one `[tool] recall_memory` line, and for the dose turn a `[tool] propose_readback` line appears **before** the `[tool] record_decision` line. Speech alone is not evidence — this is the criterion that separates a real agent from a TTS layer reading pre-generated text, and it is what Agentic Depth is written to filter out. *(needs PHASE-11)*
- [ ] With `decisions` empty, the agent states it has no prior record and **cites no `displayId`** — verified by transcript
- [ ] The agent speaks no raw dispatch code in a full run — no "UNC", no "SICK" as a code — verified by transcript
- [ ] The agent speaks no eight-digit incident id — verified by transcript
- [ ] Tunnel reachability, testable before PHASE-11 exists: a request to `${PUBLIC_BASE_URL}/api/tools/recall_memory` from outside the local network reaches this server (a `404` or `401` proves it; a timeout or DNS failure does not)
- [ ] No file was created or modified outside `src/lib/voice/**`, `app/voice/**`, `app/api/voice/**`, `scripts/setup-agent.ts`

## Verification

PowerShell note: set env vars with `$env:VAR="value"` on a preceding line; the inline `VAR=value cmd` form is bash-only.

```bash
npm run typecheck
npm run build
```

Prompt and payload, no network:

```bash
npx tsx scripts/setup-agent.ts --print-prompt
npx tsx scripts/setup-agent.ts --print-prompt | grep -c "You never propose a treatment, drug, dose, or diagnosis."   # 1
npx tsx scripts/setup-agent.ts --dry-run
```

The readback formatter and the rationale extractor:

```bash
LLM_MODE=fake npx tsx -e "
import { composeReadback, extractRationale } from './src/lib/voice/tools';
console.log(JSON.stringify(composeReadback({ drug:'amiodarone', dose:'300 mg', route:'IV push' })));
console.log(JSON.stringify(composeReadback({ utterance:'holding cervical spine' })));
const fx = JSON.parse(require('fs').readFileSync('fixtures/utterances.json','utf8'));
for (const u of fx) {
  const r = await extractRationale(u.utterance ?? u.text);
  console.log([r.actionChosen !== '', r.rationale === null ? 'NULL' : 'HAS', u.utterance ?? u.text].join(' | '));
}
process.exit(0);
"
```

The first line must be exactly `"Confirm: 300 mg of amiodarone, IV push. Say confirm."`. Every row must start `true`, and the `NULL`/`HAS` column must match the fixture's expectation for that utterance.

Tool URL and secret check, straight off the payload:

```bash
PUBLIC_BASE_URL=https://example.ngrok.app TOOL_SHARED_SECRET=devsecret npx tsx -e "
import { SERVER_TOOLS } from './src/lib/voice/agent-config';
console.log('count', SERVER_TOOLS.length);
for (const t of SERVER_TOOLS) console.log(t.name, t.timeoutMs, t.url);
process.exit(0);
"
```

The localhost guard:

```bash
PUBLIC_BASE_URL=http://localhost:3000 npx tsx scripts/setup-agent.ts; echo "exit=$?"   # non-zero
PUBLIC_BASE_URL= npx tsx scripts/setup-agent.ts; echo "exit=$?"                        # non-zero
```

Create or update the agent, then confirm the key never shipped to the browser:

```bash
npm run agent:setup
curl -s localhost:3000/api/voice/signed-url | head -c 200
grep -rn "ELEVENLABS_API_KEY" app/voice src/lib/voice/tools.ts || echo "clean"
grep -rl "$ELEVENLABS_API_KEY" .next/static 2>/dev/null || echo "key not in client bundle"
```

The tool-invocation guard — the one that catches an agent that sounds right and did nothing. Run the app with the tool log visible, hold a scripted conversation on `/voice`, then read the log:

```bash
npm run dev 2>&1 | tee /tmp/blackbox-dev.log
# conversation: ask what happened on similar calls, narrate an action with a reason,
# then say "pushing 300 of amio IV" and confirm the readback, then hand off.
grep '\[tool\]' /tmp/blackbox-dev.log
```

Expected, in this order: `recall_memory`, then `propose_readback`, then `confirm_readback`, then `record_decision`. If `record_decision` appears before `propose_readback` for the dose turn, the gate did not hold — strengthen the wording in both tool descriptions and the prompt, and re-run rather than accepting it.

Empty-corpus behaviour, which a judge will deliberately trigger:

```bash
curl -s -X POST localhost:3000/api/demo/reset -H 'content-type: application/json' -d '{}'
# reconnect and ask what happened on similar calls; the agent must say it has no prior
# record and must not cite any displayId
```

## Handoff Note

Three things to announce when this passes. The confirmed ElevenLabs field names go in `.ralph/agents.md` so nobody re-researches them. The `agentId` goes into `.env` as both `ELEVENLABS_AGENT_ID` and `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`. And the Twilio upgrade is a 30-minute timebox that starts only after the browser transport carries the full demo end to end — if the timer runs out, say so out loud and stop, because the browser transport is the one that has already been rehearsed.
