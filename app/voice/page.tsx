"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { RecorderGlyph } from "@/components/ui";

/**
 * The operator console — deliberately minimal, and deliberately separate from the judge
 * dashboard so the operator drives voice on one screen while judges watch the other. Keep it
 * narrow enough to sit beside the dashboard; both windows must be visible without alt-tabbing
 * during the pitch.
 *
 * Open this on http://localhost:3000/voice, not through the tunnel. The WebRTC audio path goes
 * straight from the browser to ElevenLabs and never traverses the tunnel; the tunnel exists
 * only so ElevenLabs' servers can reach /api/tools/*. Running on localhost also avoids a second
 * microphone-permission prompt.
 *
 * Styled from the same bb-* tokens as the dashboard rather than from raw utilities: the two
 * windows are side by side on stage, and a console that looks like a different product
 * undercuts the one it is driving.
 */
export default function VoiceConsolePage() {
  return (
    <ConversationProvider>
      <Console />
    </ConversationProvider>
  );
}

type FiredIncident = { incidentId: string; ref: string; displayId: string };

const STATUS_DOT: Record<string, string> = {
  connected: "bg-bb-live",
  connecting: "bg-bb-amber",
  error: "bg-bb-red",
  disconnected: "bg-bb-muted",
};

function Console() {
  const conversation = useConversation();
  const { status, startSession, endSession, getInputVolume } = conversation;

  const [micLevel, setMicLevel] = useState(0);
  const [incident, setIncident] = useState<FiredIncident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const volumeRef = useRef(getInputVolume);
  volumeRef.current = getInputVolume;

  // Answers "is the microphone actually live" in one glance, which is the question you will be
  // asking ten seconds before the pitch. The numeric readout is there because a bar that has
  // not moved and a bar that is moving a little look identical from a metre away.
  useEffect(() => {
    if (status !== "connected") {
      setMicLevel(0);
      return;
    }
    const timer = setInterval(() => {
      try {
        setMicLevel(volumeRef.current());
      } catch {
        setMicLevel(0);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [status]);

  const connect = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      // conversation-token, never the WebSocket credential: a signed URL passed to a WebRTC
      // startSession throws in @elevenlabs/react 1.12.0. The token already identifies the
      // agent, and the SDK types agentId as `never` alongside it.
      const res = await fetch("/api/voice/conversation-token");
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
      startSession({ conversationToken: body.token, connectionType: "webrtc" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [startSession]);

  const fire = useCallback(async (pattern: "arrest" | "cardiac") => {
    setError(null);
    setBusy(true);
    try {
      // An HTTP call to PHASE-11, not an import, so this stays inside the ownership rules.
      const res = await fetch("/api/demo/fire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      const body = (await res.json()) as FiredIncident & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setIncident({ incidentId: body.incidentId, ref: body.ref, displayId: body.displayId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const connected = status === "connected";
  const micPct = Math.min(100, Math.round(micLevel * 100));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col gap-4 px-6 py-6">
      <header className="flex items-center gap-2">
        <RecorderGlyph className="text-bb-red" />
        <span className="text-base font-semibold tracking-[0.18em] text-bb-text">BLACKBOX</span>
        <span className="text-sm text-bb-muted">operator</span>
      </header>

      <section className="flex flex-col gap-4 rounded-xl border border-bb-border bg-bb-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-bb-muted">Session</h2>
          <span className="inline-flex items-center gap-[6px] rounded-full border border-bb-border-strong px-[10px] py-[3px] font-mono text-sm text-bb-text">
            <span
              className={`h-[7px] w-[7px] shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-bb-muted"}`}
              aria-hidden="true"
            />
            {status}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="w-8 shrink-0 text-sm text-bb-muted">mic</span>
          <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-bb-surface-2">
            <div
              className="h-full rounded-full bg-bb-live transition-[width] duration-100"
              style={{ width: `${micPct}%` }}
            />
          </div>
          <span className="bb-tabular w-10 shrink-0 text-right font-mono text-sm text-bb-muted">
            {micPct}
          </span>
        </div>

        {/* Connect is the only action on this screen that must never be missed, so it is the
            one solid button. Everything else is bordered. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => (connected ? endSession() : void connect())}
          className={`rounded-lg px-3 py-[10px] text-[15px] font-semibold transition-colors disabled:opacity-40 ${
            connected
              ? "border border-bb-border-strong text-bb-text hover:bg-bb-surface-2"
              : "bg-bb-text text-bb-bg hover:bg-bb-muted-bright"
          }`}
        >
          {connected ? "Disconnect" : busy ? "Connecting…" : "Connect"}
        </button>
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-bb-border bg-bb-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-bb-muted">Incident</h2>
          {incident !== null ? (
            <span className="bb-tabular font-mono text-sm text-bb-text">{incident.ref}</span>
          ) : (
            <span className="text-sm text-bb-muted">none</span>
          )}
        </div>

        {/* displayId is what the agent says out loud, so the operator needs it in front of
            them to catch a fabricated reference the moment it is spoken. */}
        {incident !== null ? (
          <div className="rounded-lg border border-bb-border bg-bb-surface-2 px-3 py-[10px]">
            <p className="text-sm text-bb-muted">spoken as</p>
            <p className="bb-tabular font-mono text-[26px] font-semibold text-bb-text">
              {incident.displayId}
            </p>
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void fire("arrest")}
            className="flex-1 rounded-lg border border-bb-border-strong px-3 py-[10px] text-[15px] font-medium text-bb-text transition-colors hover:bg-bb-surface-2 disabled:opacity-40"
          >
            Fire arrest
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void fire("cardiac")}
            className="flex-1 rounded-lg border border-bb-border-strong px-3 py-[10px] text-[15px] font-medium text-bb-text transition-colors hover:bg-bb-surface-2 disabled:opacity-40"
          >
            Fire cardiac
          </button>
        </div>
      </section>

      {error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-bb-red-pill bg-bb-red-surface px-3 py-[10px] text-[15px] text-bb-red-text"
        >
          {error}
        </p>
      ) : null}

      <p className="mt-auto text-sm text-bb-muted">
        Judges watch <span className="font-mono text-bb-muted-bright">/</span> in the other
        window. Tool calls are proven by the server log, not by this screen.
      </p>

      {/* No tool-call list: the hook surfaces no reliable per-call feed in 1.12.0, and the
          authoritative proof of invocation is the server log's [tool] lines, which is what the
          acceptance criteria read. Faking it here would be worse than omitting it. */}
    </main>
  );
}
