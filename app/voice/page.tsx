"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";

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
 */
export default function VoiceConsolePage() {
  return (
    <ConversationProvider>
      <Console />
    </ConversationProvider>
  );
}

type FiredIncident = { incidentId: string; ref: string; displayId: string };

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
  // asking ten seconds before the pitch.
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
      // conversation-token, never the WebSocket credential: a signed URL passed to a WebRTC startSession
      // throws in @elevenlabs/react 1.12.0. The token already identifies the agent, and the
      // SDK types agentId as `never` alongside it.
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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 p-6 font-mono text-sm">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">BlackBox — operator console</h1>
        <p className="opacity-60">Voice drives from here. Judges watch the dashboard.</p>
      </header>

      <section className="flex flex-col gap-3 rounded border border-current/20 p-4">
        <div className="flex items-center justify-between">
          <span className="opacity-60">connection</span>
          <span>{status}</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="opacity-60">mic</span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-current/10">
            <div
              className="h-full bg-current transition-[width] duration-100"
              style={{ width: `${Math.min(100, Math.round(micLevel * 100))}%` }}
            />
          </div>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => (connected ? endSession() : void connect())}
          className="rounded border border-current/40 px-3 py-2 disabled:opacity-40"
        >
          {connected ? "Disconnect" : "Connect"}
        </button>
      </section>

      <section className="flex flex-col gap-3 rounded border border-current/20 p-4">
        <div className="flex items-center justify-between">
          <span className="opacity-60">incident</span>
          <span>{incident ? `${incident.ref} · ${incident.displayId}` : "none"}</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void fire("arrest")}
            className="flex-1 rounded border border-current/40 px-3 py-2 disabled:opacity-40"
          >
            Fire arrest
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void fire("cardiac")}
            className="flex-1 rounded border border-current/40 px-3 py-2 disabled:opacity-40"
          >
            Fire cardiac
          </button>
        </div>
      </section>

      {error ? <p className="rounded border border-current/40 p-3">{error}</p> : null}

      {/* Tool calls are not rendered here: the hook surfaces no reliable per-call list in
          1.12.0, and the authoritative proof of tool invocation is the server log's [tool]
          lines, which is what the acceptance criteria read. Faking it here would be worse
          than omitting it. */}
    </main>
  );
}
