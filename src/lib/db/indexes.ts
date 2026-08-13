import type { CreateIndexesOptions, Document, IndexDescriptionInfo } from "mongodb";
import {
  DECISIONS,
  EMBED_CACHE,
  EVENTS,
  INCIDENTS,
  POSTMORTEMS,
  REMEDIATIONS,
  RUNBOOKS,
  VECTOR_COLLECTIONS,
  VECTOR_PATH,
  vectorIndexName,
  WATCH_STATE,
} from "@/lib/contracts";
import { col, getDb } from "@/lib/db/client";
import { env } from "@/lib/env";

export interface CollectionReport {
  name: string;
  created: boolean;
}
export interface StandardIndexReport {
  collection: string;
  name: string;
  created: boolean;
}

export interface VectorFilterField {
  type: "filter";
  path: string;
}
export interface VectorField {
  type: "vector";
  path: string;
  numDimensions: number;
  similarity: "cosine";
}
export interface VectorIndexSpec {
  collection: string;
  name: string;
  type: "vectorSearch";
  definition: { fields: (VectorField | VectorFilterField)[] };
}

export type VectorIndexState =
  | "PENDING"
  | "BUILDING"
  | "READY"
  | "FAILED"
  | "STALE"
  | "DELETING"
  | "UNKNOWN";
export interface VectorIndexStatus {
  collection: string;
  name: string;
  status: VectorIndexState;
  queryable: boolean;
  numDimensions: number | null;
}

/** The 8 collections this phase creates. Does NOT include checkpoints/checkpoint_writes. */
export const MANAGED_COLLECTIONS: readonly string[] = [
  INCIDENTS,
  DECISIONS,
  REMEDIATIONS,
  RUNBOOKS,
  POSTMORTEMS,
  EVENTS,
  EMBED_CACHE,
  WATCH_STATE,
];

const VECTOR_FILTER_PATHS: Record<string, readonly string[]> = {
  [DECISIONS]: ["callTypeFamily", "outcome"],
  [REMEDIATIONS]: ["callTypeFamily", "outcome", "origin"],
  [POSTMORTEMS]: ["callTypeFamily", "origin"],
  [RUNBOOKS]: ["sectionTitle"],
};

const INDEX_OPTIONS_CONFLICT = 85;
const EVENTS_TTL_SECONDS = 86400;
const DEFAULT_WAIT_MS = 240_000;
const DEFAULT_POLL_MS = 3_000;
const DROP_WAIT_MS = 90_000;

interface StandardIndexSpec {
  collection: string;
  key: Record<string, 1 | -1>;
  name: string;
  unique?: true;
  expireAfterSeconds?: number;
}

const STANDARD_INDEXES: readonly StandardIndexSpec[] = [
  { collection: INCIDENTS, key: { incidentId: 1 }, name: "incidents_incidentId_uq", unique: true },
  { collection: INCIDENTS, key: { status: 1 }, name: "incidents_status" },
  { collection: INCIDENTS, key: { isLive: 1 }, name: "incidents_isLive" },
  { collection: DECISIONS, key: { incidentId: 1, t: -1 }, name: "decisions_incidentId_t" },
  { collection: REMEDIATIONS, key: { incidentId: 1, outcome: 1 }, name: "remediations_incidentId_outcome" },
  { collection: POSTMORTEMS, key: { incidentId: 1, origin: 1 }, name: "postmortems_incidentId_origin" },
  { collection: RUNBOOKS, key: { sectionTitle: 1 }, name: "runbooks_sectionTitle" },
  { collection: EMBED_CACHE, key: { hash: 1 }, name: "embed_cache_hash_uq", unique: true },
  { collection: EVENTS, key: { incidentId: 1, seq: 1 }, name: "events_incidentId_seq" },
  // mongod's TTL monitor sweeps once every 60 seconds, so an expired event can
  // survive up to a minute past its 24 hours. Harmless here.
  {
    collection: EVENTS,
    key: { t: 1 },
    name: "events_ttl_t",
    expireAfterSeconds: EVENTS_TTL_SECONDS,
  },
];

