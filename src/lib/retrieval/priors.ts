import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReclassPrior } from "@/lib/contracts";

const PRIORS_PATH = join(process.cwd(), "data", "reclass-priors.json");

let cache: Map<string, ReclassPrior> | null = null;

function key(initialCallType: string, dispatchArea: string | null): string {
  return `${initialCallType}|${dispatchArea ?? "*"}`;
}

function load(): Map<string, ReclassPrior> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = readFileSync(PRIORS_PATH, "utf8");
    const parsed = JSON.parse(raw) as ReclassPrior[];
    if (!Array.isArray(parsed)) return cache;
    for (const prior of parsed) {
      cache.set(key(prior.initialCallType, prior.dispatchArea), prior);
    }
  } catch {
    // Absent or unparseable on a fresh clone (data/ is gitignored) — degrade to null, never throw.
  }
  return cache;
}

export async function reclassPrior(
  initialCallType: string,
  dispatchArea?: string,
): Promise<ReclassPrior | null> {
  const table = load();
  const area = dispatchArea ?? null;
  return table.get(key(initialCallType, area)) ?? table.get(key(initialCallType, null)) ?? null;
}
