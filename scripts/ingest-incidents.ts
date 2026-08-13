/**
 * PHASE-04 NYC ingest. Needs `MONGODB_URI` in `.env.local` (Atlas or local Mongo).
 * Socrata needs no auth; optional `SOCRATA_APP_TOKEN` raises the rate limit.
 * PHASE-02 indexes are not required — upserts key on `incidentId`.
 *
 *   npx tsx scripts/ingest-incidents.ts [--dry-run] [--slice=arrest]
 *
 * Expect 100–250 historical docs (`isLive: false`). Re-run is idempotent.
 * Never downloads rows.csv. PowerShell: do not use `VAR=value cmd`; set `$env:MONGODB_URI` first.
 */
import { DEMO_SLICES, INCIDENTS } from "@/lib/contracts";
import { col, getClient } from "@/lib/db/client";
import { env } from "@/lib/env";
import { loadIncidents, type DemoSlice, type IngestReport } from "@/lib/ingest/nyc";

const SLICE_NAMES = DEMO_SLICES.map((s) => s.name);
const HISTORICAL_MIN = 100;
const HISTORICAL_MAX = 250;

function argValue(flag: string): string | undefined {
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  return undefined;
}

function formatDrops(dropped: IngestReport["dropped"]): string {
  const total = dropped.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) return "dropped 0 rows";
  const parts = dropped.map((d) => `${d.count} ${d.reason}`);
  return `dropped ${total} row${total === 1 ? "" : "s"} (${parts.join(", ")})`;
}

async function closeMongo(): Promise<void> {
  if (!env.mongodbUri) return;
  try {
    await getClient().close();
  } catch {
    // never connected
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const sliceRaw = argValue("--slice");
  if (sliceRaw && !SLICE_NAMES.includes(sliceRaw as DemoSlice["name"])) {
    console.error(`unknown slice ${sliceRaw}; expected ${SLICE_NAMES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const slice = sliceRaw as DemoSlice["name"] | undefined;

  const report = await loadIncidents({ dryRun, slice });

  console.log("NYC EMS ingest");
  console.log(`  fetched: ${Object.entries(report.fetched).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  transformed: ${report.transformed}`);
  console.log(`  duplicatesAcrossSlices: ${report.duplicatesAcrossSlices}`);
  console.log(`  ${formatDrops(report.dropped)}`);
  console.log(`  upserted: ${report.upserted}`);
  console.log(`  modified: ${report.modified}`);
  console.log(`  familyHistogram: ${JSON.stringify(report.familyHistogram)}`);
  if (report.unlabeledCodes.length === 0) {
    console.log("  unlabeledCodes: none");
  } else {
    console.log("  unlabeledCodes:");
    for (const { code, count } of report.unlabeledCodes) {
      console.log(`    ${code} × ${count}`);
    }
  }

  if (dryRun) {
    console.log("\n--dry-run sample documents (not written):");
    console.log(JSON.stringify(report.samples, null, 2));
    return;
  }

  if (slice) return;

  const historical = await col(INCIDENTS).countDocuments({ isLive: false });
  console.log(`  historical count (isLive: false): ${historical}`);
  if (historical < HISTORICAL_MIN || historical > HISTORICAL_MAX) {
    console.error(
      `historical count ${historical} is outside ${HISTORICAL_MIN}–${HISTORICAL_MAX}. ` +
      `Below ${HISTORICAL_MIN} usually means a slice came back empty (HTTP 200 with an empty body / encoding bug). ` +
      `Above ${HISTORICAL_MAX} means a $limit was raised past its contracts.md §14 constant.`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
