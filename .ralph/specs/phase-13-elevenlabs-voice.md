# Phase 13 — ElevenLabs Voice Layer

**Status:** PENDING
**Tasks:** US-024, US-025, US-026
**Depends on:** PHASE-01 only (contracts + fakes)
**Budget:** 90 min
**Parallel:** yes — runs concurrently with all phases except 01

## Objective

Stand up the conversational voice layer the demo is judged on: an ElevenLabs agent whose server tools hit our Next.js routes, a `VoicePort` that mints a connection credential without leaking the API key, deterministic readback and honest rationale extraction, and a browser WebRTC operator console via `@elevenlabs/react`'s `useConversation`. Barge-in is mandatory. The agent never proposes a treatment.

## Confirm The Current API Before Writing Any Payload

The Agents Platform surface has moved (Conversational AI → Agents Platform). Writing a payload from memory and debugging a 422 is the fastest way to blow this budget. **Before `scripts/setup-agent.ts` constructs a request body, confirm the live types against Context7** (`/elevenlabs/elevenlabs-js` and `/websites/elevenlabs_io`) and the installed `@elevenlabs/elevenlabs-js@2.63.0` typings. Log the confirmed method names in `.ralph/agents.md` under Technical Decisions.

Verified against Context7 on 2026-08-13 (re-check if the installed types disagree):

| Need | Current API | Do not use |
|---|---|---|
| Server SDK | `import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"` | The legacy `elevenlabs` 1.59.0 package |
| Create agent | `client.conversationalAi.agents.create({ name, conversationConfig })` → `{ agentId }` | Guessed REST paths from blog posts |
| Update agent | `client.conversationalAi.agents.update(agentId, { conversationConfig, ... })` | Recreating a new agent on every setup run |
| Workspace webhook tools | `client.conversationalAi.tools.create` with `WebhookToolConfigInput` (`name`, `description`, `responseTimeoutSecs`, `interruptionMode`, `apiSchema`) | `client.webhooks.create` (that is a workspace event webhook, not a tool) |
| Inline webhook tool | `conversationConfig` tools item `{ type: "webhook", name, description, apiSchema: { url, method, requestHeaders, requestBodySchema } }` | Invented `server_url` / `webhook_url` keys |
| Signed URL (WebSocket) | `client.conversationalAi.conversations.getSignedUrl({ agentId })` → `{ signedUrl }` | Putting `ELEVENLABS_API_KEY` in the browser |
| WebRTC token | `client.conversationalAi.conversations.getWebrtcToken({ agentId })` or `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=` | Assuming a signed URL is WebRTC |
| Browser hook | `import { useConversation } from "@elevenlabs/react"` | Native audio bindings, the legacy client |

**Transport rule, confirmed in `@elevenlabs/packages` `ConnectionFactory`:** a `signedUrl` session is **WebSocket only**. Passing `connectionType: "webrtc"` with a signed URL throws. A `conversationToken` session is **WebRTC**. Overview requires browser WebRTC first. Therefore:

- `VoicePort.signedUrl()` and `GET /api/voice/signed-url` stay exactly as `contracts.md` §9–§10 specify (`{ url, agentId }`), implemented with `getSignedUrl`.
- This phase also owns `GET /api/voice/conversation-token` returning `{ token, agentId }`, implemented with `getWebrtcToken`. The operator console uses that token and `startSession({ conversationToken })`.
- Do not widen `VoicePort`. A new port method is a contract change.

If the installed 2.63.0 types rename any of the above, **follow the installed types**, not this table, and record the rename in `agents.md`. Do not invent a third client.

## Reference Files (read before implementing)

- `.ralph/contracts.md` §9 — `VoicePort` (`speak`, `signedUrl`) and the registry path `@/lib/voice`.
- `.ralph/contracts.md` §10 — `GET /api/voice/signed-url` response `{ url, agentId }`; tool routes this agent must call.
- `.ralph/contracts.md` §3 — `toDisplayId`. **Never speak an 8-digit `incidentId`.**
- `.ralph/contracts.md` §4 — `labelFor`. **Never speak a raw dispatch code.**
- `.ralph/contracts.md` §6 — `SPOKEN_WORD_CAP` (40).
- `.ralph/overview.md` — Scope Guardrail, Voice Transport Risk, ElevenLabs prize criteria, Critical Rule 3.
- `fixtures/utterances.json` — eight medic utterances with expected `actionChosen` / `rationale` splits, including cases that deliberately omit a reason.
- `app/api/tools/**` (PHASE-11 owns; **do not edit**). This phase only *calls* those URLs from the agent config.

