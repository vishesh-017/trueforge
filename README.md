# Forgehand

Forgehand is a Visual Studio Code extension that edits a repository through [TrueForge](https://github.com/truefoundry/trueforge). TrueForge owns the agent loop: model calls, streaming, sessions, tool approvals, deferred tool loading, subagents, and compaction. The extension is the client. It exposes the editor as MCP tools and will not write a file until you accept the hunks.

Starting point: from scratch. There is no upstream editor fork. The diff you review is VS Code's own diff editor.

## What you can do

- Select code and press `Ctrl+Shift+I` (`Cmd+Shift+I` on macOS). Type an instruction. A diff opens in the editor. Accept or reject each hunk, then apply. `Ctrl+Z` undoes an applied edit, and so does **Forgehand: Undo Last Applied Edit**.
- Ask in the Forgehand panel without naming files. The agent calls `retrieve_context`, which packs snippets under a token budget and says why each file was chosen. It can edit three or more files. Each file pauses for review.
- Tokens stream into the panel. **Stop** cancels the TrueForge turn immediately. Unaccepted edits are discarded, and a file is never left half-written.
- If the primary model fails before anything is written, Forgehand retries once after 1.5 seconds and then switches the same session to the fallback model configured in TrueForge. The extension never calls a model provider.

Pin context with `@src/flask/cli.py` or `@symbol:get_debug_flag`.

## Setup

Requirements: Node.js 22.14 or newer, VS Code 1.90 or newer, and a TrueForge server on your machine.

```bash
npm install
npm test
npm run compile
```

Start TrueForge with loopback allowed. TrueForge blocks `127.0.0.1` and `localhost` unless you name them. The editor tools are an MCP server on your machine, so this is required:

```powershell
powershell -File scripts/start-trueforge.ps1
```

On macOS or Linux, `bash scripts/start-trueforge.sh`. The script sets `OUTBOUND_URL_ALLOWED_HOSTS` to `["127.0.0.1","localhost"]` and runs `npx @truefoundry/trueforge@latest`.

TrueForge opens at <http://localhost:8790>. On Windows, keep that hostname: this build listens on localhost and refuses raw `127.0.0.1` for its own port. In **Settings → Models**, configure two providers. Agent definitions do not contain keys. `config/models.example.json` shows the shape. To register those providers from environment variables:

```bash
copy config\models.example.json config\models.local.json
set PRIMARY_MODEL_API_KEY=your-key
set FALLBACK_MODEL_API_KEY=your-key
node scripts/configure-models.mjs
```

`config/models.local.json` is gitignored. Do not commit a key.

In VS Code settings:

- `forgehand.model`: the primary fully qualified name TrueForge lists, such as `openai/gpt-4-1-mini`
- `forgehand.fallbackModel`: the second model
- `forgehand.baseUrl`: `http://localhost:8790` unless you changed the port
- `forgehand.contextBudgetTokens`: `6000` by default

Press **F5** (the launch config compiles first) or install the extension from this folder. On startup Forgehand serves an MCP endpoint on `127.0.0.1`, registers it in TrueForge as `forgehand-editor`, and saves the agent in `agent/forgehand.json`. The instructions live in `agent/INSTRUCTIONS.md`. The status bar shows the primary model when the connection works.

Open the pinned task repository before recording:

```bash
git clone https://github.com/pallets/flask.git
cd flask
git checkout 22d92470
code .
```

That commit is Flask 3.1.3.

## Demo script

Record at most four minutes, in this order. You can cut model waiting. Do not cut from the instruction to the diff.

### Task A, inline edit

Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+Shift+I`, and enter:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Reject one hunk, accept it again, then apply. Show `Ctrl+Z` bringing the old function back, then redo or apply again so the change sticks. In a terminal:

```bash
set FLASK_DEBUG=off
python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

The print is `False`.

### Task B, agent mode

In the Forgehand panel, with no `@` mentions, enter:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

The context card lists the files and the reasons. The diff touches at least three files. Accept the hunks. Click **TrueForge session** and, in the Sessions view, show this run's turns, `retrieve_context`, deferred `list_tools` / `get_tool_info`, any subagents, and the approval pauses. Then:

```bash
pytest tests/test_cli.py -q
```

Run `flask config` against any Flask app and show the masked JSON.

### Task C, resilience

In TrueForge, point the primary model at an unreachable URL or an invalid key and leave the fallback model working. Repeat Task A. The panel retries, then says it is falling back. The editor stays usable. Do not apply the diff. `git status` shows no changes. If you want the failure path instead, break both models: the panel shows the error and still writes nothing.

## Checks

`npm test` covers hunk selection and the retrieval budget. `npm run check` typechecks. Those tests do not call a model.

## Licence

MIT. See `LICENSE`. TrueForge, the VS Code API, the MCP SDK, and the `diff` package remain under their own licences.
