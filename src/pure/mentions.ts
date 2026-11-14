export interface Mention {
  kind: "file" | "symbol";
  value: string;
}

const MENTION = /@(file|symbol):([^\s,;]+)|\B@((?:[\w.-]+\/)+[\w.-]+)/g;

export function parseMentions(text: string): Mention[] {
  const found: Mention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const kind = match[1] === "symbol" ? "symbol" : "file";
    const value = (match[2] ?? match[3] ?? "").replace(/^["']|["']$/g, "");
    if (!value) continue;
    const key = `${kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ kind, value });
  }
  return found;
}