## Parallel-Safe Contract

### Files this phase owns

| Path | Purpose |
|---|---|
| `src/lib/voice/index.ts` | Default export satisfying `VoicePort` |
| `src/lib/voice/client.ts` | `ElevenLabsClient` singleton |
| `src/lib/voice/prompt.ts` | System prompt + first message, including the guardrail sentence |
| `src/lib/voice/readback.ts` | Pure `composeReadback` |
| `src/lib/voice/rationale.ts` | Extraction that may return `null` |
| `src/lib/voice/tools.ts` | Seven webhook tool definitions (no network) |
| `app/api/voice/signed-url/route.ts` | Contract route |
| `app/api/voice/conversation-token/route.ts` | WebRTC token route |
| `app/voice/page.tsx` | Operator console |
| `app/voice/console.tsx` | `useConversation` wiring |
| `scripts/setup-agent.ts` | Create/update agent, print `agentId` |

`npm run agent:setup` already points at that script. Do not edit `package.json`. Do not add Twilio files unless the 30-minute upgrade is attempted *after* the browser path passes.

### Ports consumed

| Port | Used for | Set this to build in isolation |
|---|---|---|
| `EventsPort` | `speak` emits a `voice` event so the dashboard can render the line | `EVENTS_MODE=fake` |
| `LlmPort` | Rationale extraction only | `LLM_MODE=fake` |

Tool HTTP calls go to PHASE-11's routes. With those routes absent, `setup-agent` still writes the config, and `composeReadback` / `extractRationale` still verify against fixtures with zero network. Live voice verification (US-026) needs the Next app, the tool routes, and a real `ELEVENLABS_API_KEY`. That is the last third of the budget, not a blocker for US-024 and US-025.

```
VOICE_MODE=real
EVENTS_MODE=fake LLM_MODE=fake
EMBEDDINGS_MODE=fake RETRIEVAL_MODE=fake GRAPH_MODE=fake
```

### Port implemented

`VoicePort`, **default-exported from `src/lib/voice/index.ts`** (registry path `@/lib/voice`):

```ts
const voice: VoicePort = { speak, signedUrl };
export default voice;
```

Use `satisfies VoicePort` so a signature drift is a compile error.

## Files to Create

### `src/lib/voice/client.ts`

```ts
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

export function getElevenLabs(): ElevenLabsClient;
```

Construct with `{ apiKey: env.elevenLabsApiKey }`. Cache on `globalThis` in development, same reason as the Mongo client. **Never import `elevenlabs` (legacy).** `rg -n "from \"elevenlabs\"|from 'elevenlabs'" src app scripts` must return nothing.

### `src/lib/voice/prompt.ts`

```ts
export const SCOPE_GUARDRAIL =
  "The agent must never propose a treatment, dose, or diagnosis of its own.";

export function systemPrompt(): string;
export function firstMessage(): string;
```

`SCOPE_GUARDRAIL` is **that exact sentence**, copied from `overview.md`. `systemPrompt()` must contain it verbatim (`includes(SCOPE_GUARDRAIL)` is an acceptance check). The rest of the prompt, in complete sentences:

1. You recall what happened last time and write down what the medic decided. The human owns every clinical judgment.
2. You may only read back what the medic said, or quote a retrieved NASEMSO passage with attribution (`From NASEMSO, section …`).
3. Never read a raw dispatch code aloud. Use the expanded label the tools return. Never invent an incident reference; only cite a `displayId` that `recall_memory` just returned.
4. Never speak an 8-digit incident id. Use the four-digit display id.
5. Tone: calm and short during the brief (under fifteen seconds). Clipped and exact when confirming a drug, dose, or any irreversible action.
6. Tool order, stated **twice** in the prompt and again in every tool description: if the medic names a drug or a dose, call `propose_readback` and wait for a spoken confirm before `record_decision`. Never `record_decision` first on a dosed utterance.
7. If the medic states an action with no reason, ask exactly one short follow-up (`What made you choose that?`) and do not record yet.
8. If the medic asks what they should give, refuse with the guardrail and, if a protocol hit exists, quote it with attribution. Do not suggest a treatment.
9. Cap spoken replies at 40 words unless you are reading back a dose, in which case you speak the `readbackText` exactly.

`firstMessage()` is one calm sentence that does not contain a dispatch code or a treatment. Something in the shape of: `On scene with you. Briefing from memory when you are ready.`

### `src/lib/voice/tools.ts`

