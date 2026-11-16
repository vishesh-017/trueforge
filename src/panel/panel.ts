import * as vscode from "vscode";

export interface SessionInfo {
  id: string;
  model: string;
  fallback: string;
  url: string;
}

export interface ContextCard {
  summary: string;
  budget: number;
  used: number;
  chosen: Array<{ path: string; reason: string; tokens: number }>;
}

export interface ReviewCard {
  id: string;
  path: string;
  explanation: string;
  hunks: Array<{ id: string; preview: string; accepted: boolean }>;
}

type Level = "info" | "error" | "fallback" | "compaction" | "subagent";

export class ForgehandPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly queue: unknown[] = [];
  onSend?: (text: string) => void;
  onCancel?: () => void;
  onNewSession?: () => void;
  onApply?: () => void;
  onReject?: () => void;
  onHunk?: (proposalId: string, hunkId: string, accepted: boolean) => void;
  onAllowCommand?: () => void;
  onDenyCommand?: () => void;
  onAllowGeneric?: () => void;
  onDenyGeneric?: () => void;
  onUndo?: () => void;
  onOpenSession?: () => void;
  onMentions?: (fragment: string) => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((message: { type: string; text?: string; proposalId?: string; hunkId?: string; accepted?: boolean; fragment?: string }) => {
      if (message.type === "send" && message.text) this.onSend?.(message.text);
      if (message.type === "cancel") this.onCancel?.();
      if (message.type === "new-session") this.onNewSession?.();
      if (message.type === "apply") this.onApply?.();
      if (message.type === "reject") this.onReject?.();
      if (message.type === "hunk" && message.proposalId && message.hunkId != null && message.accepted != null) {
        this.onHunk?.(message.proposalId, message.hunkId, message.accepted);
      }
      if (message.type === "allow-command") this.onAllowCommand?.();
      if (message.type === "deny-command") this.onDenyCommand?.();
      if (message.type === "allow-generic") this.onAllowGeneric?.();
      if (message.type === "deny-generic") this.onDenyGeneric?.();
      if (message.type === "undo") this.onUndo?.();
      if (message.type === "open-session") this.onOpenSession?.();
      if (message.type === "mentions") this.onMentions?.(message.fragment ?? "");
    });
    for (const message of this.queue) void view.webview.postMessage(message);
    this.queue.length = 0;
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("forgehand.chat.focus");
  }

  user(text: string): void {
    this.post({ type: "user", text });
  }

  delta(id: string, text: string, thread: string): void {
    this.post({ type: "delta", id, text, thread });
  }

  tool(id: string, name: string, detail: string): void {
    this.post({ type: "tool", id, name, detail });
  }

  showContext(card: ContextCard): void {
    this.post({ type: "context", ...card });
  }

  status(level: Level, text: string): void {
    this.post({ type: "status", level, text });
  }

  review(card: ReviewCard | undefined): void {
    this.post(card ? { type: "review", ...card } : { type: "clear-review" });
  }

  showCommand(command: string): void {
    this.post({ type: "command", command });
  }

  showGeneric(tool: string, preview: string): void {
    this.post({ type: "generic", tool, preview });
  }

  clearGate(): void {
    this.post({ type: "clear-gate" });
  }

  clearReview(): void {
    this.post({ type: "clear-review" });
  }

  session(info: SessionInfo): void {
    this.post({ type: "session", ...info });
  }

  busy(busy: boolean): void {
    this.post({ type: "busy", busy });
  }

  completions(items: Array<{ label: string; insert: string }>): void {
    this.post({ type: "completions", items });
  }

  private post(message: unknown): void {
    if (this.view) void this.view.webview.postMessage(message);
    else if (this.queue.length < 200) this.queue.push(message);
  }
}

function html(): string {
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px/1.45 var(--vscode-font-family); }
  header, footer, #log { padding: 10px 12px; }
  header { border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  #session { font-size: 11px; opacity: .85; }
  button, textarea { font: inherit; color: inherit; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  #log { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow: auto; }
  .bubble, .card { border-radius: 6px; padding: 8px; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-input-background); }
  .assistant { background: transparent; }
  .card { border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); }
  .fallback { border-color: var(--vscode-editorWarning-foreground); }
  .error { border-color: var(--vscode-editorError-foreground); }
  .tool { opacity: .9; font-size: 12px; }
  footer { position: sticky; bottom: 0; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); }
  textarea { width: 100%; min-height: 64px; box-sizing: border-box; resize: vertical; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px; }
  .row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  #completions { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
  #completions button { text-align: left; }
  h3 { margin: 0 0 6px; font-size: 12px; }
