import type { BlackboxEvent } from "@/lib/contracts";
import type { EventsPort } from "@/lib/ports";

const buffer: BlackboxEvent[] = [];
let seq = 0;

async function emit(e: Omit<BlackboxEvent, "seq" | "t" | "_id">): Promise<void> {
  const event = { ...e, seq: ++seq, t: new Date() } as BlackboxEvent;
  buffer.push(event);
}

async function recent(incidentId: string | null, n = 200): Promise<BlackboxEvent[]> {
  const matched = incidentId === null
    ? buffer
    : buffer.filter((event) => event.incidentId === incidentId);
  return matched.slice(-n);
}

export function __drain(): BlackboxEvent[] {
  const out = buffer.splice(0, buffer.length);
  seq = 0;
  return out;
}

const events: EventsPort = { emit, recent };
export default events;
