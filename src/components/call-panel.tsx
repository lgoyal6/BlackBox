import type { ReactElement } from "react";
import type { IncidentStatus } from "@/lib/contracts";
import { formatElapsed } from "./format";
import { Pill } from "./ui";
import type { LastVoice, ReadbackView } from "./view-state";

/**
 * The phone the medic never looks at. Every element here is derived from a real event —
 * there is no waveform and no animation, because faked motion reads as theater to a judge
 * who can ask what drives it.
 */

/** Silence longer than this and we stop claiming anybody is talking. */
const SPEAKING_WINDOW_MS = 8000;

const CALL_STATE: Record<IncidentStatus, string> = {
  dispatched: "calling",
  en_route: "connected",
  on_scene: "connected",
  transporting: "connected",
  closed: "ended",
};

export interface CallPanelProps {
  status: IncidentStatus | null;
  startedAtMs: number | null;
  lastVoice: LastVoice | null;
  readback: ReadbackView | null;
  nowMs: number;
  /** False in fixture mode, where the snapshot is static and nobody is speaking. */
  live: boolean;
}

const READBACK_TEXT: Record<ReadbackView["state"], string> = {
  awaiting: "Awaiting readback",
  confirmed: "Readback confirmed",
  rejected: "Readback rejected — repeat",
};

const READBACK_TONE = {
  awaiting: "amber",
  confirmed: "neutral",
  rejected: "neutral-strong",
} as const;

export function CallPanel({
  status,
  startedAtMs,
  lastVoice,
  readback,
  nowMs,
  live,
}: CallPanelProps): ReactElement {
  const callState = status === null ? "standby" : CALL_STATE[status];
  const elapsed = formatElapsed(startedAtMs, nowMs);

  const sinceVoiceMs = lastVoice === null ? null : nowMs - lastVoice.atMs;
  const speaking =
    live && sinceVoiceMs !== null && sinceVoiceMs >= 0 && sinceVoiceMs < SPEAKING_WINDOW_MS;
  // "Agent", not "BlackBox" — the wordmark already sits at the top of the frame, and this
  // label has to match the speaker labels in the timeline.
  const who = lastVoice === null ? null : lastVoice.speaker === "agent" ? "AGENT" : "MEDIC";

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex h-full max-h-[620px] w-full max-w-[320px] flex-col rounded-[36px] border-[3px] border-bb-border-strong bg-bb-surface px-6 pb-8 pt-5">
        <div
          className="mx-auto mb-8 h-[5px] w-14 shrink-0 rounded-full bg-bb-border-strong"
          aria-hidden="true"
        />

        <div className="flex shrink-0 flex-col items-center">
          <div className="flex items-center gap-2">
            <span className="h-[9px] w-[9px] rounded-full bg-bb-red" aria-hidden="true" />
            <span className="text-base font-semibold tracking-[0.18em] text-bb-text">
              BLACKBOX
            </span>
          </div>
          <p className="mt-1 text-sm text-bb-muted">{callState}</p>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-10">
          <p className="bb-tabular font-mono text-[34px] font-medium text-bb-text">
            {elapsed === null ? (
              "-- : --"
            ) : (
              <>
                <span>{elapsed.mm}</span>
                <span className="px-[6px] text-bb-muted">:</span>
                <span>{elapsed.ss}</span>
              </>
            )}
          </p>

          <div className="flex min-h-[48px] flex-col items-center">
            {who === null ? (
              <p className="text-sm text-bb-muted">no turns yet</p>
            ) : (
              <>
                <p
                  className={`text-[17px] font-semibold tracking-[0.1em] ${speaking ? "text-bb-text" : "text-bb-muted"}`}
                >
                  {speaking ? <span aria-hidden="true">▸ </span> : null}
                  {who}
                </p>
                <p className="text-sm text-bb-muted">{speaking ? "speaking" : "listening"}</p>
              </>
            )}
          </div>
        </div>

        <div className="flex min-h-[28px] shrink-0 items-center justify-center">
          {readback !== null ? (
            <Pill tone={READBACK_TONE[readback.state]}>{READBACK_TEXT[readback.state]}</Pill>
          ) : null}
        </div>
      </div>
    </div>
  );
}
