import { getClient } from "@/lib/db/client";
import { ingestRunbooks } from "@/lib/ingest/runbooks";

function parseArgs(argv: string[]): {
  dryRun: boolean;
  forceExtract: boolean;
  sample: number;
  section: string | undefined;
} {
  let sample = 0;
  let section: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--sample=")) {
      sample = Number(arg.slice("--sample=".length));
    } else if (arg.startsWith("--section=")) {
      section = arg.slice("--section=".length);
    }
  }
  return {
    dryRun: argv.includes("--dry-run"),
    forceExtract: argv.includes("--force-extract"),
    sample: Number.isFinite(sample) ? sample : 0,
    section,
  };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  let opened = false;

  try {
    if (!flags.dryRun) {
      getClient();
      opened = true;
    }

    const result = await ingestRunbooks({
      dryRun: flags.dryRun,
      forceExtract: flags.forceExtract,
      section: flags.section,
      sample: flags.sample || undefined,
      onProgress: (stage, detail) => {
        console.log(`[${stage}] ${detail}`);
      },
    });

    console.log(
      `ok pages=${result.pages} sections=${result.sections} chunks=${result.chunks} inserted=${result.inserted}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  } finally {
    if (opened) {
      await getClient().close();
    }
  }
}

void main();
