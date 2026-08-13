import { env } from "@/lib/env";
import { FIRST_MESSAGE, buildPrompt } from "./prompt";

export interface ServerToolSpec {
  name: string;
  /** Written for the model: when to call it, not what it does internally. */
  description: string;
  url: string;
  timeoutMs: number;
  parameters: Record<
    string,
    { type: "string" | "boolean"; required: boolean; description: string }
  >;
}

const baseUrl = (): string => env.publicBaseUrl.replace(/\/+$/, "");
const toolUrl = (name: string): string => `${baseUrl()}/api/tools/${name}`;

const incidentIdParam = {
  type: "string" as const,
  required: true,
  description: "The id of the incident currently on the line.",
};

/**
 * Parameter schemas match `contracts.md` §10 exactly. A parameter the handler's Zod schema does
 * not expect, or a missing required one, produces a 400 — and from the outside that is
 * indistinguishable from a model that chose not to call the tool.
 *
 * The readback ordering rule appears in `propose_readback`'s description, again in
 * `record_decision`'s, and a third time in the system prompt. Models skip a gate that a
 * description merely mentions, so it is stated as a hard rule in both directions.
 */
export const SERVER_TOOLS: ServerToolSpec[] = [
  {
    name: "recall_memory",
    description:
      "Call at the start of every call, and any time the medic asks what happened before or whether this has been seen. Returns prior decisions, postmortems, and guidance. Speak only the incident references it returns; if it returns nothing, say you have no prior record.",
    url: toolUrl("recall_memory"),
    timeoutMs: 3000,
    parameters: {
      incidentId: incidentIdParam,
      query: {
        type: "string",
        required: true,
        description: "What to look for, in the medic's words.",
      },
    },
  },
  {
    name: "get_protocol",
    description:
      "Call when the medic asks for a protocol, guideline, dose reference, or contraindication. Quote the returned text with its section title. Never answer a clinical question from your own knowledge.",
    url: toolUrl("get_protocol"),
    timeoutMs: 3000,
    parameters: {
      incidentId: incidentIdParam,
      topic: {
        type: "string",
        required: true,
        description: "The clinical topic or protocol section the medic asked about.",
      },
    },
  },
  {
    name: "log_timeline",
    description:
      "Call whenever the medic narrates something that happened. Pass their words, not a summary.",
    url: toolUrl("log_timeline"),
    timeoutMs: 2000,
    parameters: {
      incidentId: incidentIdParam,
      text: {
        type: "string",
        required: true,
        description: "What was said or done, in the medic's own words.",
      },
      source: {
        type: "string",
        required: true,
        description: 'Who it came from: "medic", "agent", or "system".',
      },
    },
  },
  {
    name: "propose_readback",
    description:
      "Call this BEFORE record_decision whenever the medic mentions a drug, a dose, or a route. Speak the returned text exactly as returned, then stop and wait for the medic to confirm. Never skip this for anything involving a dose.",
    url: toolUrl("propose_readback"),
    timeoutMs: 2000,
    parameters: {
      incidentId: incidentIdParam,
      utterance: {
        type: "string",
        required: true,
        description: "What the medic just said, verbatim.",
      },
      drug: { type: "string", required: false, description: "The drug named, if any." },
      dose: {
        type: "string",
        required: false,
        description: "The dose and units exactly as spoken, e.g. \"300 mg\". Do not convert or round.",
      },
      route: { type: "string", required: false, description: "The route named, if any." },
    },
  },
  {
    name: "confirm_readback",
    description:
      "Call the moment the medic confirms or rejects a readback. verbatimOk is false if they corrected any part of it.",
    url: toolUrl("confirm_readback"),
    timeoutMs: 3000,
    parameters: {
      incidentId: incidentIdParam,
      confirmed: {
        type: "boolean",
        required: true,
        description: "True if the medic confirmed the readback.",
      },
      verbatimOk: {
        type: "boolean",
        required: true,
        description: "False if the medic corrected any part of what you read back.",
      },
    },
  },
  {
    name: "record_decision",
    description:
      "Call when the medic states a decision and a reason. If the utterance involves a drug, dose, or route, you must already have called propose_readback and received confirmation; if you have not, call propose_readback instead of this. If the medic gave no reason, ask once for the reason first.",
    url: toolUrl("record_decision"),
    timeoutMs: 3000,
    parameters: {
      incidentId: incidentIdParam,
      utterance: {
        type: "string",
        required: true,
        description: "What the medic said, verbatim.",
      },
    },
  },
  {
    name: "close_call",
    description:
      "Call at transfer of care, when the medic says they are handing off or the call is done. Say that you are drafting the report before you call it.",
    url: toolUrl("close_call"),
    timeoutMs: 10000,
    parameters: { incidentId: incidentIdParam },
  },
];

