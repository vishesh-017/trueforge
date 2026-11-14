import assert from "node:assert/strict";
import test from "node:test";
import { parseMentions } from "../src/pure/mentions";
import { retrieveFromFiles } from "../src/pure/retrieve";

test("parseMentions reads @file, @symbol, and @path", () => {
  const mentions = parseMentions("Look at @src/flask/cli.py and @symbol:get_debug_flag plus @file:docs/cli.rst");
  assert.deepEqual(mentions, [
    { kind: "file", value: "src/flask/cli.py" },
    { kind: "symbol", value: "get_debug_flag" },
    { kind: "file", value: "docs/cli.rst" },
  ]);
});

test("retrieval stays inside the budget and explains its choices", () => {
  const files = new Map<string, string>([
    ["src/flask/cli.py", "import click\n\ndef routes():\n    \"\"\"Show routes.\"\"\"\n    pass\n\ndef run():\n    pass\n"],
    ["tests/test_cli.py", "def test_routes(cli_runner):\n    result = cli_runner.invoke(args=['routes'])\n    assert result.exit_code == 0\n"],
    ["docs/cli.rst", "flask routes\n\nShow the routes for an application.\n"],
    ["src/flask/helpers.py", "def get_debug_flag():\n    \"\"\"Treat 0, false, and no as false.\"\"\"\n    return False\n"],
    ["src/flask/noise.py", `${"unrelated padding\n".repeat(400)}`],
  ]);
  const query = "Add a flask config CLI command that prints configuration as JSON, mask SECRET keys, cover it with a test, and document it with the other built-in commands.";
  const result = retrieveFromFiles(files, query, 500);
  const chosenPaths = result.chosen.map((file) => file.path);
  assert.ok(chosenPaths.includes("src/flask/cli.py"));
  assert.ok(chosenPaths.includes("tests/test_cli.py"));
  assert.ok(result.usedTokens <= result.budgetTokens);
  assert.match(result.summary, /Context budget 500 tokens/);
  assert.ok(result.chosen.every((file) => file.reason.length > 0));
});

test("pinned mentions do not consume the automatic budget", () => {
  const files = new Map<string, string>([
    ["src/flask/helpers.py", "def get_debug_flag():\n    return False\n"],
    ["src/flask/cli.py", "def routes():\n    \"\"\"flask command\"\"\"\n    pass\n"],
  ]);
  const result = retrieveFromFiles(files, "flask command routes", 200, ["src/flask/helpers.py"]);
  assert.ok(result.pinned.some((file) => file.path === "src/flask/helpers.py"));
  assert.equal(result.pinUsedTokens > 0, true);
  assert.ok(result.chosen.every((file) => file.path !== "src/flask/helpers.py"));
});