const STATES: readonly VectorIndexState[] = [
  "PENDING",
  "BUILDING",
  "READY",
  "FAILED",
  "STALE",
  "DELETING",
  "UNKNOWN",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSearchIndexQuotaError(error: unknown): boolean {
  return /maximum|quota|not allowed|too many|limit of \d+ search/i.test(errorMessage(error));
}

function wrapSearchIndexError(error: unknown, spec: VectorIndexSpec): Error {
  const msg = errorMessage(error);
  if (isSearchIndexQuotaError(error)) {
    return new Error(
      `Cluster cannot host 4 vector search indexes (Atlas M0 caps at 3). ` +
        `Provision Flex or higher. Failed creating ${spec.name}: ${msg}`,
    );
  }
  return error instanceof Error ? error : new Error(msg);
}

async function collectionNames(): Promise<Set<string>> {
  const listed = await getDb().listCollections({}, { nameOnly: true }).toArray();
  return new Set(listed.map((entry) => entry.name));
}

export async function ensureCollections(): Promise<CollectionReport[]> {
  const existing = await collectionNames();
  const reports: CollectionReport[] = [];
  for (const name of MANAGED_COLLECTIONS) {
    if (existing.has(name)) {
      reports.push({ name, created: false });
      continue;
    }
    await getDb().createCollection(name);
    reports.push({ name, created: true });
  }
  return reports;
}

export async function ensureStandardIndexes(): Promise<StandardIndexReport[]> {
  const reports: StandardIndexReport[] = [];
  for (const spec of STANDARD_INDEXES) {
    reports.push(await ensureOneStandardIndex(spec));
  }
  return reports;
}

async function ensureOneStandardIndex(spec: StandardIndexSpec): Promise<StandardIndexReport> {
  const collection = col(spec.collection);
  const existing = await collection.indexes();
  const found = existing.find((index) => index.name === spec.name);

  if (found) {
    if (spec.expireAfterSeconds !== undefined) {
      await ensureTtlSeconds(found, spec);
    }
    return { collection: spec.collection, name: spec.name, created: false };
  }

  const options: CreateIndexesOptions = { name: spec.name };
  if (spec.unique) options.unique = true;
  if (spec.expireAfterSeconds !== undefined) options.expireAfterSeconds = spec.expireAfterSeconds;

  try {
    await collection.createIndex(spec.key, options);
  } catch (error) {
    if (errorCode(error) === INDEX_OPTIONS_CONFLICT && spec.expireAfterSeconds !== undefined) {
      await getDb().command({
        collMod: spec.collection,
        index: { name: spec.name, expireAfterSeconds: spec.expireAfterSeconds },
      });
      return { collection: spec.collection, name: spec.name, created: false };
    }
    throw error;
  }
  return { collection: spec.collection, name: spec.name, created: true };
}

async function ensureTtlSeconds(found: IndexDescriptionInfo, spec: StandardIndexSpec): Promise<void> {
  if (spec.expireAfterSeconds === undefined) return;
  if (found.expireAfterSeconds === spec.expireAfterSeconds) return;
  await getDb().command({
    collMod: spec.collection,
    index: { name: spec.name, expireAfterSeconds: spec.expireAfterSeconds },
  });
}

/** Pure function — no I/O. Unit-testable without a cluster. */
export function vectorIndexSpec(collection: string): VectorIndexSpec {
  const filters = VECTOR_FILTER_PATHS[collection];
  if (!filters) {
    throw new Error(`No vector index spec for collection ${JSON.stringify(collection)}`);
  }
  const fields: (VectorField | VectorFilterField)[] = [
    {
      type: "vector",
      path: VECTOR_PATH,
      numDimensions: env.embeddingDim,
      similarity: "cosine",
    },
    ...filters.map((path): VectorFilterField => ({ type: "filter", path })),
  ];
  return {
    collection,
    name: vectorIndexName(collection),
    type: "vectorSearch",
    definition: { fields },
  };
}

export function vectorIndexSpecs(): VectorIndexSpec[] {
  return VECTOR_COLLECTIONS.map((collection) => vectorIndexSpec(collection));
}

interface SearchIndexListing {
  name: string;
  status: VectorIndexState;
  queryable: boolean;
  numDimensions: number | null;
  similarity: string | null;
  vectorPath: string | null;
  filterPaths: string[];
  raw: Document;
}

function parseState(raw: unknown): VectorIndexState {
  const value = typeof raw === "string" ? raw.toUpperCase() : "UNKNOWN";
  return STATES.includes(value as VectorIndexState) ? (value as VectorIndexState) : "UNKNOWN";
}

function parseSearchIndex(doc: Document): SearchIndexListing {
  const definition = (doc.latestDefinition ?? doc.latestDefinitionNoDefaults ?? {}) as Document;
  const fields = Array.isArray(definition.fields) ? (definition.fields as Document[]) : [];
  const vector = fields.find((field) => field.type === "vector");
  const filterPaths = fields
    .filter((field) => field.type === "filter" && typeof field.path === "string")
    .map((field) => String(field.path))
    .sort();
  return {
    name: typeof doc.name === "string" ? doc.name : "",
    status: parseState(doc.status),
    queryable: Boolean(doc.queryable),
    numDimensions: typeof vector?.numDimensions === "number" ? vector.numDimensions : null,
    similarity: typeof vector?.similarity === "string" ? vector.similarity : null,
    vectorPath: typeof vector?.path === "string" ? vector.path : null,
    filterPaths,
    raw: doc,
  };
}

async function listSearchIndexesOn(collection: string): Promise<SearchIndexListing[]> {
  const docs = await col(collection).listSearchIndexes().toArray();
  return docs.map(parseSearchIndex);
}

function specMatches(existing: SearchIndexListing, spec: VectorIndexSpec): boolean {
  const expectedVector = spec.definition.fields.find((field) => field.type === "vector");
  const expectedFilters = spec.definition.fields
    .filter((field): field is VectorFilterField => field.type === "filter")
    .map((field) => field.path)
    .sort();
  if (!expectedVector || expectedVector.type !== "vector") return false;
  if (existing.numDimensions !== expectedVector.numDimensions) return false;
  if (existing.similarity !== expectedVector.similarity) return false;
  if (existing.vectorPath !== expectedVector.path) return false;
  if (existing.filterPaths.length !== expectedFilters.length) return false;
  return existing.filterPaths.every((path, i) => path === expectedFilters[i]);
}

function failedDetail(doc: Document): string {
  const bits = [doc.statusDetail, doc.error, doc.detailedError, doc.message]
    .filter((value) => value !== undefined)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)));
  return bits.length > 0 ? bits.join(" ") : JSON.stringify(doc);
}

