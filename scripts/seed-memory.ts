/**
 * Seed postmortems + remediations. Does not write to `decisions`.
 *
 * Needs: MONGODB_URI for writes; incidents in Atlas or --from-fixtures.
 * Isolated build: EMBEDDINGS_MODE=fake LLM_MODE=fake (PowerShell: set on a prior line).
 * Default is --templated. --llm is opt-in. --dry-run writes nothing.
 *
 * Stage: npx tsx scripts/seed-memory.ts --templated
 * Verify: npx tsx scripts/seed-memory.ts --target=20 --templated --from-fixtures --dry-run
 */
import { getClient } from "@/lib/db/client";
import {
  seedMemory,
  type SeedOptions,
  type SeedReport,
} from "@/lib/memory/seed";

function parseArgs(argv: string[]): SeedOptions {
  const opts: SeedOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (arg === "--templated") opts.templated = true;
    else if (arg === "--llm") opts.llm = true;
    else if (arg === "--from-fixtures") opts.fromFixtures = true;
    else if (arg === "--curated-only") opts.curatedOnly = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--target=")) opts.target = Number(arg.slice("--target=".length));
    else if (arg === "--target" && next !== undefined) {
      opts.target = Number(next);
      i += 1;
    } else if (arg.startsWith("--concurrency=")) {
      opts.concurrency = Number(arg.slice("--concurrency=".length));
    } else if (arg === "--concurrency" && next !== undefined) {
      opts.concurrency = Number(next);
      i += 1;
    } else if (arg.startsWith("--seed=")) {
      opts.seed = Number(arg.slice("--seed=".length));
    } else if (arg === "--seed" && next !== undefined) {
      opts.seed = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  if (opts.target !== undefined && (!Number.isFinite(opts.target) || opts.target < 0)) {
    console.error("--target must be a non-negative number");
    process.exit(1);
  }
  if (opts.concurrency !== undefined && (!Number.isFinite(opts.concurrency) || opts.concurrency < 1)) {
    console.error("--concurrency must be a positive number");
    process.exit(1);
  }
  if (opts.seed !== undefined && !Number.isFinite(opts.seed)) {
    console.error("--seed must be a number");
    process.exit(1);
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: npx tsx scripts/seed-memory.ts [flags]

  --target=N         Seeded incidents (default SEED_TARGET=40)
  --templated        Skip the LLM entirely (also the default)
  --llm              Opt in to LLM narratives
  --concurrency=N    LLM parallelism (default 8)
  --seed=N           PRNG seed (default 20260813)
  --from-fixtures    Read fixtures/incidents.json instead of Atlas
  --curated-only     Re-render only the curated entries
  --dry-run          Select and generate, write nothing

Needs for a real write: MONGODB_URI, ingested incidents (or --from-fixtures),
EMBEDDINGS_MODE=fake LLM_MODE=fake until cutover. Never seeds decisions.
PowerShell: set env vars on a prior line; prefer npx tsx over npm run seed -- --target=.
`);
}

function pad(label: string, value: string | number): string {
  return `${label.padEnd(22)} ${value}`;
}

function printReport(report: SeedReport): void {
  console.log("\nSeed report");
  console.log("-".repeat(40));
  console.log(pad("selected", report.selected));
  console.log(pad("postmortemsWritten", report.postmortemsWritten));
  console.log(pad("remediationsWritten", report.remediationsWritten));
  console.log(pad("curatedWritten", report.curatedWritten));
  console.log(pad("narrativeMode", report.narrativeMode));
  console.log(pad("llmFailures", report.llmFailures));
  console.log(pad("elapsedMs", report.elapsedMs));
  const marker = report.decisionsCount === 0 ? "OK (must be 0)" : "FAIL (must be 0)";
  console.log(pad("decisionsCount", `${report.decisionsCount}  ${marker}`));

  console.log("\nbyTransition");
  const transitions = Object.entries(report.byTransition).sort((a, b) => b[1] - a[1]);
  if (transitions.length === 0) console.log("  (none)");
  for (const [name, n] of transitions) {
    console.log(`  ${name.padEnd(20)} ${n}`);
  }

  console.log("\noutcomes");
  console.log(pad("  success", report.outcomes.success));
  console.log(pad("  failure", report.outcomes.failure));
}

async function closeClient(): Promise<void> {
  try {
    await getClient().close();
  } catch {
    // never connected, or MONGODB_URI unset
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const report = await seedMemory(opts);
  printReport(report);
  if (report.decisionsCount !== 0) {
    console.error("\nAssertion failed: decisions must stay empty.");
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
