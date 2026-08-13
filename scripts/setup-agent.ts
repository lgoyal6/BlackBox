import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { env } from "@/lib/env";
import { SERVER_TOOLS, buildAgentConfig, buildToolPayloads } from "@/lib/voice/agent-config";
import { buildPrompt } from "@/lib/voice/prompt";

/**
 * Creates or updates the ElevenLabs agent.
 *
 *   --print-prompt   dump the resolved system prompt and exit, no network
 *   --dry-run        print the full agent payload and exit, no network
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  // The prompt is the part most worth reading with human eyes before going live.
  if (args.has("--print-prompt")) {
    console.log(buildPrompt());
    process.exit(0);
  }

  if (args.has("--dry-run")) {
    console.log(JSON.stringify({ tools: buildToolPayloads(), agent: buildAgentConfig() }, null, 2));
    process.exit(0);
  }

  // ElevenLabs' servers cannot reach localhost, and the resulting failure is an agent that
  // sounds perfect and never calls a tool — the worst failure mode in this build, and one that
  // survives a full rehearsal unnoticed.
  const base = env.publicBaseUrl.trim();
  if (!base || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base)) {
    console.error(
      "PUBLIC_BASE_URL must be a tunnel URL reachable from ElevenLabs' servers. " +
        `Got ${JSON.stringify(base)}. Start a tunnel and set PUBLIC_BASE_URL to its https URL.`,
    );
    process.exit(1);
  }

  if (!env.elevenLabsApiKey) {
    console.error("ELEVENLABS_API_KEY is not set.");
    process.exit(1);
  }
  if (!env.toolSharedSecret) {
    console.error("TOOL_SHARED_SECRET is not set — every tool call would return 401.");
    process.exit(1);
  }

  // Printed before anything is sent, so a wrong PUBLIC_BASE_URL is caught by eye in one second.
  console.log("Tool URLs:");
  for (const tool of SERVER_TOOLS) {
    console.log(`  ${tool.name.padEnd(18)} ${tool.url}`);
  }

  const client = new ElevenLabsClient({ apiKey: env.elevenLabsApiKey });

  // Tools live in their own registry in 2.63.0; the agent references them by id. Re-register by
  // name so a second run updates rather than duplicating.
  const existingTools = await client.conversationalAi.tools.list();
  const byName = new Map<string, string>();
  for (const tool of (existingTools as { tools?: unknown[] }).tools ?? []) {
    const t = tool as { id?: string; toolConfig?: { name?: string } };
    if (t.id && t.toolConfig?.name) byName.set(t.toolConfig.name, t.id);
  }

  const toolIds: string[] = [];
  const payloads = buildToolPayloads();
  for (let i = 0; i < SERVER_TOOLS.length; i += 1) {
    const name = SERVER_TOOLS[i].name;
    const payload = payloads[i] as Parameters<typeof client.conversationalAi.tools.create>[0];
    const existingId = byName.get(name);
    if (existingId) {
      await client.conversationalAi.tools.update(existingId, payload);
      toolIds.push(existingId);
      console.log(`  updated tool ${name} (${existingId})`);
    } else {
      const created = await client.conversationalAi.tools.create(payload);
      const id = (created as { id?: string }).id;
      if (!id) throw new Error(`tool ${name} was created without an id`);
      toolIds.push(id);
      console.log(`  created tool ${name} (${id})`);
    }
  }

  const config = buildAgentConfig(toolIds) as Parameters<
    typeof client.conversationalAi.agents.create
  >[0];

  // Idempotent via the stored id. Creating a duplicate agent every run is how you end up
  // debugging a stale one.
  if (env.elevenLabsAgentId) {
    await client.conversationalAi.agents.update(env.elevenLabsAgentId, config);
    console.log(`Updated agent ${env.elevenLabsAgentId}`);
    process.exit(0);
  }

  const created = await client.conversationalAi.agents.create(config);
  const agentId = (created as { agentId?: string }).agentId;
  console.log(`Created agent ${agentId}`);
  console.log(
    `Write this into .env as BOTH:\n  ELEVENLABS_AGENT_ID=${agentId}\n  NEXT_PUBLIC_ELEVENLABS_AGENT_ID=${agentId}`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`setup-agent failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
