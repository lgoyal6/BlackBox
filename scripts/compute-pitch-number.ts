/**
 * PHASE-04 pitch numbers + reclass priors. No Mongo — Socrata aggregates only.
 * `data/` is gitignored, so run this once on the demo machine:
 *
 *   npx tsx scripts/compute-pitch-number.ts --refresh
 *
 * Default reads the cache (zero network). `--offline` exits 1 if the cache is missing.
 * Optional `SOCRATA_APP_TOKEN`. Never downloads incident rows.
 */
import { existsSync } from "node:fs";
import {
  computePitchNumbers,
  computeReclassPriors,
  PITCH_NUMBERS_PATH,
  RECLASS_PRIORS_PATH,
} from "@/lib/ingest/nyc";

function printDrift(metrics: { key: string; value: number; expected: number; drift: boolean }[]): void {
  const drifted = metrics.filter((m) => m.drift);
  if (drifted.length === 0) return;
  console.error("");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("PITCH NUMBER DRIFT — trust the fresh number, update the slide");
  for (const m of drifted) {
    console.error(`  ${m.key}: fresh ${m.value}  expected ${m.expected}`);
  }
  console.error("Update overview.md's metrics table and the pitch slide. Both must match this file.");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("");
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const offline = process.argv.includes("--offline");
  const cacheExists = existsSync(PITCH_NUMBERS_PATH);

  if (offline && !cacheExists) {
    console.error(`${PITCH_NUMBERS_PATH} is missing; --offline cannot fetch.`);
    process.exitCode = 1;
    return;
  }

  const shouldFetch = !offline && (refresh || !cacheExists);
  const numbers = await computePitchNumbers({ refresh: shouldFetch });

  console.log(`pitch numbers  source=${numbers.source}  computedAt=${numbers.computedAt}  ${shouldFetch ? "fresh" : "cache"}`);
  for (const m of numbers.metrics) {
    const mark = m.drift ? "DRIFT" : "ok";
    console.log(`  ${m.key.padEnd(22)} ${String(m.value).padStart(12)}  expected ${m.expected}  ${mark}`);
  }
  printDrift(numbers.metrics);

  if (shouldFetch) {
    const priors = await computeReclassPriors();
    const unc = priors.some((p) => p.initialCallType === "UNC");
    const sick = priors.some((p) => p.initialCallType === "SICK");
    const night = priors.some((p) => p.nightOnly);
    console.log(
      `reclass priors  entries=${priors.length}  UNC=${unc}  SICK=${sick}  nightOnly=${night}  wrote ${RECLASS_PRIORS_PATH}`,
    );
  } else if (existsSync(RECLASS_PRIORS_PATH)) {
    console.log(`reclass priors  cached at ${RECLASS_PRIORS_PATH} (zero network)`);
  } else {
    console.warn(`reclass priors  ${RECLASS_PRIORS_PATH} missing; rerun with --refresh`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
