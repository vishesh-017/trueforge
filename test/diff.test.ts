import assert from "node:assert/strict";
import test from "node:test";
import { applyReplacements, applySelectedHunks, splitHunks } from "../src/pure/diff";

const gap = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
const original = ["alpha", "beta", ...gap, "delta", "epsilon"].join("\n") + "\n";
const proposed = ["alpha", "BETA", ...gap, "DELTA", "epsilon"].join("\n") + "\n";

test("splitHunks finds both edits", () => {
  const hunks = splitHunks(original, proposed);
  assert.ok(hunks.length >= 2);
});

test("accepting every hunk returns the proposed text", () => {
  const hunks = splitHunks(original, proposed);
  const accepted = new Set(hunks.map((hunk) => hunk.id));
  assert.equal(applySelectedHunks(original, proposed, hunks, accepted), proposed);
});

test("rejecting every hunk keeps the original text", () => {
  const hunks = splitHunks(original, proposed);
  assert.equal(applySelectedHunks(original, proposed, hunks, new Set()), original);
});

test("accepting one hunk leaves the other edit unapplied", () => {
  const hunks = splitHunks(original, proposed);
  assert.equal(hunks.length, 2);
  const onlySecond = applySelectedHunks(original, proposed, hunks, new Set([hunks[1].id]));
  assert.match(onlySecond, /^alpha\nbeta\nc1\nc2\nc3\nc4\nc5\nc6\nc7\nc8\nDELTA\nepsilon\n$/);
  const onlyFirst = applySelectedHunks(original, proposed, hunks, new Set([hunks[0].id]));
  assert.match(onlyFirst, /^alpha\nBETA\nc1\nc2\nc3\nc4\nc5\nc6\nc7\nc8\ndelta\nepsilon\n$/);
});

test("replacements ignore CRLF and read_file line numbers", () => {
  const file = "def get_debug_flag() -> bool:\r\n    return False\r\n";
  const numbered = applyReplacements(file, [{
    old_string: "12|def get_debug_flag() -> bool:\n13|    return False",
    new_string: "def get_debug_flag() -> bool:\n    return True",
  }]);
  assert.equal(numbered.ok && numbered.content, "def get_debug_flag() -> bool:\r\n    return True\r\n");
});

test("replacements must match exactly once", () => {
  const ok = applyReplacements("let value = 1;\n", [{ old_string: "let value = 1;", new_string: "let value = 2;" }]);
  assert.equal(ok.ok && ok.content, "let value = 2;\n");
  const missing = applyReplacements("let value = 1;\n", [{ old_string: "missing", new_string: "x" }]);
  assert.equal(missing.ok, false);
  const ambiguous = applyReplacements("a\na\n", [{ old_string: "a", new_string: "b" }]);
  assert.equal(ambiguous.ok, false);
});