/**
 * ElevenLabs rejects `responseTimeoutSecs` below 5 (`WebhookToolConfigInput`: "Must be between 5
 * and 300 seconds"). `SERVER_TOOLS.timeoutMs` keeps the aggressive budget the spec asks for —
 * a hung tool call is dead air, and dead air on stage is indistinguishable from a broken demo —
 * and this clamp is what makes the payload legal. Every tool still fails well inside the
 * platform's own limits.
 */
const MIN_RESPONSE_TIMEOUT_SECS = 5;

function toolPayload(spec: ServerToolSpec): unknown {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(spec.parameters)) {
    properties[name] = { type: p.type, description: p.description };
    if (p.required) required.push(name);
  }

  return {
    toolConfig: {
      type: "webhook",
      name: spec.name,
      description: spec.description,
      responseTimeoutSecs: Math.max(
        MIN_RESPONSE_TIMEOUT_SECS,
        Math.round(spec.timeoutMs / 1000),
      ),
      // Barge-in is mandatory and is a judged criterion, so it is stated rather than inherited.
      interruptionMode: "allow",
      apiSchema: {
        url: spec.url,
        method: "POST",
        // Without this every call returns 401 and the agent talks to itself for the length
        // of the demo.
        requestHeaders: { "X-BlackBox-Secret": env.toolSharedSecret },
        requestBodySchema: { type: "object", required, properties },
      },
    },
  };
}

/** The seven webhook tool payloads, in `SERVER_TOOLS` order. Register these, then pass the ids. */
export function buildToolPayloads(): unknown[] {
  return SERVER_TOOLS.map(toolPayload);
}

/**
 * Maps `SERVER_TOOLS` + prompt + voice settings into the ElevenLabs agent payload shape.
 *
 * Every ElevenLabs-specific key lives in this one function, so a 422 has exactly one file to
 * debug. Field names confirmed against the installed `@elevenlabs/elevenlabs-js` 2.63.0 types
 * rather than from memory — see `.ralph/agents.md`.
 */
export function buildAgentConfig(toolIds: string[] = []): unknown {
  return {
    name: "BlackBox",
    tags: ["blackbox", "ems"],
    conversationConfig: {
      agent: {
        firstMessage: FIRST_MESSAGE,
        language: "en",
        // Barge-in from the very first word: a medic who cannot interrupt will hate it.
        disableFirstMessageInterruptions: false,
        prompt: {
          prompt: buildPrompt(),
          toolIds,
        },
      },
      tts: {
        // Lowest-latency tier offered in this SDK version. The quality difference is inaudible
        // over a phone-quality earpiece and latency is explicitly judged.
        modelId: "eleven_flash_v2_5",
        ...(env.elevenLabsVoiceId ? { voiceId: env.elevenLabsVoiceId } : {}),
        // Mild stability: extreme stability flattens the tone shift the prompt asks for.
        stability: 0.4,
        similarityBoost: 0.7,
      },
    },
  };
}
