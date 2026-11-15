import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { loadSpec } from "./spec";

export interface ConnectedForge {
  client: TrueForge;
  models: string[];
  primary: string;
  fallback: string;
  agentId: string;
  mcpUrl: string;
}

export function createClient(baseUrl: string): TrueForge {
  return new TrueForge({ baseUrl, timeoutInSeconds: 900, maxRetries: 0 });
}

export async function connectForge(options: {
  baseUrl: string;
  extensionPath: string;
  mcpUrl: string;
  secret: string;
  preferredModel: string;
  preferredFallback: string;
}): Promise<ConnectedForge> {
  const client = createClient(options.baseUrl);
  const listed = await client.models.list();
  const models = listed.data.map((model) => model.name);
  if (models.length === 0) {
    throw new Error("TrueForge has no model configured. Open Settings → Models and add a provider. Put the key there, not in this repo.");
  }
  const primary = options.preferredModel && models.includes(options.preferredModel) ? options.preferredModel : models[0];
  const fallbackCandidate = options.preferredFallback && models.includes(options.preferredFallback) ? options.preferredFallback : models.find((model) => model !== primary) ?? "";
  const fallback = fallbackCandidate === primary ? "" : fallbackCandidate;
  const loaded = await loadSpec(options.extensionPath, primary);

  try {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: "remote",
        name: "forgehand-editor",
        description: "VS Code workspace tools: budgeted retrieval, read, search, proposed edits, and approved commands.",
        url: options.mcpUrl,
        auth: { type: "header", headers: { Authorization: `Bearer ${options.secret}` } },
      },
    });
  } catch (error) {
    const text = `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(error && typeof error === "object" && "body" in error ? error.body : "")}`;
    if (text.includes("Outbound URL blocked")) {
      throw new Error("TrueForge refused the editor connection because loopback hosts are blocked. Stop TrueForge and start it again with OUTBOUND_URL_ALLOWED_HOSTS=[\"127.0.0.1\",\"localhost\"]. scripts/start-trueforge.ps1 does this.");
    }
    throw error;
  }

  const agentId = await saveAgent(client, loaded.name, loaded.description, loaded.spec);
  return { client, models, primary, fallback, agentId, mcpUrl: options.mcpUrl };
}

async function saveAgent(client: TrueForge, name: string, description: string, spec: TrueForgeApi.AgentSpec): Promise<string> {
  const page = await client.agents.list();
  let existing: TrueForgeApi.Agent | undefined;
  for await (const agent of page) {
    if (agent.name === name) {
      existing = agent;
      break;
    }
  }
  if (!existing) {
    try {
      const created = await client.agents.create({ name, description, manifest: spec });
      return created.data.id;
    } catch {
      const again = await client.agents.list();
      for await (const agent of again) {
        if (agent.name === name) {
          existing = agent;
          break;
        }
      }
      if (!existing) throw new Error("Could not save the forgehand agent in TrueForge.");
    }
  }
  const updated = await client.agents.update(existing.id, { description, manifest: spec });
  return updated.data.id;
}

export async function specFor(extensionPath: string, model: string): Promise<TrueForgeApi.AgentSpec> {
  return (await loadSpec(extensionPath, model)).spec;
}
