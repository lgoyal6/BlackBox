import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Document } from "mongodb";
import {
  INCIDENTS,
  callTypeFamily,
  labelFor,
  toDisplayId,
  toRef,
  type IncidentDoc,
} from "@/lib/contracts";
import { col } from "@/lib/db/client";
import { events, graph } from "@/lib/registry";

/**
 * The driver's generic requires an index signature, which an `interface` never gets
 * implicitly. Mapping over `IncidentDoc` produces a type alias that does, without restating a
 * single field or widening one.
 */
type IncidentRecord = { [K in keyof IncidentDoc]: IncidentDoc[K] };

export type FirePattern = "arrest" | "cardiac";

/** Carries the HTTP status the route should return, so `fire` needs no error string matching. */
export class CloneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloneError";
  }
}

/** The two locked demo transitions. Both are real high-volume NYC reclassifications. */
const PATTERN_SOURCE: Record<FirePattern, { initialCallType: string; finalCallType: string }> = {
  arrest: { initialCallType: "UNC", finalCallType: "ARREST" },
  cardiac: { initialCallType: "SICK", finalCallType: "CARD" },
};

/**
 * This is the one place in `app/api` allowed to touch `_groundTruth`, and only as a filter on
 * historical rows — the value never reaches the live document or any response body.
 */
function sourceFilter(pattern: FirePattern): Document {
  const { initialCallType, finalCallType } = PATTERN_SOURCE[pattern];
  return {
    isLive: false,
    "cad.initialCallType": initialCallType,
    "_groundTruth.finalCallType": finalCallType,
  };
}

function matchesPattern(doc: IncidentDoc, pattern: FirePattern): boolean {
  const want = PATTERN_SOURCE[pattern];
  const truth = (doc as { _groundTruth?: { finalCallType?: string } })._groundTruth;
  return (
    doc.cad?.initialCallType === want.initialCallType &&
    truth?.finalCallType === want.finalCallType
  );
}

/** Offline source when Atlas has no ingested rows yet. A supported path, not a failure. */
async function loadFixtureIncidents(): Promise<IncidentDoc[]> {
  const raw = await readFile(join(process.cwd(), "fixtures", "incidents.json"), "utf8");
  return JSON.parse(raw) as IncidentDoc[];
}

async function pickSource(
  pattern: FirePattern,
  incidentId?: string,
): Promise<{ source: IncidentDoc; requestedIdIsFree: boolean }> {
  if (incidentId) {
    // The caller-supplied id names a historical row to clone when one exists. When it names
    // nothing, it becomes the new live incident's id instead and the source is picked by
    // pattern — the two readings the spec allows, resolved in that order.
    const byId = await col<IncidentRecord>(INCIDENTS).findOne({ incidentId });
    if (byId) {
      if (!matchesPattern(byId, pattern)) {
        throw new CloneError(`incident ${incidentId} does not match pattern ${pattern}`, 400);
      }
      return { source: byId, requestedIdIsFree: false };
    }
    const fixtureById = (await loadFixtureIncidents()).find((i) => i.incidentId === incidentId);
    if (fixtureById) {
      if (!matchesPattern(fixtureById, pattern)) {
        throw new CloneError(`incident ${incidentId} does not match pattern ${pattern}`, 400);
      }
      return { source: fixtureById, requestedIdIsFree: false };
    }
  }

  const fromAtlas = await col<IncidentRecord>(INCIDENTS).findOne(sourceFilter(pattern));
  if (fromAtlas) return { source: fromAtlas, requestedIdIsFree: Boolean(incidentId) };

  const fixture = (await loadFixtureIncidents()).find((i) => matchesPattern(i, pattern));
  if (!fixture) {
    throw new CloneError(`no historical incident matches pattern ${pattern}`, 404);
  }
  return { source: fixture, requestedIdIsFree: Boolean(incidentId) };
}

/** Clone a historical row into a fresh `isLive: true` incident and fire the graph at it. */
export async function cloneLiveIncident(
  pattern: FirePattern,
  incidentId?: string,
): Promise<{ incidentId: string; ref: string; displayId: string }> {
  const { source, requestedIdIsFree } = await pickSource(pattern, incidentId);

  const now = new Date();
  const liveId = requestedIdIsFree && incidentId ? incidentId : `live-${Date.now()}`;
  const displayId = toDisplayId(liveId);
  const ref = toRef(liveId, now);

  const live: IncidentDoc = {
    incidentId: liveId,
    displayId,
    ref,
    status: "dispatched",
    cad: {
      initialCallType: source.cad.initialCallType,
      initialSeverityLevelCode: source.cad.initialSeverityLevelCode,
      borough: source.cad.borough,
      zipcode: source.cad.zipcode,
      dispatchArea: source.cad.dispatchArea,
      unit: source.cad.unit,
      // The call is happening now, so the header clock and the ref date both read as today.
      incidentDatetime: now,
    },
    callTypeFamily: callTypeFamily(source.cad.initialCallType),
    timeline: [],
    isLive: true,
    createdAt: now,
    updatedAt: now,
  };
  // Critical Rule 6: the answers stay quarantined on the historical seed. `live` is built
  // field by field rather than spread from `source` precisely so nothing can carry over.
  await col<IncidentRecord>(INCIDENTS).insertOne(live);

  try {
    await (await graph()).start(liveId);
  } catch (err) {
    // The worker is the production trigger; a graph mid-flight must not fail a rehearsal.
    console.error(
      `GRAPH START FAILED ${liveId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await (await events()).emit({
    kind: "status",
    incidentId: liveId,
    payload: {
      status: "dispatched",
      ref,
      label: labelFor(live.cad.initialCallType),
      dispatchArea: live.cad.dispatchArea,
      unit: live.cad.unit,
      // First status of the call and never updated — the dashboard's elapsed clock reads this.
      startedAt: now,
    },
  });

  return { incidentId: liveId, ref, displayId };
}