</style>
</head>
<body>
  <header>
    <div>
      <strong>Forgehand</strong>
      <div id="session">Connecting to TrueForge…</div>
    </div>
    <button id="open" type="button">TrueForge session</button>
  </header>
  <div id="log"></div>
  <footer>
    <div id="completions"></div>
    <textarea id="input" placeholder="Ask for a change. Use @path/to/file or @symbol:name to pin context."></textarea>
    <div class="row">
      <button id="send" class="primary" type="button">Send</button>
      <button id="stop" type="button" disabled>Stop</button>
      <button id="fresh" type="button">New session</button>
      <button id="undo" type="button">Undo last edit</button>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    const completions = document.getElementById('completions');
    const bubbles = new Map();

    function add(className, text) {
      const node = document.createElement('div');
      node.className = className;
      node.textContent = text;
      log.appendChild(node);
      node.scrollIntoView();
      return node;
    }

    document.getElementById('send').onclick = () => {
      const text = input.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'send', text });
      input.value = '';
      completions.replaceChildren();
    };
    stop.onclick = () => vscode.postMessage({ type: 'cancel' });
    document.getElementById('fresh').onclick = () => vscode.postMessage({ type: 'new-session' });
    document.getElementById('undo').onclick = () => vscode.postMessage({ type: 'undo' });
    document.getElementById('open').onclick = () => vscode.postMessage({ type: 'open-session' });
    input.addEventListener('input', () => {
      const match = input.value.match(/(?:^|\\s)@([^\\s@]*)$/);
      if (!match) { completions.replaceChildren(); return; }
      vscode.postMessage({ type: 'mentions', fragment: match[1] });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) document.getElementById('send').click();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'user') add('bubble user', message.text);
      if (message.type === 'delta') {
        let node = bubbles.get(message.id);
        if (!node) {
          node = add('bubble assistant', '');
          bubbles.set(message.id, node);
        }
        node.textContent += message.text;
        node.scrollIntoView();
      }
      if (message.type === 'tool') add('card tool', message.name + (message.detail ? '\\n' + message.detail : ''));
      if (message.type === 'status') add('card ' + message.level, message.text);
      if (message.type === 'context') {
        const lines = ['Context budget ' + message.used + ' / ' + message.budget + ' tokens', message.summary];
        for (const file of message.chosen) lines.push(file.path + ' — ' + file.reason + ' (' + file.tokens + ' tokens)');
        add('card', lines.join('\\n'));
      }
      if (message.type === 'session') {
        document.getElementById('session').textContent = message.model + '  →  ' + message.fallback + '\\n' + message.id;
      }
      if (message.type === 'busy') {
        stop.disabled = !message.busy;
        input.disabled = false;
        send.disabled = false;
        if (!message.busy) input.focus();
      }
      if (message.type === 'review') renderReview(message);
      if (message.type === 'clear-review') document.getElementById('review')?.remove();
      if (message.type === 'command') renderGate('Run this command?', message.command, 'allow-command', 'deny-command');
      if (message.type === 'generic') renderGate('Allow ' + message.tool + '?', message.preview, 'allow-generic', 'deny-generic');
      if (message.type === 'clear-gate') document.getElementById('gate')?.remove();
      if (message.type === 'completions') {
        completions.replaceChildren();
        for (const item of message.items) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = item.label;
          button.onclick = () => {
            input.value = input.value.replace(/(?:^|\\s)@[^\\s@]*$/, (token) => token.startsWith('@') ? item.insert + ' ' : token[0] + item.insert + ' ');
            completions.replaceChildren();
            input.focus();
          };
          completions.appendChild(button);
        }
      }
    });

    function renderReview(message) {
      document.getElementById('review')?.remove();
      const card = document.createElement('div');
      card.id = 'review';
      card.className = 'card';
      const title = document.createElement('h3');
      title.textContent = 'Review ' + message.path;
      card.appendChild(title);
      const why = document.createElement('div');
      why.textContent = message.explanation;
      card.appendChild(why);
      for (const hunk of message.hunks) {
        const block = document.createElement('pre');
        block.textContent = hunk.preview;
        card.appendChild(block);
        const row = document.createElement('div');
        row.className = 'row';
        row.appendChild(action(hunk.accepted ? 'Accepted' : 'Accept hunk', () => vscode.postMessage({ type: 'hunk', proposalId: message.id, hunkId: hunk.id, accepted: true })));
        row.appendChild(action('Reject hunk', () => vscode.postMessage({ type: 'hunk', proposalId: message.id, hunkId: hunk.id, accepted: false })));
        card.appendChild(row);
      }
      const row = document.createElement('div');
      row.className = 'row';
      const apply = action('Apply accepted hunks', () => vscode.postMessage({ type: 'apply' }));
      apply.className = 'primary';
      row.appendChild(apply);
      row.appendChild(action('Reject file', () => {
        vscode.postMessage({ type: 'reject' });
        input.disabled = false;
        input.focus();
      }));
      card.appendChild(row);
      log.appendChild(card);
      card.scrollIntoView();
    }

    function renderGate(titleText, body, allowType, denyType) {
      document.getElementById('gate')?.remove();
      const card = document.createElement('div');
      card.id = 'gate';
      card.className = 'card';
      const title = document.createElement('h3');
      title.textContent = titleText;
      card.appendChild(title);
      const pre = document.createElement('pre');
      pre.textContent = body;
      card.appendChild(pre);
      const row = document.createElement('div');
      row.className = 'row';
      const allow = action('Allow', () => vscode.postMessage({ type: allowType }));
      allow.className = 'primary';
      row.appendChild(allow);
      row.appendChild(action('Deny', () => vscode.postMessage({ type: denyType })));
      card.appendChild(row);
      log.appendChild(card);
      card.scrollIntoView();
    }

    function action(label, onclick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = onclick;
      return button;
    }
  </script>
</body>
</html>`;
}
