export interface RetrievedFile {
  path: string;
  score: number;
  reason: string;
  tokens: number;
  startLine: number;
  snippet: string;
}

export interface RetrievalResult {
  strategy: string;
  budgetTokens: number;
  pinBudgetTokens: number;
  usedTokens: number;
  pinUsedTokens: number;
  pinned: RetrievedFile[];
  chosen: RetrievedFile[];
  omitted: Array<{ path: string; score: number; reason: string }>;
  summary: string;
}

const STOP = new Set([
  "the", "and", "with", "that", "this", "from", "your", "into", "each", "file", "code", "user",
  "should", "must", "have", "been", "were", "they", "them", "for", "are", "was", "not", "you",
  "its", "per", "any", "all", "but", "can", "will", "just", "than", "then", "also", "only",
  "when", "what", "which", "while", "where", "how", "why", "new", "add", "use", "using",
  "other", "alongside", "built", "print", "prints", "loaded", "every", "value", "values",
]);

const SKIP = /(^|\/)(\.git|node_modules|dist|out|__pycache__|\.venv|venv|site-packages)(\/|$)/;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function tokenize(query: string): string[] {
  const raw = query.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 3 && !STOP.has(token));
  return [...new Set(raw)];
}

export function retrieveFromFiles(
  files: Map<string, string>,
  query: string,
  budgetTokens: number,
  pinnedPaths: string[] = [],
): RetrievalResult {
  const tokens = tokenize(query);
  const wantsTests = /\btests?\b/i.test(query);
  const wantsDocs = /\bdocs?|document/i.test(query);
  const wantsCli = /\bcli\b|\bcommand\b/i.test(query);
  const pinBudget = Math.min(2000, Math.max(400, Math.floor(budgetTokens / 3)));
  const pinnedSet = new Set(pinnedPaths.map(normalizePath));

  const ranked: RetrievedFile[] = [];
  for (const [path, content] of files) {
    const normalized = normalizePath(path);
    if (SKIP.test(normalized) || content.includes("\0")) continue;
    const built = scoreFile(normalized, content, tokens, { wantsTests, wantsDocs, wantsCli });
    if (built) ranked.push(built);
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const pinned: RetrievedFile[] = [];
  let pinUsed = 0;
  for (const path of pinnedPaths) {
    const normalized = normalizePath(path);
    const content = files.get(normalized) ?? files.get(path);
    if (content == undefined) continue;
    const snippet = clipSnippet(content, 1, 40);
    const tokensUsed = estimateTokens(snippet.text);
    if (pinUsed + tokensUsed > pinBudget && pinned.length > 0) break;
    pinUsed += tokensUsed;
    pinned.push({
      path: normalized,
      score: 0,
      reason: "Pinned because the user mentioned it explicitly with @.",
      tokens: tokensUsed,
      startLine: snippet.startLine,
      snippet: snippet.text,
    });
  }

  const chosen: RetrievedFile[] = [];
  const omitted: RetrievalResult["omitted"] = [];
  let used = 0;
  for (const file of ranked) {
    if (pinnedSet.has(file.path)) continue;
    const room = budgetTokens - used;
    if (room <= 80) {
      if (omitted.length < 6) omitted.push({ path: file.path, score: file.score, reason: "Above the token budget." });
      continue;
    }
    let next = file;
    if (file.tokens > room) {
      const clipped = clipToTokens(file.snippet, room);
      next = { ...file, snippet: clipped, tokens: estimateTokens(clipped), reason: `${file.reason} Snippet truncated to the remaining budget.` };
    }
    if (used + next.tokens > budgetTokens && chosen.length > 0) {
      if (omitted.length < 6) omitted.push({ path: file.path, score: file.score, reason: "Above the token budget." });
      continue;
    }
    chosen.push(next);
    used += next.tokens;
  }

  const summary = summarize(budgetTokens, used, pinBudget, pinUsed, chosen, omitted);
  return {
    strategy: "Hybrid lexical and symbol retrieval. Files are scored from path tokens, identifier definitions, and capped content hits. Test, doc, and CLI intent in the query boosts those paths. Snippets are packed until the token budget is spent. Explicit @mentions are pinned on a separate budget and are not competing with automatic hits.",
    budgetTokens,
    pinBudgetTokens: pinBudget,
    usedTokens: used,
    pinUsedTokens: pinUsed,
    pinned,
    chosen,
    omitted,
    summary,
  };
}

function scoreFile(
  path: string,
  content: string,
  tokens: string[],
  intent: { wantsTests: boolean; wantsDocs: boolean; wantsCli: boolean },
): RetrievedFile | undefined {
  if (tokens.length === 0) return undefined;
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const lines = content.split(/\r?\n/);
  const symbols = extractSymbols(lines);
  const reasons: string[] = [];
  let score = 0;

  for (const token of tokens) {
    if (fileName.includes(token)) {
      score += 12;
      reasons.push(`filename matches "${token}"`);
    } else if (lowerPath.includes(token)) {
      score += 4;
      reasons.push(`path matches "${token}"`);
    }
    const symbolHit = symbols.find((symbol) => symbol.name.toLowerCase() === token || symbol.name.toLowerCase().includes(token));
    if (symbolHit) {
      score += 9;
      reasons.push(`defines ${symbolHit.kind} ${symbolHit.name}`);
    }
    let hits = 0;
    for (const line of lines) {
      if (line.toLowerCase().includes(token)) hits += 1;
      if (hits >= 8) break;
    }
    if (hits > 0) {
      score += hits;
      reasons.push(`${hits} line${hits === 1 ? "" : "s"} mention "${token}"`);
    }
  }

  if (intent.wantsTests && /(^|\/)(tests?|spec)\//.test(lowerPath)) {
    score += 10;
    reasons.push("query asks for a test and this file is in a test path");
  }
  if (intent.wantsDocs && /(^|\/)(docs?|documentation)\//.test(lowerPath)) {
    score += 8;
    reasons.push("query asks for documentation and this file is in a docs path");
  }
  if (intent.wantsCli && /cli|command/.test(lowerPath)) {
    score += 8;
    reasons.push("query is about a command and the path looks like a CLI module");
  }

  if (score <= 0) return undefined;
  const best = bestWindow(lines, tokens, symbols);
  const snippet = clipSnippet(lines.join("\n"), best.startLine, 36);
  return {
    path,
    score,
    reason: unique(reasons).slice(0, 4).join("; "),
    tokens: estimateTokens(snippet.text),
    startLine: snippet.startLine,
    snippet: snippet.text,
  };
}

interface SymbolHit {
  name: string;
  kind: "function" | "class";
  line: number;
}

function extractSymbols(lines: string[]): SymbolHit[] {
  const symbols: SymbolHit[] = [];
  const pattern = /^(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)|^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_][\w]*)/;
  lines.forEach((line, index) => {
    const match = pattern.exec(line);
    if (!match) return;
    const name = match[1] ?? match[2];
    if (!name) return;
    symbols.push({ name, kind: line.includes("class") ? "class" : "function", line: index + 1 });
  });
  return symbols;
}

