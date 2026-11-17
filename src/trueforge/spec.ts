import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

interface WireDefinition {
  name: string;
  description: string;
  instructionsFile: string;
  manifest: {
    model: { params?: { temperature?: number; max_tokens?: number; parallel_tool_calls?: boolean } };
    skills?: Array<{ name: string; preload?: boolean }>;
    mcp_servers: Array<{
      name: string;
      enable_tools?: string[];
      preload?: boolean;
      preload_tools?: string[];
      require_approval_for_tools?: string[];
    }>;
    config: {
      iteration_limit?: number;
      sandbox?: { enabled?: boolean; file_downloads?: boolean; environment_name?: string };
      dynamic_sub_agents?: { enabled?: boolean };
      context_management?: {
        compaction?: { enabled?: boolean; trigger?: { type: "input_tokens"; value: number } };
        large_tool_response?: { enabled?: boolean };
      };
    };
  };
}

export async function loadSpec(extensionPath: string, model: string): Promise<{ name: string; description: string; spec: TrueForgeApi.AgentSpec }> {
  const definition = JSON.parse(await fs.readFile(path.join(extensionPath, "agent", "forgehand.json"), "utf8")) as WireDefinition;
  const instructions = await fs.readFile(path.join(extensionPath, "agent", definition.instructionsFile), "utf8");
  const compaction = definition.manifest.config.context_management?.compaction;
  const large = definition.manifest.config.context_management?.large_tool_response;
  const sandbox = definition.manifest.config.sandbox;
  const server = definition.manifest.mcp_servers[0];
  const params = definition.manifest.model.params ?? {};
  return {
    name: definition.name,
    description: definition.description,
    spec: {
      model: {
        name: model,
        params: {
          temperature: params.temperature ?? 0.2,
          maxTokens: params.max_tokens ?? 4096,
          parallelToolCalls: params.parallel_tool_calls ?? true,
        },
      },
      instructions,
      skills: (definition.manifest.skills ?? []).map((skill) => ({
        name: skill.name,
        preload: skill.preload ?? false,
      })),
      mcpServers: [
        {
          name: server.name,
          enableTools: server.enable_tools,
          preload: server.preload ?? false,
          preloadTools: server.preload_tools,
          requireApprovalForTools: server.require_approval_for_tools,
        },
      ],
      config: {
        iterationLimit: definition.manifest.config.iteration_limit ?? 48,
        sandbox: {
          enabled: sandbox?.enabled ?? true,
          fileDownloads: sandbox?.file_downloads ?? true,
          ...(sandbox?.environment_name ? { environmentName: sandbox.environment_name } : {}),
        },
        webSearch: { enabled: false },
        memory: { enabled: false },
        generativeUi: { enabled: false },
        askUserQuestions: { enabled: false },
        dynamicSubAgents: { enabled: definition.manifest.config.dynamic_sub_agents?.enabled ?? true },
        contextManagement: {
          compaction: {
            enabled: compaction?.enabled ?? true,
            trigger: compaction?.trigger ?? { type: "input_tokens", value: 12000 },
          },
          largeToolResponse: { enabled: large?.enabled ?? true },
        },
      },
    },
  };
}

export function agentPrompt(userText: string, preamble: string): string {
  return `${preamble}

Before the first edit on this request:
1. Call list_tools and get_tool_info for the forgehand-editor server so deferred tools are loaded on demand.
2. Call retrieve_context. Then tell the user which files it chose and why, using its reasons, before you edit.
3. If the change needs implementation plus tests or docs, call create_sub_agent twice to read those areas. Subagents must not edit or run commands.
4. When you need to aggregate or filter large tool output, use Code Mode in the sandbox and print only the summary.
5. Load the forgehand-edit skill when following the multi-file edit procedure.

User request:
${userText}`;
}

export function inlinePrompt(file: string, startLine: number, endLine: number, selection: string, instruction: string): string {
  return `The user selected lines ${startLine}-${endLine} of ${file} and pressed the inline-edit keybinding.

Instruction: ${instruction}

Selected code, which is the exact current text:
\`\`\`
${selection}
\`\`\`

Edit only ${file}. Call propose_edit once. old_string must be copied from the selected code above, character for character, including indentation. Do not add line numbers. If propose_edit says old_string was not found, copy the file text from that error into the next old_string. Update the docstring when the instruction asks you to. Do not edit other files, do not run commands, and do not spawn subagents.`;
}
