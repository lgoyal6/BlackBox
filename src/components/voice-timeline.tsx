import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { DOT, formatScore } from "./format";
import { Card, EmptyLine, Pill } from "./ui";
import type { DecisionCapture, ReadbackView, RecallTag, TimelineItem, VoiceTurn } from "./view-state";

const PIN_THRESHOLD_PX = 48;

/**
 * Follows new entries, but releases the moment the operator scrolls up — otherwise
 * pointing at something on stage is impossible, because an arriving event yanks the view
 * away mid-sentence. Re-pins within 48px of the bottom.
 */
export function useAutoScroll(dep: unknown): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    // Instant, not smooth: smooth scrolling fights itself during a burst of events.
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  return ref;
}

export function RecallMarker({ recall }: { recall: RecallTag }): ReactElement {
  return (
    <p className="mt-[6px] text-[15px] font-medium text-bb-muted-bright">
      <span aria-hidden="true" className="text-bb-muted">
        ↳{" "}
      </span>
      recalled from incident{" "}
      <span className="font-semibold text-bb-text">{recall.displayId}</span>
      <span className="bb-tabular text-bb-text">
        {DOT}
        {formatScore(recall.score)}
      </span>
    </p>
  );
}

export function TimelineTurn({ turn }: { turn: VoiceTurn }): ReactElement {
  const isAgent = turn.speaker === "agent";

  return (
    <div className="flex gap-3">
      <span className="bb-tabular w-11 shrink-0 pt-[2px] font-mono text-sm text-bb-muted">
        {turn.clock}
      </span>
      <div className="min-w-0 flex-1">
        {/* Label and utterance share one text flow, so a wrapped line hangs under the
            label rather than under the clock lane. */}
        <p className="text-base font-medium text-bb-text">
          <span className={`font-semibold ${isAgent ? "text-bb-red" : "text-bb-text"}`}>
            {isAgent ? "Agent" : "Medic"}
          </span>{" "}
          {turn.text}
        </p>
        {turn.recall !== null ? <RecallMarker recall={turn.recall} /> : null}
      </div>
    </div>
  );
}

/**
 * The novel artifact — the reasoning no other system records — so it must not look like
 * an ordinary turn. Spans the full inner width including the clock lane, and carries no
 * timestamp.
 */
export function DecisionBlock({ decision }: { decision: DecisionCapture }): ReactElement {
  const body = [
    decision.actionChosen,
    decision.rationaleRecorded ? "rationale recorded" : "rationale missing",
    decision.protocolConflict ? "protocol conflict" : "no protocol conflict",
  ].join(DOT);

  return (
    <div className="rounded-[4px] border-l-[3px] border-bb-red bg-bb-red-surface px-[14px] py-[10px]">
      <p className="text-sm font-medium text-bb-red-label">Decision captured</p>
      <p className="text-[15px] font-medium text-bb-red-text">{body}</p>
    </div>
  );
}

const READBACK_TEXT: Record<ReadbackView["state"], string> = {
  awaiting: "Awaiting readback",
  confirmed: "Readback confirmed",
  rejected: "Readback rejected — repeat",
};

// `rejected` is deliberately not red. Red means BlackBox is capturing; spending it on an
// error state weakens the claim the whole product rests on.
const READBACK_TONE = {
  awaiting: "amber",
  confirmed: "neutral",
  rejected: "neutral-strong",
} as const;

export function ReadbackPill({ state }: { state: ReadbackView["state"] }): ReactElement {
  return (
    <div className="ml-11">
      <Pill tone={READBACK_TONE[state]}>{READBACK_TEXT[state]}</Pill>
    </div>
  );
}

export interface VoiceTimelineProps {
  items: readonly TimelineItem[];
  readback: ReadbackView | null;
}

export function VoiceTimeline({ items, readback }: VoiceTimelineProps): ReactElement {
  const scrollRef = useAutoScroll(`${items.length}:${readback?.state ?? ""}`);

  // The pill falls back to the end of the list when its anchor matches nothing: afterSeq
  // is a UI inference, and a pill that vanished with its anchor would remove the amber
  // state the kill-and-resume beat depends on.
  const anchorExists =
    readback !== null && items.some((i) => i.seq === readback.afterSeq);

  return (
    <Card title="Voice timeline" className="min-h-0 flex-1">
      {items.length === 0 && readback === null ? (
        <EmptyLine>No turns yet</EmptyLine>
      ) : (
        <div ref={scrollRef} className="bb-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
          {items.map((item) => (
            <div key={item.seq} className="space-y-4">
              {item.type === "turn" ? (
                <TimelineTurn turn={item.turn} />
              ) : (
                <DecisionBlock decision={item.decision} />
              )}
              {readback !== null && readback.afterSeq === item.seq ? (
                <ReadbackPill state={readback.state} />
              ) : null}
            </div>
          ))}
          {readback !== null && !anchorExists ? <ReadbackPill state={readback.state} /> : null}
        </div>
      )}
    </Card>
  );
}