```ts
export interface VoiceToolDef {
  name: string;
  description: string;
  responseTimeoutSecs: number;
  interruptionMode: "allow";
  apiSchema: {
    url: string;
    method: "POST";
    requestHeaders: Record<string, string>;
    requestBodySchema: unknown;
  };
}

export function toolDefs(baseUrl: string, secret: string): VoiceToolDef[];
```

Seven tools, names matching `contracts.md` §10 exactly: `recall_memory`, `get_protocol`, `log_timeline`, `propose_readback`, `confirm_readback`, `record_decision`, `close_call`.

- `url` is `${baseUrl.replace(/\/$/, "")}/api/tools/${name}`.
- `requestHeaders` includes `X-BlackBox-Secret: ${secret}` and `Content-Type: application/json`.
- `responseTimeoutSecs` is **3 or less** for every tool (`close_call` may be 3; the route's 8 s budget is a server ceiling, not a reason to hang the voice turn).
- `interruptionMode` is `"allow"` so barge-in works during a tool call. Do not set the deprecated `disableInterruptions: true`.
- Each `description` states when to call the tool. The `propose_readback` and `record_decision` descriptions both contain the ordering rule: propose first, record after confirm, for anything with a dose. That is the "stated twice" requirement.

`toolDefs` is pure. `setup-agent.ts` maps these onto the SDK's `WebhookToolConfigInput` / inline `type: "webhook"` shape **after** reading the installed types. If the SDK wants `request_headers` on the wire and `requestHeaders` in camelCase, follow the SDK.

### `src/lib/voice/readback.ts`

```ts
export function composeReadback(fields: {
  utterance: string;
  drug?: string;
  dose?: string;
  route?: string;
}): string;
```

Pure deterministic string formatting. **No LLM.** Same template as PHASE-11:

```
Confirming {dose} of {drug}, {route}. Say confirm or correct me.
```

Reproduce the dose and units exactly. `"1 milligram"` in, `"1 milligram"` out. No rounding, no unit conversion, no spelled-out digits that were not in the input.

### `src/lib/voice/rationale.ts`

```ts
export interface Extracted {
  actionChosen: string;
  rationale: string | null;
}

export async function extractRationale(utterance: string): Promise<Extracted>;
```

Call `llm().json` with a schema whose `rationale` is `string | null`. Then apply a hard filter that does not trust the model:

- If `rationale` is null, empty, or whitespace, return `null`.
- If `rationale` is not a case-insensitive substring of `utterance`, return `null` and log `RATIONALE REJECTED: not in utterance`.
- Never replace a missing rationale with a guessed clause (`to protect the airway`, `per protocol`, …).

Verify against all eight rows of `fixtures/utterances.json`. The fixture rows that omit a reason must produce `rationale: null`. That is US-025.

### `src/lib/voice/index.ts`

```ts
export async function speak(incidentId: string, text: string): Promise<void>;
export async function signedUrl(): Promise<{ url: string; agentId: string }>;
```

`speak` emits a `voice` event `{ speaker: "agent", text, clock }` through `EventsPort` and, when `VOICE_MODE=real` and a conversation is not already talking, may also call the HTTP TTS endpoint **only if** the installed SDK exposes a documented text-to-speech method you confirmed. If that method is unclear, emit-only is acceptable: the conversational session is the spoken path, and `speak` exists so the graph can log what it would have said. Do not invent a WebSocket speak API.

`signedUrl` calls `getElevenLabs().conversationalAi.conversations.getSignedUrl({ agentId: env.elevenLabsAgentId })` and returns `{ url: result.signedUrl, agentId }`. The API key stays on the server.

Also export a phase-local helper (not on the port):

```ts
export async function conversationToken(): Promise<{ token: string; agentId: string }>;
```

implemented with `getWebrtcToken`. The conversation-token route uses this.

### `app/api/voice/signed-url/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(): Promise<Response>;
```

`{ url, agentId }` from `signedUrl()`. 500 `{ error: string }` if the key or agent id is missing. **Never put `ELEVENLABS_API_KEY` in the JSON.**

### `app/api/voice/conversation-token/route.ts`

```ts
export const runtime = "nodejs";
export async function GET(): Promise<Response>;
```

`{ token, agentId }` from `conversationToken()`. Same secrecy rule. This is the route the console uses for WebRTC.

### `app/voice/console.tsx` and `app/voice/page.tsx`

Client components. `page.tsx` is the `/voice` operator console: connection state, a mic-level bar from `getInputVolume()`, the current `incidentId` / `displayId`, a start/stop control, and a short transcript.

```ts
"use client";
import { useConversation } from "@elevenlabs/react";

// start:
const { token, agentId } = await (await fetch("/api/voice/conversation-token")).json();
await conversation.startSession({ conversationToken: token });
```

Request the microphone with `navigator.mediaDevices.getUserMedia({ audio: true })` before `startSession`. Wire `onConnect`, `onDisconnect`, `onError`, `onStatusChange`, `onModeChange`, `onInterruption`, and `onAgentToolRequest` / `onAgentToolResponse` so the console can show that a tool actually fired. **Verify tool use from those callbacks and the Next server log, not from the fact that the agent spoke.** An agent that sounds right and never called a tool fails Agentic Depth.

Pass the live `incidentId` as a dynamic variable if the installed types support `dynamicVariables` on `startSession`; otherwise the medic (operator) says the display id and the tools take `incidentId` from the operator-typed field that the console includes in… no. Tools are server tools with their own body. The console should display the incident id the operator fired, and the agent prompt should tell it to use that id, supplied via `sendContextualUpdate` when the installed client exposes it. If it does not, the operator says the four-digit display id and `recall_memory` is called with the `incidentId` the console placed in a well-known dynamic variable. Follow the installed `useConversation` types. Do not invent a client-tool shim that reimplements the seven server tools in the browser.

Barge-in is a platform setting (`interruptionMode: "allow"` on tools, and do not disable first-message interruptions). Confirm by speaking over the brief; `onInterruption` should fire and the agent should stop. That is an ear check in US-026.

### `scripts/setup-agent.ts`

Idempotent. Behind `npm run agent:setup`.

```
--print-prompt     dump systemPrompt() and exit 0
--dry-run          build the payload, print it, do not POST
```

Steps:

1. Confirm the SDK methods exist on the installed client (the Context7 check). If `conversationalAi` is missing, fail with a message naming the package and telling the operator they installed the legacy `elevenlabs` package.
2. `toolDefs(env.publicBaseUrl, env.toolSharedSecret)`. Fail if `PUBLIC_BASE_URL` is localhost and we are not in `--dry-run` — ElevenLabs server tools cannot reach `localhost`.
3. Create or update seven workspace tools via `conversationalAi.tools.create` / list-and-update, **or** pass them inline on `conversationConfig` if that is what 2.63.0 accepts. Prefer the shape the types compile against.
4. `agents.create` when `ELEVENLABS_AGENT_ID` is empty; `agents.update` when it is set. Print `agentId=...` on its own line.
5. Print a reminder to write that id into `.env` as both `ELEVENLABS_AGENT_ID` and `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`. Do not write `.env` from the script (PHASE-01 owns env files).

Conversation config, using the confirmed field names (camelCase in the SDK):

- `agent.prompt.prompt` = `systemPrompt()`
- `agent.firstMessage` = `firstMessage()`
- `agent.language` = `"en"`
- `tts.voiceId` = `env.elevenLabsVoiceId` when set
- Tools as above, `interruptionMode: "allow"`, `responseTimeoutSecs <= 3`
- Turn-taking: do not set any flag that disables interruptions. If a `turn.turnEagerness` or equivalent exists on the installed types, prefer a value that allows barge-in (`eager` / `normal`, not a `patient` mode that ignores overlap). Confirm the enum on the installed types before setting it.

`--print-prompt` is how US-024 greps the guardrail without placing a live call.

### Twilio outbound (optional, 30-minute timebox)

Only after the browser console has passed the barge-in and tool-order checks. An actual ringing phone is worth points because the pitch says the system calls the medic. If the native ElevenLabs–Twilio integration is not configured in five minutes of dashboard clicking, **stop**. Do not debug SIP. Native audio bindings are forbidden.

## Acceptance Criteria

- [ ] The current agent-create payload shape and server-tool schema were confirmed against live ElevenLabs docs (Context7) and the installed `@elevenlabs/elevenlabs-js@2.63.0` types **before** the config was written; the confirmed method names are logged in `agents.md`
- [ ] `rg -n "from ['\"]elevenlabs['\"]" src app scripts` returns nothing; the only SDK import is `@elevenlabs/elevenlabs-js`
- [ ] `src/lib/voice/index.ts` default-exports an object satisfying `VoicePort`, and `VOICE_MODE=real` resolves it with no `FAKE PORT` warning
- [ ] `npm run agent:setup -- --print-prompt` prints a prompt that contains the exact sentence `The agent must never propose a treatment, dose, or diagnosis of its own.`
- [ ] The printed prompt forbids reading raw dispatch codes aloud and forbids citing an incident reference not returned by `recall_memory`
- [ ] The printed prompt specifies the tone shift from calm during the brief to clipped when confirming irreversible actions
- [ ] `npm run agent:setup` creates or updates an agent, prints `agentId=`, and is idempotent across two runs (same id, or an explicit update)
- [ ] All seven server tools are registered and point at `${PUBLIC_BASE_URL}/api/tools/*` with the `X-BlackBox-Secret` header
- [ ] Every tool description states that `propose_readback` precedes `record_decision` for anything with a dose, and the system prompt states that rule twice
- [ ] Every tool `responseTimeoutSecs` is 3 or less
- [ ] Interruption / barge-in is enabled (`interruptionMode: "allow"`; no `disableInterruptions: true`)
- [ ] `composeReadback` is pure, makes no LLM call, and for `{ drug: "epinephrine", dose: "1 milligram", route: "IV" }` returns a string containing those three substrings exactly
- [ ] `extractRationale` on all 8 `fixtures/utterances.json` rows matches the expected action / rationale split
- [ ] Fixture rows that omit a reason produce `rationale: null`; the extractor never invents one
- [ ] `GET /api/voice/signed-url` returns `{ url, agentId }` and the response body does not contain `sk_` or the API key
- [ ] `GET /api/voice/conversation-token` returns `{ token, agentId }`
- [ ] `app/voice/page.tsx` connects via `useConversation` + `conversationToken` (WebRTC), and shows connection state, mic level, and the current incident
- [ ] Speaking over the agent mid-brief stops it (`onInterruption` fires), verified by ear
- [ ] A spoken brief is derived from a real `recall_memory` invocation, verified in the server log or `onAgentToolRequest`
- [ ] Stating a drug and dose calls `propose_readback` before any `record_decision`, verified by log order
- [ ] The spoken readback contains the dose and units exactly as said
- [ ] Confirming resumes the LangGraph interrupt (or the fake graph) and the graph advances
- [ ] Stating an action with no reason produces exactly one short follow-up and inserts zero `decisions` documents
- [ ] A decision recorded by voice appears in `decisions` with a non-empty `rationale`
- [ ] The agent never speaks a raw dispatch code, verified against the transcript
- [ ] Asking `what should I give` produces a refusal plus an attributed guideline quote, never a treatment suggestion
- [ ] Time from end of medic speech to first agent audio on the brief is under about 1.5 seconds
- [ ] `close_call` produces a postmortem and a PCR draft when PHASE-11's route is present
- [ ] `npm run typecheck` passes with zero errors
- [ ] No file was created or modified outside `src/lib/voice/**`, `app/voice/**`, `app/api/voice/**`, and `scripts/setup-agent.ts`

## Verification

```bash
npm run typecheck

# Prompt and guardrail, no network required
npx tsx scripts/setup-agent.ts --print-prompt | rg -n "never propose a treatment, dose, or diagnosis"

# Readback + rationale against fixtures, ports faked
EVENTS_MODE=fake LLM_MODE=fake npx tsx -e "
import { composeReadback } from './src/lib/voice/readback';
import { extractRationale } from './src/lib/voice/rationale';
import { readFileSync } from 'fs';
const rb = composeReadback({ utterance: 'pushing one milligram of epi IV',
  drug: 'epinephrine', dose: '1 milligram', route: 'IV' });
console.log('readback', rb);
console.log('verbatim', rb.includes('1 milligram') && rb.includes('epinephrine'));
const rows = JSON.parse(readFileSync('fixtures/utterances.json','utf8'));
for (const u of rows) {
  const got = await extractRationale(u.utterance);
  console.log(u.utterance.slice(0,40), '=>', got);
}
"

# Package guard
rg -n "from ['\"]elevenlabs['\"]" src app scripts
rg -n "@elevenlabs/elevenlabs-js" src/lib/voice scripts
```

Live path (needs `ELEVENLABS_API_KEY`, `PUBLIC_BASE_URL` tunnel, PHASE-11 routes, worker optional):

```bash
npm run agent:setup
# write the printed agentId into env, then:
VOICE_MODE=real EVENTS_MODE=fake GRAPH_MODE=fake npm run dev
# open /voice, start the session, run the US-026 ear checks
```

## Handoff Note

PHASE-16: if the agent talks and the server log has no `/api/tools/*` hits, the tools are pointed at localhost instead of `PUBLIC_BASE_URL`. PHASE-15: the operator console at `/voice` is what you rehearse; the dashboard at `/` is for judges. Do not skip barge-in to save time — it is an ElevenLabs judging criterion.
