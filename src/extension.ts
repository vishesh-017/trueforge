import * as vscode from "vscode";
import { EditorBridge } from "./editor/bridge";
import { ForgehandPanel } from "./panel/panel";
import { ReviewController } from "./review/review";
import { AgentLoop } from "./trueforge/loop";
import { agentPrompt, inlinePrompt } from "./trueforge/spec";

let loopRef: AgentLoop | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Forgehand");
  const bridge = new EditorBridge(output);
  const review = new ReviewController();
  const panel = new ForgehandPanel(context);
  const loop = new AgentLoop(bridge, review, panel, output, context.extensionPath);
  loopRef = loop;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "forgehand.openPanel";
  status.text = "$(sparkle) Forgehand";
  status.show();

  context.subscriptions.push(
    output,
    status,
    vscode.workspace.registerTextDocumentContentProvider("forgehand", review),
    vscode.languages.registerCodeLensProvider({ scheme: "forgehand" }, review),
    vscode.window.registerWebviewViewProvider("forgehand.chat", panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("forgehand.openPanel", () => panel.reveal()),
    vscode.commands.registerCommand("forgehand.cancel", () => loop.cancel()),
    vscode.commands.registerCommand("forgehand.newSession", () => loop.newSession()),
    vscode.commands.registerCommand("forgehand.undo", () => undo(bridge, panel)),
    vscode.commands.registerCommand("forgehand.acceptHunk", (proposalId: string, hunkId: string) => review.acceptHunk(proposalId, hunkId)),
    vscode.commands.registerCommand("forgehand.rejectHunk", (proposalId: string, hunkId: string) => review.rejectHunk(proposalId, hunkId)),
    vscode.commands.registerCommand("forgehand.applyReview", () => review.apply()),
    vscode.commands.registerCommand("forgehand.rejectReview", () => review.rejectFile()),
    vscode.commands.registerCommand("forgehand.inlineEdit", () => inlineEdit(bridge, panel, loop)),
    vscode.commands.registerCommand("forgehand.retryConnection", () => retry(loop, panel, status)),
  );

  review.onSnapshot = (snapshot) => panel.review(snapshot);
  panel.onSend = async (text) => {
    const preamble = await bridge.mentionPreamble(text);
    await loop.steer(agentPrompt(text, preamble), text);
  };
  panel.onCancel = () => loop.cancel();
  panel.onNewSession = () => loop.newSession();
  panel.onApply = () => review.apply();
  panel.onReject = () => {
    review.rejectFile();
    loop.cancel(true);
  };
  panel.onHunk = (proposalId, hunkId, accepted) => {
    if (accepted) review.acceptHunk(proposalId, hunkId);
    else review.rejectHunk(proposalId, hunkId);
  };
  panel.onAllowCommand = () => loop.resolveCommand("allow");
  panel.onDenyCommand = () => loop.resolveCommand("deny");
  panel.onAllowGeneric = () => loop.resolveGeneric("allow");
  panel.onDenyGeneric = () => loop.resolveGeneric("deny");
  panel.onUndo = () => undo(bridge, panel);
  panel.onOpenSession = () => void loop.openSession();
  panel.onMentions = async (fragment) => panel.completions(await bridge.completionItems(fragment));

  await retry(loop, panel, status);
}

export async function deactivate(): Promise<void> {
  loopRef?.cancel();
}

async function retry(loop: AgentLoop, panel: ForgehandPanel, status: vscode.StatusBarItem): Promise<void> {
  try {
    const connected = await loop.connect();
    status.text = `$(sparkle) Forgehand ${connected.primary}`;
    status.tooltip = connected.fallback ? `Fallback ${connected.fallback}` : "Add a second TrueForge model to enable automatic fallback.";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    status.text = "$(sparkle) Forgehand offline";
    status.tooltip = text;
    panel.status("error", `${text} Start TrueForge with npx @truefoundry/trueforge@latest, configure a model, then run Forgehand: Retry Connection.`);
  }
}

async function undo(bridge: EditorBridge, panel: ForgehandPanel): Promise<void> {
  const undone = await bridge.undoLast();
  const text = undone ? `Undid the applied edit to ${undone}.` : "There is no Forgehand edit to undo.";
  panel.status(undone ? "info" : "error", text);
  void vscode.window.showInformationMessage(text);
}

async function inlineEdit(bridge: EditorBridge, panel: ForgehandPanel, loop: AgentLoop): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage("Select the code to edit, then run Forgehand: Inline Edit.");
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: "Forgehand inline edit",
    prompt: "What should change in the selection?",
    ignoreFocusOut: true,
  });
  if (!instruction) return;
  const file = bridge.relative(editor.document.uri);
  if (!file) {
    void vscode.window.showWarningMessage("The selection is not inside the open workspace.");
    return;
  }
  await panel.reveal();
  await loop.run(inlinePrompt(file, editor.selection.start.line + 1, editor.selection.end.line + 1, editor.document.getText(editor.selection), instruction), instruction);
}
