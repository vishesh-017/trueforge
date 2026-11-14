import { applyPatch, formatPatch, structuredPatch } from "diff";

export interface ReviewHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  preview: string;
}

export function splitHunks(original: string, proposed: string): ReviewHunk[] {
  if (original === proposed) return [];
  const patch = structuredPatch("current", "proposed", original, proposed, "", "", { context: 3 });
  return patch.hunks.map((hunk, index) => ({
    id: String(index),
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
    preview: hunk.lines.slice(0, 12).join("\n"),
  }));
}

/**
 * Apply a subset of hunks to the original text.
 * Accepting every hunk returns the proposed text unchanged, so a full accept
 * cannot drift from what the model proposed.
 */
export function applySelectedHunks(original: string, proposed: string, hunks: ReviewHunk[], acceptedIds: ReadonlySet<string>): string {
  if (hunks.length === 0 || hunks.every((hunk) => acceptedIds.has(hunk.id))) return proposed;
  if (hunks.every((hunk) => !acceptedIds.has(hunk.id))) return original;

  const patch = structuredPatch("current", "proposed", original, proposed, "", "", { context: 3 });
  const selected = new Set(acceptedIds);
  patch.hunks = patch.hunks.filter((_, index) => selected.has(String(index)));
  if (patch.hunks.length === 0) return original;
  const applied = applyPatch(original, formatPatch(patch));
  if (applied === false) {
    throw new Error("Could not apply the accepted hunks to the current file.");
  }
  return applied;
}

export interface Replacement {
  old_string: string;
  new_string: string;
}

export function applyReplacements(original: string, replacements: Replacement[]): { ok: true; content: string } | { ok: false; error: string } {
  let content = original;
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    if (!replacement.old_string) {
      return { ok: false, error: `Replacement ${index + 1} has an empty old_string.` };
    }
    const count = countOccurrences(content, replacement.old_string);
    if (count > 1) {
      return {
        ok: false,
        error: `Replacement ${index + 1} matched ${count} places. Provide more surrounding lines so old_string is unique.`,
      };
    }
    if (count === 1) {
      content = content.replace(replacement.old_string, replacement.new_string);
      continue;
    }
    const flexible = replaceFlexible(content, replacement.old_string, replacement.new_string);
    if (flexible === "ambiguous") {
      return {
        ok: false,
        error: `Replacement ${index + 1} matched more than once after ignoring line endings. Provide more surrounding lines so old_string is unique.`,
      };
    }
    if (flexible == null) {
      return { ok: false, error: mismatchMessage(index, content, replacement.old_string) };
    }
    content = flexible;
  }
  return { ok: true, content };
}

/**
 * Match a replacement when the model copied the right lines but changed
 * CRLF, a trailing newline, a fenced block, or the `12|` prefixes read_file
 * adds. The match still has to be unique.
 */
function replaceFlexible(original: string, oldString: string, newString: string): string | "ambiguous" | undefined {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const fileLines = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const needle = cleanBlock(oldString);
  if (needle.length === 0) return undefined;
  const hits: number[] = [];
  const last = fileLines.length - needle.length;
  for (let start = 0; start <= last; start++) {
    let same = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (fileLines[start + offset].replace(/\s+$/g, "") !== needle[offset]) {
        same = false;
        break;
      }
    }
    if (same) hits.push(start);
  }
  if (hits.length === 0) return undefined;
  if (hits.length > 1) return "ambiguous";
  const at = hits[0];
  const merged = [...fileLines.slice(0, at), ...cleanBlock(newString), ...fileLines.slice(at + needle.length)];
  return merged.join(newline);
}

function cleanBlock(value: string): string[] {
  let text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/\n?```$/, "");
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (!text) return [];
  return text.split("\n").map((line) => line.replace(/^\d+\|/, "").replace(/\s+$/g, ""));
}

function mismatchMessage(index: number, content: string, oldString: string): string {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hint = cleanBlock(oldString).find((line) => line.includes("def ") || line.includes("class "))
    ?? cleanBlock(oldString).find((line) => line.trim().length > 8)
    ?? "";
  const probe = hint.trim().slice(0, 80);
  let at = probe ? lines.findIndex((line) => line.includes(probe)) : 0;
  if (at < 0) at = 0;
  const excerpt = lines.slice(at, at + 18).join("\n");
  return `Replacement ${index + 1} did not match the current file. old_string was not found. Copy old_string from the text below, keep the indentation, and do not include line numbers:\n${excerpt}`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    count += 1;
    from = found + needle.length;
  }
  return count;
}
