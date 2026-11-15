import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyReplacements, type Replacement } from "../pure/diff";
import { parseMentions } from "../pure/mentions";
import { retrieveFromFiles, type RetrievalResult } from "../pure/retrieve";

export interface EditRequest {
  path: string;
  explanation?: string;
  new_content?: string;
  replacements?: Replacement[];
}

export interface EditPreview {
  key: string;
  path: string;
  explanation: string;
  original: string;
  proposed: string;
  uri: vscode.Uri;
}

const SKIP_GLOB = "**/{.git,node_modules,dist,out,__pycache__,.venv,venv,site-packages}/**";

export function editKey(request: EditRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      path: request.path.replace(/\\/g, "/").replace(/^\.\//, ""),
      explanation: request.explanation ?? "",
      new_content: request.new_content ?? null,
      replacements: request.replacements ?? null,
    }))
    .digest("hex");
}

export function commandKey(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

interface StagedEdit {
  path: string;
  before: string;
  content: string;
  applied: boolean;
}

export class EditorBridge {
  appliedThisTurn = 0;
  budgetTokens = 6000;
  private cache = new Map<string, { mtime: number; text: string }>();
  private stagedEdits = new Map<string, StagedEdit>();
  private allowedCommands = new Set<string>();
  private running: ChildProcess | undefined;
  private undoStack: Array<{ uri: vscode.Uri; path: string; before: string }> = [];

  constructor(private readonly output: vscode.OutputChannel) {}

  beginTurn(): void {
    this.appliedThisTurn = 0;
  }

  folder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  relative(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? this.folder();
    if (!folder) return undefined;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.replace(/\\/g, "/");
  }

  async previewEdit(request: EditRequest): Promise<EditPreview | { error: string }> {
    const folder = this.folder();
    if (!folder) return { error: "Open a folder before asking Forgehand to edit." };
    const rel = this.resolvePath(request.path);
    if (!rel) return { error: "That path escapes the workspace." };
    const uri = vscode.Uri.joinPath(folder.uri, ...rel.split("/"));
    let original = "";
    let exists = false;
    try {
      original = await this.readUri(uri);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists && !request.new_content) {
      return { error: `${rel} does not exist. Pass new_content to create it.` };
    }
    if (request.new_content != null && request.replacements?.length) {
      return { error: "Pass new_content or replacements, not both." };
    }
    let proposed: string;
    if (request.new_content != null) {
      proposed = request.new_content;
    } else if (request.replacements?.length) {
      const replaced = applyReplacements(original, request.replacements);
      if (!replaced.ok) return { error: replaced.error };
      proposed = replaced.content;
    } else {
      return { error: "propose_edit needs new_content or at least one replacement." };
    }
    if (proposed === original) return { error: `The edit for ${rel} does not change the file.` };
    return {
      key: editKey({ ...request, path: rel }),
      path: rel,
      explanation: request.explanation?.trim() || "The model did not explain this file.",
      original,
      proposed,
      uri,
    };
  }

  stageEdit(key: string, path: string, before: string, content: string): void {
    this.stagedEdits.set(key, { path, before, content, applied: false });
  }

  async applyStaged(key: string): Promise<string> {
    const staged = this.stagedEdits.get(key);
    if (!staged) {
      return "Forgehand has no accepted hunks for this call. Nothing was written.";
    }
    if (staged.applied) {
      return `Already applied ${staged.path}. It was not written again.`;
    }
    const folder = this.folder();
    if (!folder) return "No workspace folder is open. Nothing was written.";
    const uri = vscode.Uri.joinPath(folder.uri, ...staged.path.split("/"));
    let current = "";
    let exists = false;
    try {
      current = await this.readUri(uri);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && current !== staged.before) {
      return `${staged.path} changed while it was being reviewed. Nothing was written.`;
    }
    const edit = new vscode.WorkspaceEdit();
    if (!exists) {
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), staged.content);
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      edit.replace(uri, whole, staged.content);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return `VS Code refused the edit to ${staged.path}. Nothing was written.`;
    staged.applied = true;
    this.appliedThisTurn += 1;
    this.undoStack.push({ uri, path: staged.path, before: staged.before });
    this.cache.delete(staged.path);
    this.output.appendLine(`Applied reviewed edit to ${staged.path}`);
    return `Applied the accepted hunks to ${staged.path}. Rejected hunks were not written. The user can undo with Ctrl+Z or Forgehand: Undo Last Applied Edit.`;
  }

  allowCommand(key: string): void {
    this.allowedCommands.add(key);
  }

  async runCommand(key: string, command: string): Promise<string> {
    if (!this.allowedCommands.has(key)) {
      return "Forgehand has no approval for this command. It did not run.";
    }
    this.allowedCommands.delete(key);
    const folder = this.folder();
    if (!folder) return "No workspace folder is open. The command did not run.";
    return this.execute(command, folder.uri.fsPath);
  }

  killCommand(): void {
    this.running?.kill();
    this.running = undefined;
  }

  async undoLast(): Promise<string | undefined> {
    const last = this.undoStack.pop();
    if (!last) return undefined;
    const edit = new vscode.WorkspaceEdit();
    let exists = true;
    try {
      await vscode.workspace.fs.stat(last.uri);
    } catch {
      exists = false;
    }
    if (!last.before && exists) {
      edit.deleteFile(last.uri, { ignoreIfNotExists: true });
    } else if (exists) {
      const document = await vscode.workspace.openTextDocument(last.uri);
      const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      edit.replace(last.uri, whole, last.before);
    } else {
      edit.createFile(last.uri, { overwrite: true });
      edit.insert(last.uri, new vscode.Position(0, 0), last.before);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    this.cache.delete(last.path);
    if (!applied) return `Could not undo ${last.path}.`;
    return last.path;
  }

  async retrieve(query: string, budgetTokens: number, pinnedPaths: string[]): Promise<RetrievalResult> {
    const files = await this.loadFiles();
    return retrieveFromFiles(files, query, budgetTokens, pinnedPaths);
  }

  async readFile(relPath: string, startLine?: number, endLine?: number): Promise<string> {
    const rel = this.resolvePath(relPath);
    if (!rel) return "That path escapes the workspace.";
    const folder = this.folder();
    if (!folder) return "No workspace folder is open.";
    const uri = vscode.Uri.joinPath(folder.uri, ...rel.split("/"));
    let text: string;
    try {
      text = await this.readUri(uri);
    } catch {
      return `${rel} does not exist.`;
    }
    const lines = text.split(/\r?\n/);
    if (!startLine && !endLine) {
      if (lines.length <= 400) return text;
      return `${lines.slice(0, 400).join("\n")}\n\n… ${lines.length - 400} more lines. Call read_file again with start_line and end_line.`;
    }
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? start + 399);
    return lines.slice(start - 1, end).map((line, index) => `${start + index}|${line}`).join("\n");
  }

  async search(query: string, glob?: string): Promise<string> {
    if (!query.trim()) return "query is empty.";
    const files = await this.loadFiles();
    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (const [file, text] of files) {
      if (glob && !matchGlob(file, glob)) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        hits.push(`${file}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        if (hits.length >= 40) return hits.join("\n");
      }
    }
    return hits.length ? hits.join("\n") : "No matches.";
  }

  async listFiles(glob?: string): Promise<string> {
    const folder = this.folder();
    if (!folder) return "No workspace folder is open.";
    const pattern = glob && glob.trim() ? glob : "**/*";
    const uris = await vscode.workspace.findFiles(pattern, SKIP_GLOB, 200);
    const paths = uris
      .map((uri) => this.relative(uri))
      .filter((value): value is string => Boolean(value))
      .sort();
    return paths.join("\n") || "No files.";
  }

  async getSymbol(name: string): Promise<string> {
    const files = await this.loadFiles();
    const wanted = name.toLowerCase();
    const hits: string[] = [];
    for (const [file, text] of files) {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const match = /^(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)|^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_][\w]*)/.exec(lines[index]);
        const found = match?.[1] ?? match?.[2];
        if (!found || found.toLowerCase() !== wanted) continue;
        const body = lines.slice(index, index + 40).join("\n");
        hits.push(`${file}:${index + 1}\n${body}`);
        if (hits.length >= 5) break;
      }
      if (hits.length >= 5) break;
    }
    return hits.length ? hits.join("\n\n") : `No definition named ${name}.`;
  }

  async gitStatus(): Promise<string> {
    const folder = this.folder();
    if (!folder) return "No workspace folder is open.";
    return this.execute("git status --short", folder.uri.fsPath);
  }

  async mentionPreamble(text: string): Promise<string> {
    const mentions = parseMentions(text);
    if (mentions.length === 0) {
      return "No explicit @mentions. Call retrieve_context with the user request. Do not guess file paths.";
    }
    const lines: string[] = ["Explicit mentions resolved by the editor. Pin these paths and still call retrieve_context:"];
    const pinned: string[] = [];
    for (const mention of mentions) {
      if (mention.kind === "file") {
        const rel = this.resolvePath(mention.value);
        lines.push(rel ? `- @file ${rel}` : `- @file ${mention.value} (not a workspace path)`);
        if (rel) pinned.push(rel);
      } else {
        const located = await this.getSymbol(mention.value);
        const first = located.split("\n")[0];
        lines.push(`- @symbol ${mention.value} -> ${first}`);
        const file = first.split(":")[0];
        if (file && !file.startsWith("No definition")) pinned.push(file);
      }
    }
    if (pinned.length) lines.push(`pinned_paths: ${JSON.stringify([...new Set(pinned)])}`);
    return lines.join("\n");
  }

  async completionItems(fragment: string): Promise<Array<{ label: string; insert: string }>> {
    const files = await this.loadFiles();
    const needle = fragment.toLowerCase();
    const items: Array<{ label: string; insert: string }> = [];
    for (const file of files.keys()) {
      if (needle && !file.toLowerCase().includes(needle)) continue;
      items.push({ label: `@${file}`, insert: `@${file}` });
      if (items.length >= 12) break;
    }
    return items;
  }

  private resolvePath(input: string): string | undefined {
    const folder = this.folder();
    const trimmed = input.trim();
    if (folder && path.isAbsolute(trimmed)) {
      const rel = path.relative(folder.uri.fsPath, trimmed);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
      return rel.replace(/\\/g, "/");
    }
    return safeRelative(trimmed);
  }

  private async loadFiles(): Promise<Map<string, string>> {
    const folder = this.folder();
    const map = new Map<string, string>();
    if (!folder) return map;
    const uris = await vscode.workspace.findFiles("**/*", SKIP_GLOB, 800);
    for (const uri of uris) {
      const rel = this.relative(uri);
      if (!rel) continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File || stat.size > 200_000) continue;
        const cached = this.cache.get(rel);
        if (cached && cached.mtime === stat.mtime) {
          map.set(rel, cached.text);
          continue;
        }
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        if (text.includes("\0")) continue;
        this.cache.set(rel, { mtime: stat.mtime, text });
        map.set(rel, text);
      } catch {
        continue;
      }
    }
    return map;
  }

  private async readUri(uri: vscode.Uri): Promise<string> {
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  private execute(command: string, cwd: string): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true });
      this.running = child;
      let output = "";
      const append = (chunk: Buffer) => {
        if (output.endsWith("… output truncated")) return;
        output += chunk.toString("utf8");
        if (output.length > 12_000) output = `${output.slice(0, 12_000)}\n… output truncated`;
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (this.running === child) this.running = undefined;
        resolve(`${output}${output.endsWith("\n") || output.length === 0 ? "" : "\n"}exit code ${code ?? "unknown"}`);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`Command failed to start: ${error.message}`);
      });
    });
  }
}

function safeRelative(input: string): string | undefined {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized || path.isAbsolute(input) || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function matchGlob(file: string, glob: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`, "i").test(file);
}