async function waitUntilSearchIndexGone(collection: string, name: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DROP_WAIT_MS) {
    const listed = await col(collection).listSearchIndexes(name).toArray();
    if (listed.length === 0) return;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${name} to drop on ${collection}`);
}

async function dropOneVectorIndex(collection: string, name: string): Promise<void> {
  try {
    await col(collection).dropSearchIndex(name);
  } catch (error) {
    const msg = errorMessage(error);
    if (/not found|does not exist|no such index/i.test(msg)) return;
    throw error;
  }
  await waitUntilSearchIndexGone(collection, name);
}

export async function dropVectorIndexes(): Promise<void> {
  for (const spec of vectorIndexSpecs()) {
    await dropOneVectorIndex(spec.collection, spec.name);
  }
}

async function createOneVectorIndex(spec: VectorIndexSpec): Promise<void> {
  try {
    await col(spec.collection).createSearchIndex({
      name: spec.name,
      type: spec.type,
      definition: spec.definition,
    });
  } catch (error) {
    throw wrapSearchIndexError(error, spec);
  }
}

/** Skips indexes that already exist and match; drops and recreates ones whose numDimensions is wrong. */
export async function ensureVectorIndexes(): Promise<
  { spec: VectorIndexSpec; action: "created" | "recreated" | "unchanged" }[]
> {
  const results: { spec: VectorIndexSpec; action: "created" | "recreated" | "unchanged" }[] = [];
  for (const spec of vectorIndexSpecs()) {
    const listed = await listSearchIndexesOn(spec.collection);
    const existing = listed.find((index) => index.name === spec.name);
    if (existing && specMatches(existing, spec)) {
      results.push({ spec, action: "unchanged" });
      continue;
    }
    if (existing) {
      const from = existing.numDimensions;
      await dropOneVectorIndex(spec.collection, spec.name);
      await createOneVectorIndex(spec);
      if (from !== env.embeddingDim) {
        console.log(`recreated ${spec.name}: numDimensions ${from} -> ${env.embeddingDim}`);
      }
      results.push({ spec, action: "recreated" });
      continue;
    }
    await createOneVectorIndex(spec);
    results.push({ spec, action: "created" });
  }
  return results;
}

export async function listVectorIndexStatus(): Promise<VectorIndexStatus[]> {
  const statuses: VectorIndexStatus[] = [];
  for (const spec of vectorIndexSpecs()) {
    const listed = await listSearchIndexesOn(spec.collection);
    const existing = listed.find((index) => index.name === spec.name);
    statuses.push({
      collection: spec.collection,
      name: spec.name,
      status: existing?.status ?? "UNKNOWN",
      queryable: existing?.queryable ?? false,
      numDimensions: existing?.numDimensions ?? null,
    });
  }
  return statuses;
}

export async function waitForVectorIndexes(opts?: {
  timeoutMs?: number;
  pollMs?: number;
  onPoll?: (elapsedMs: number, statuses: VectorIndexStatus[]) => void;
}): Promise<VectorIndexStatus[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const started = Date.now();

  while (true) {
    const statuses = await listVectorIndexStatus();
    const elapsedMs = Date.now() - started;
    opts?.onPoll?.(elapsedMs, statuses);

    const failed = statuses.find((status) => status.status === "FAILED");
    if (failed) {
      const listed = await listSearchIndexesOn(failed.collection);
      const raw = listed.find((index) => index.name === failed.name)?.raw ?? {};
      throw new Error(
        `Vector index ${failed.name} reported FAILED: ${failedDetail(raw)}`,
      );
    }

    const ready = statuses.every(
      (status) => status.status === "READY" && status.queryable,
    );
    if (ready) return statuses;

    if (elapsedMs >= timeoutMs) {
      const summary = statuses
        .map((status) => `${status.name}=${status.status}/queryable=${status.queryable}`)
        .join(", ");
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for vector indexes to become READY. Last: ${summary}`,
      );
    }
    await sleep(pollMs);
  }
}
