import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { commandKey, editKey, type EditorBridge } from "../editor/bridge";

const READ: { readOnlyHint: true; destructiveHint: false; openWorldHint: false } = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export async function startEditorMcp(bridge: EditorBridge, secret: string): Promise<{ url: string; close(): Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!authorized(req, secret)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/mcp") {
        json(res, 404, { error: "not found" });
        return;
      }
      const body = await readBody(req);
      const sessionId = firstHeader(req, "mcp-session-id");
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (req.method === "POST" && !sessionId && body && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const mcp = createServer(bridge);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Forgehand MCP session was not initialized." }, id: null });
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, id: null });
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve()))),
  };
}

function createServer(bridge: EditorBridge): McpServer {
  const server = new McpServer(
    { name: "forgehand-editor", version: "1.0.0" },
    { instructions: "Tools for the open VS Code workspace. propose_edit and run_command write or execute only after the user accepts them in Forgehand." },
  );

  server.registerTool("retrieve_context", {
    description: "Find the workspace files that matter for a request and pack snippets under a token budget. Returns why each file was chosen and which files were left out. Call this before reading or editing. Does not modify files. Snippets are numbered and are not valid old_string values.",
    inputSchema: {
      query: z.string().describe("The user's request, in their words."),
      budget_tokens: z.number().int().positive().optional().describe("Override the token budget. Omit to use the extension setting."),
      pinned_paths: z.array(z.string()).optional().describe("Workspace-relative paths the user mentioned with @file or @symbol."),
    },
    annotations: READ,
  }, async ({ query, budget_tokens, pinned_paths }) => {
    const budget = budget_tokens ?? bridge.budgetTokens;
    const result = await bridge.retrieve(query, budget, pinned_paths ?? []);
    return text(result);
  });

  server.registerTool("read_file", {
    description: "Read exact file text. Without a range, returns at most 400 lines. With a range, lines are prefixed with their numbers. Does not modify the file.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    },
    annotations: READ,
  }, async ({ path, start_line, end_line }) => text(await bridge.readFile(path, start_line, end_line)));

  server.registerTool("search_code", {
    description: "Case-insensitive substring search across workspace files. Read-only. Returns up to 40 matching lines.",
    inputSchema: {
      query: z.string(),
      glob: z.string().optional().describe("Optional glob such as tests/**/*.py."),
    },
    annotations: READ,
  }, async ({ query, glob }) => text(await bridge.search(query, glob)));

  server.registerTool("list_files", {
    description: "List workspace-relative file paths. Read-only. This tool is deferred: load it with get_tool_info before calling it.",
    inputSchema: { glob: z.string().optional() },
    annotations: READ,
  }, async ({ glob }) => text(await bridge.listFiles(glob)));

  server.registerTool("get_symbol", {
    description: "Find a function or class by exact name and return a short body. Read-only and deferred.",
    inputSchema: { name: z.string() },
    annotations: READ,
  }, async ({ name }) => text(await bridge.getSymbol(name)));

  server.registerTool("git_status", {
    description: "Show git status --short for the workspace. Read-only and deferred. Use it to confirm nothing was written after a cancelled or failed run.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(await bridge.gitStatus()));

  server.registerTool("propose_edit", {
    description: "Propose an edit. This does not write. TrueForge pauses so the user can accept or reject each hunk in the editor. Only accepted hunks are written, and only after approval. Prefer replacements with an exact unique old_string. Use new_content to create a file.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      explanation: z.string().describe("Why this file was chosen and what the edit does."),
      replacements: z.array(z.object({
        old_string: z.string().describe("Exact current text, unique in the file."),
        new_string: z.string(),
      })).optional(),
      new_content: z.string().optional().describe("Full new file contents. Do not combine with replacements."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: "Propose edit" },
  }, async (args) => {
    const key = editKey(args);
    const message = await bridge.applyStaged(key);
    const refused = message.startsWith("Forgehand has no") || message.includes("Nothing was written") || message.includes("refused");
    return text(message, refused);
  });

  server.registerTool("run_command", {
    description: "Run a shell command in the workspace root after the user approves it. Do not use this to edit files. Output is capped.",
    inputSchema: { command: z.string().describe("The command line to run.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, title: "Run command" },
  }, async ({ command }) => {
    const message = await bridge.runCommand(commandKey(command), command);
    return text(message, message.includes("did not run") || message.includes("failed to start"));
  });

  return server;
}

function text(value: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function authorized(req: http.IncomingMessage, secret: string): boolean {
  return firstHeader(req, "authorization") === `Bearer ${secret}`;
}

function firstHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
