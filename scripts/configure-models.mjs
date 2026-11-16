import { readFileSync } from "node:fs";

const source = process.argv[2] ?? "config/models.local.json";
let config;
try {
  config = JSON.parse(readFileSync(source, "utf8"));
} catch {
  console.error(`Could not read ${source}. Copy config/models.example.json to config/models.local.json and fill the base URLs. Set the API keys in the environment variables named there. This script does not print keys.`);
  process.exit(1);
}

const base = process.env.TRUEFORGE_BASE_URL ?? config.trueforgeBaseUrl ?? "http://localhost:8790";

for (const role of ["primary", "fallback"]) {
  const entry = config[role];
  if (!entry) continue;
  const apiKey = process.env[entry.apiKeyEnv];
  if (!apiKey && entry.type !== "custom") {
    console.log(`Skipping ${role}: set ${entry.apiKeyEnv} in the environment.`);
    continue;
  }
  const model = {
    name: entry.modelResourceName,
    model_id: entry.modelId,
    properties: {
      context_length: entry.contextLength,
      max_output_tokens: entry.maxOutputTokens,
    },
  };
  const manifest = entry.type === "custom"
    ? {
        type: "custom",
        name: entry.name,
        base_url: entry.baseUrl,
        models: [model],
        ...(apiKey ? { auth: { api_key: apiKey } } : {}),
      }
    : {
        type: entry.type,
        auth: { api_key: apiKey },
        models: [model],
      };
  const response = await fetch(`${base}/api/v1/settings/model-providers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`Failed to save the ${role} provider (${response.status}). TrueForge said: ${body.slice(0, 400)}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`Saved ${role} provider. Use this model FQN in Forgehand settings: ${entry.fullyQualifiedName}`);
}
