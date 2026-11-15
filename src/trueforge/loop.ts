import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { isEventDelta, mergeEventDelta, TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { commandKey, type EditorBridge, type EditRequest } from "../editor/bridge";
import { startEditorMcp } from "../mcp/server";
import type { ReviewController } from "../review/review";
import type { ForgehandPanel } from "../panel/panel";
import { connectForge, specFor, type ConnectedForge } from "./registry";

type Outcome = { kind: "done" } | { kind: "cancelled" } | { kind: "error"; message: string };
type GateDecision = "allow" | "deny" | "cancel";

export class AgentLoop {
  private client?: TrueForge;
  private connected?: ConnectedForge;
  private mcp?: { url: string; close(): Promise<void> };
  private secret = randomUUID();
  private sessionId?: string;
  private sessionModel?: string;
  private turnId?: string;
  private generation = 0;
  private running = false;
  private chainNext: "auto" | "none" = "auto";
  private abort = new AbortController();
  private gate: Promise<void> = Promise.resolve();
  private events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  private announced = new Set<string>();
  private streamed = false;
  private commandWaiter?: (decision: GateDecision) => void;
  private genericWaiter?: (decision: GateDecision) => void;

  constructor(
    private readonly bridge: EditorBridge,
    private readonly review: ReviewController,
    private readonly panel: ForgehandPanel,
    private readonly output: vscode.OutputChannel,
    private readonly extensionPath: string,
  ) {}

  async connect(): Promise<ConnectedForge> {
    const config = vscode.workspace.getConfiguration("forgehand");
    const budget = config.get<number>("contextBudgetTokens") ?? 6000;
    this.bridge.budgetTokens = budget > 200 ? budget : 6000;
    if (!this.mcp) this.mcp = await startEditorMcp(this.bridge, this.secret);
    this.connected = await connectForge({
      baseUrl: config.get<string>("baseUrl") || "http://localhost:8790",
      extensionPath: this.extensionPath,
      mcpUrl: this.mcp.url,
      secret: this.secret,
      preferredModel: config.get<string>("model") ?? "",
      preferredFallback: config.get<string>("fallbackModel") ?? "",
    });
    this.client = this.connected.client;
    this.publishSession();
    const fallback = this.connected.fallback
      ? `Fallback ${this.connected.fallback} is armed.`
      : "No second model is configured, so automatic fallback cannot run.";
    this.panel.status("info", `TrueForge is connected. Primary model ${this.connected.primary}. ${fallback}`);
    return this.connected;
  }

  async run(prompt: string, displayText: string): Promise<void> {
    if (this.running) return;
    if (!this.connected || !this.client) {
      this.panel.status("error", "TrueForge is not connected. Start it, then run Forgehand: Retry Connection.");
      return;
    }
    this.running = true;
    this.generation += 1;
    const generation = this.generation;
    this.abort = new AbortController();
    this.panel.busy(true);
    this.panel.user(displayText);
    const models = [this.connected.primary, this.connected.fallback].filter((model): model is string => Boolean(model));
    let lastError = "";
    try {
      for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const attempts = modelIndex === 0 ? 2 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          if (generation !== this.generation) return;
          if (modelIndex === 0 && attempt === 2) {
            this.panel.status("fallback", `Primary model failed: ${lastError}. Retrying in 1.5s. Nothing was written.`);
            await delay(1500, this.abort.signal);
          }
          if (modelIndex > 0 && attempt === 1) {
            this.panel.status("fallback", `Primary model still failing (${lastError}). Falling back automatically to ${models[modelIndex]}. Workspace unchanged.`);
            this.chainNext = "none";
          }
          this.bridge.beginTurn();
        let outcome: Outcome;
        try {
          outcome = await this.oneTurn(models[modelIndex], prompt, displayText, generation);
        } catch (error) {
          if (generation !== this.generation || messageOf(error) === "cancelled") return;
          outcome = { kind: "error", message: messageOf(error) };
        }
          if (outcome.kind === "cancelled" || generation !== this.generation) return;
          if (outcome.kind === "done") {
            this.chainNext = "auto";
            return;
          }
          lastError = outcome.message;
          this.output.appendLine(`Turn error on ${models[modelIndex]}: ${lastError}`);
          if (this.bridge.appliedThisTurn > 0) {
            this.panel.status("error", `The model failed after an edit was applied, so Forgehand did not retry. ${lastError}`);
            return;
          }
          this.chainNext = "none";
        }
      }
      this.panel.status("error", `Stopped after the configured models failed. ${lastError} The workspace was not changed.`);
    } catch (error) {
      if (generation !== this.generation || messageOf(error) === "cancelled") return;
      this.panel.status("error", `Forgehand stopped: ${messageOf(error)} Nothing new was written.`);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.panel.busy(false);
      }
    }
  }

  /** Stop the current turn and send a new instruction without waiting for Stop. */
  async steer(prompt: string, displayText: string): Promise<void> {
    if (this.running) this.cancel(true);
    await this.run(prompt, displayText);
  }

  cancel(quiet = false): void {
    const wasRunning = this.running;
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.review.cancel("cancel");
    this.resolveCommand("cancel");
    this.resolveGeneric("cancel");
    this.bridge.killCommand();
    if (this.client && this.sessionId) void this.client.sessions.cancel(this.sessionId).catch(() => undefined);
    this.running = false;
    this.panel.busy(false);
    this.panel.clearReview();
    if (wasRunning && !quiet) {
      this.panel.status("info", "Cancelled. Unaccepted edits were discarded. No partial file was written.");
    }
  }

  newSession(): void {
    this.sessionId = undefined;
    this.sessionModel = undefined;
    this.turnId = undefined;
    this.chainNext = "auto";
    this.panel.status("info", "The next message starts a new TrueForge session.");
    this.publishSession();
  }

  resolveCommand(decision: GateDecision): void {
    const waiter = this.commandWaiter;
    this.commandWaiter = undefined;
    waiter?.(decision);
  }

  resolveGeneric(decision: GateDecision): void {
    const waiter = this.genericWaiter;
    this.genericWaiter = undefined;
    waiter?.(decision);
  }

  async openSession(): Promise<void> {
    const base = vscode.workspace.getConfiguration("forgehand").get<string>("baseUrl") || "http://localhost:8790";
    if (this.sessionId) await vscode.env.clipboard.writeText(this.sessionId);
    await vscode.env.openExternal(vscode.Uri.parse(base));
  }

  sessionLabel(): string {
    return this.sessionId ?? "not started";
  }

  private async oneTurn(model: string, prompt: string, title: string, generation: number): Promise<Outcome> {
    await this.ensureSession(model, title);
    if (!this.client || !this.sessionId) return { kind: "error", message: "No TrueForge session." };
    this.events.clear();
    this.announced.clear();
    this.streamed = false;
    this.turnId = undefined;
    const previousTurnId = this.chainNext;
    const stream = await this.client.sessions.createTurnStream(this.sessionId, {
      input: [{ type: "user.message", content: prompt }],
      previousTurnId,
    }, { timeoutInSeconds: 900, abortSignal: this.abort.signal });
    return this.pump(stream, generation, 0);
  }

  private async pump(stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>, generation: number, depth: number): Promise<Outcome> {
    let outcome: Outcome | undefined;
    try {
      for await (const event of stream) {
        if (generation !== this.generation) return { kind: "cancelled" };
        outcome = this.consume(event, generation) ?? outcome;
        if (outcome?.kind === "done" || outcome?.kind === "cancelled" || outcome?.kind === "error") return outcome;
      }
    } catch (error) {
      if (generation !== this.generation || this.abort.signal.aborted) return { kind: "cancelled" };
      return { kind: "error", message: messageOf(error) };
    }
    if (!outcome && this.client && this.sessionId && this.turnId && depth < 3 && generation === this.generation) {
      const resume = await this.client.sessions.subscribeToTurn(this.sessionId, this.turnId, {}, {
        timeoutInSeconds: 900,
        abortSignal: this.abort.signal,
      });
      return this.pump(resume, generation, depth + 1);
    }
    return outcome ?? { kind: "error", message: "The turn stream ended before TrueForge reported a result." };
  }

  private consume(event: TrueForgeApi.TurnStreamingEvent, generation: number): Outcome | undefined {
    if (isEventDelta(event)) {
      const base = this.events.get(event.id);
      if (base) mergeEventDelta(base, event);
      if (event.content) {
        this.streamed = true;
        this.panel.delta(event.id, event.content, event.threadId);
      }
      if (base?.type === "model.message") this.announce(base);
      return;
    }
    this.events.set(event.id, event);
    if (event.type === "turn.created") {
      this.turnId = event.turnId;
      return;
    }
    if (event.type === "model.message") {
      this.announce(event);
      if (!this.streamed && typeof event.content === "string" && event.content) {
        this.streamed = true;
        this.panel.delta(event.id, event.content, event.threadId);
      }
      return;
    }
    if (event.type === "tool.approval_required") {
      void this.enqueue(() => this.handleApproval(event, generation));
      return;
    }
    if (event.type === "tool.response_required") {
      void this.enqueue(() => this.handleQuestion(event, generation));
      return;
    }
    if (event.type === "tool.response") {
      this.onToolResponse(event);
      return;
    }
    if (event.type === "thread.created") {
      this.panel.status("subagent", `Subagent started: ${event.title}. It reads and reports; the root agent still proposes every edit.`);
      return;
    }
    if (event.type === "thread.context_compaction_started") {
      this.panel.status("compaction", `TrueForge compaction started at ${event.trigger.contextTokens} tokens (threshold ${event.trigger.thresholdTokens}). Older history is being summarized.`);
      return;
    }
    if (event.type === "thread.context_compaction_finished") {
      this.panel.status("compaction", "TrueForge compaction finished. The run is continuing with the summary.");
      return;
    }
    if (event.type === "mcp.initialize") {
      this.panel.status("info", "TrueForge attached the editor tools.");
      return;
    }
    if (event.type === "turn.done") {
      if (event.state.status === "cancelled") return { kind: "cancelled" };
      if (event.state.status === "error") return { kind: "error", message: event.state.message };
      const output = event.state.output;
      if (!this.streamed && output && typeof output.content === "string" && output.content) {
        this.panel.delta(event.id, output.content, "main");
      }
      return { kind: "done" };
    }
    return;
  }

  private announce(message: TrueForgeApi.ModelMessageEvent): void {
    for (const call of message.toolCalls ?? []) {
      if (this.announced.has(call.id)) continue;
      this.announced.add(call.id);
      const unwrapped = unwrap(call);
      const detail = unwrapped.name === "propose_edit"
        ? String(unwrapped.args.path ?? "")
        : unwrapped.name === "retrieve_context"
          ? String(unwrapped.args.query ?? "").slice(0, 200)
          : JSON.stringify(unwrapped.args).slice(0, 200);
      this.panel.tool(call.id, unwrapped.name, detail);
    }
  }

  private onToolResponse(event: TrueForgeApi.ToolResponseEvent): void {
    const name = this.toolName(event.toolCallId);
    if (name === "retrieve_context") {
      try {
        const parsed = JSON.parse(event.content) as {
          summary?: string;
          budgetTokens?: number;
          usedTokens?: number;
          chosen?: Array<{ path: string; reason: string; tokens: number }>;
        };
        if (parsed.summary && parsed.chosen) {
          this.panel.showContext({
            summary: parsed.summary,
            budget: parsed.budgetTokens ?? this.bridge.budgetTokens,
            used: parsed.usedTokens ?? 0,
            chosen: parsed.chosen,
          });
        }
      } catch {
        this.output.appendLine("retrieve_context returned text that was not JSON.");
      }
    }
  }

  private toolName(id: string): string | undefined {
    for (const event of this.events.values()) {
      if (event.type !== "model.message") continue;
      const call = event.toolCalls?.find((item) => item.id === id);
      if (call) return unwrap(call).name;
    }
    return undefined;
  }

  private async handleApproval(event: TrueForgeApi.ToolApprovalRequiredEvent, generation: number): Promise<void> {
    for (const ref of event.toolCalls) {
      if (generation !== this.generation) return;
      const source = this.events.get(ref.sourceEventId);
      const call = source?.type === "model.message" ? source.toolCalls?.find((item) => item.id === ref.id) : undefined;
      if (!call) {
        await this.sendApproval(event.threadId, ref.id, "deny", "Forgehand could not read that tool call.", generation);
        continue;
      }
      const unwrapped = unwrap(call);
      if (unwrapped.name === "propose_edit") {
        await this.reviewEdit(event.threadId, ref.id, asEdit(unwrapped.args), generation);
      } else if (unwrapped.name === "run_command") {
        await this.reviewCommand(event.threadId, ref.id, String(unwrapped.args.command ?? ""), generation);
      } else {
        await this.reviewGeneric(event.threadId, ref.id, unwrapped.name, JSON.stringify(unwrapped.args, null, 2).slice(0, 1200), generation);
      }
    }
  }

  private async reviewEdit(threadId: string, toolCallId: string, request: EditRequest, generation: number): Promise<void> {
    const preview = await this.bridge.previewEdit(request);
    if ("error" in preview) {
      this.panel.status("info", `${preview.error} Nothing was written.`);
      await this.sendApproval(threadId, toolCallId, "deny", preview.error, generation);
      return;
    }
    const decision = await this.review.review(preview);
    if (decision === "cancel" || generation !== this.generation) return;
    if (decision === "reject") {
      this.panel.status("info", `Rejected ${preview.path}. Nothing was written.`);
      await this.sendApproval(threadId, toolCallId, "deny", "The user rejected the hunks.", generation);
      return;
    }
    const content = this.review.merged(preview.key.slice(0, 12));
    if (content == null) {
      await this.sendApproval(threadId, toolCallId, "deny", "The review closed before a decision was saved.", generation);
      return;
    }
    this.bridge.stageEdit(preview.key, preview.path, preview.original, content);
    await this.sendApproval(threadId, toolCallId, "allow", undefined, generation);
  }

  private async reviewCommand(threadId: string, toolCallId: string, command: string, generation: number): Promise<void> {
    this.panel.showCommand(command);
    const decision = await new Promise<GateDecision>((resolve) => {
      this.commandWaiter = resolve;
    });
    this.panel.clearGate();
    if (decision !== "allow" || generation !== this.generation) {
      if (decision === "deny") await this.sendApproval(threadId, toolCallId, "deny", "The user denied the command.", generation);
      return;
    }
    this.bridge.allowCommand(commandKey(command));
    await this.sendApproval(threadId, toolCallId, "allow", undefined, generation);
  }

  private async reviewGeneric(threadId: string, toolCallId: string, name: string, preview: string, generation: number): Promise<void> {
    this.panel.showGeneric(name, preview);
    const decision = await new Promise<GateDecision>((resolve) => {
      this.genericWaiter = resolve;
    });
    this.panel.clearGate();
    if (decision === "cancel" || generation !== this.generation) return;
    await this.sendApproval(threadId, toolCallId, decision === "allow" ? "allow" : "deny", decision === "allow" ? undefined : "The user denied the tool.", generation);
  }

  private async handleQuestion(event: TrueForgeApi.ToolResponseRequiredEvent, generation: number): Promise<void> {
    if (!this.client || !this.sessionId || !this.turnId || generation !== this.generation) return;
    await this.client.sessions.createTurnEvents(this.sessionId, this.turnId, {
      events: event.toolCalls.map((call) => ({
        type: "user.tool_response" as const,
        threadId: event.threadId,
        toolCallId: call.id,
        content: "Proceed with the request as written. Do not ask another question.",
      })),
    }, { timeoutInSeconds: 60, abortSignal: this.abort.signal });
  }

  private async sendApproval(threadId: string, toolCallId: string, status: "allow" | "deny", reason: string | undefined, generation: number): Promise<void> {
    if (!this.client || !this.sessionId || !this.turnId || generation !== this.generation) return;
    await this.client.sessions.createTurnEvents(this.sessionId, this.turnId, {
      events: [{
        type: "user.tool_approval",
        threadId,
        toolCallId,
        approval: status === "allow" ? { status: "allow" } : { status: "deny", reason },
      }],
    }, { timeoutInSeconds: 60, abortSignal: this.abort.signal });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.gate.then(task, task);
    this.gate = run.then(() => undefined, (error) => {
      const text = messageOf(error);
      this.output.appendLine(text);
      this.panel.status("error", `The review could not be sent to TrueForge. ${text} Nothing new was written.`);
    });
    return run;
  }

  private async ensureSession(model: string, title: string): Promise<void> {
    if (!this.client) return;
    const spec = await specFor(this.extensionPath, model);
    if (!this.sessionId) {
      const created = await this.client.sessions.create({
        agent: { spec },
        metadata: { client: "forgehand" },
      });
      this.sessionId = created.data.id;
      this.sessionModel = model;
      const titleText = title.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 50) ?? "Forgehand";
      await this.client.sessions.update(this.sessionId, { title: titleText });
    } else {
      await this.client.sessions.update(this.sessionId, { agent: { spec } });
      this.sessionModel = model;
    }
    this.publishSession();
  }

  private publishSession(): void {
    const base = vscode.workspace.getConfiguration("forgehand").get<string>("baseUrl") || "http://localhost:8790";
    this.panel.session({
      id: this.sessionId ?? "starts on the next message",
      model: this.sessionModel ?? this.connected?.primary ?? "unset",
      fallback: this.connected?.fallback || "not configured",
      url: base,
    });
  }
}