function bestWindow(lines: string[], tokens: string[], symbols: SymbolHit[]): { startLine: number } {
  let bestScore = -1;
  let bestLine = 1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].toLowerCase();
    let score = 0;
    for (const token of tokens) if (line.includes(token)) score += 2;
    if (symbols.some((symbol) => symbol.line === index + 1 && tokens.some((token) => symbol.name.toLowerCase().includes(token)))) {
      score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = index + 1;
    }
  }
  return { startLine: Math.max(1, bestLine - 8) };
}

function clipSnippet(content: string, startLine: number, lineCount: number): { text: string; startLine: number } {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const slice = lines.slice(start - 1, start - 1 + lineCount);
  const text = slice.map((line, offset) => `${start + offset}|${line}`).join("\n");
  return { text, startLine: start };
}

function clipToTokens(snippet: string, budget: number): string {
  const maxChars = Math.max(80, budget * 4);
  if (snippet.length <= maxChars) return snippet;
  return `${snippet.slice(0, maxChars)}\n…`;
}

function summarize(
  budget: number,
  used: number,
  pinBudget: number,
  pinUsed: number,
  chosen: RetrievedFile[],
  omitted: RetrievalResult["omitted"],
): string {
  const choices = chosen.map((file) => `${file.path} (${file.tokens} tokens, ${file.reason})`).join("; ");
  const leftOut = omitted.length ? ` Left out of the budget: ${omitted.map((file) => file.path).join(", ")}.` : "";
  return `Context budget ${budget} tokens, used ${used}. Pin budget ${pinBudget}, used ${pinUsed}. Chosen: ${choices || "none"}.${leftOut}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