function unwrap(call: TrueForgeApi.ToolCall): { name: string; args: Record<string, unknown> } {
  const args = parseRecord(call.function.arguments);
  const infoName = call.toolInfo.type === "mcp" ? call.toolInfo.name : call.toolInfo.name;
  if (infoName === "call_tool" || call.function.name === "call_tool") {
    const nested = args.arguments ?? args.tool_arguments ?? args.toolArguments ?? args.input ?? {};
    const inner = typeof nested === "string" ? parseRecord(nested) : asRecord(nested);
    const name = String(args.tool_name ?? args.toolName ?? args.name ?? "call_tool");
    return { name, args: inner };
  }
  return { name: call.toolInfo.type === "mcp" ? call.toolInfo.name : call.function.name, args };
}

function asEdit(args: Record<string, unknown>): EditRequest {
  const replacements = Array.isArray(args.replacements)
    ? args.replacements.flatMap((item) => {
      const record = asRecord(item);
      if (typeof record.old_string !== "string" || typeof record.new_string !== "string") return [];
      return [{ old_string: record.old_string, new_string: record.new_string }];
    })
    : undefined;
  return {
    path: typeof args.path === "string" ? args.path : "",
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
    new_content: typeof args.new_content === "string" ? args.new_content : undefined,
    replacements,
  };
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw || "{}"));
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    }, { once: true });
  });
}
