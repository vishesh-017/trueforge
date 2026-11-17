# Forgehand

TrueFoundry Forge-a-thon, Techfest 2026-27. Techfest Team ID: TM-D676D3DD6C3.

## 1. Team

Aaditya Shah (aadityashah0107@gmail.com) and Vishesh Shah (24bce311@gmail.com). Team ID TM-D676D3DD6C3. The public GitHub repository is the project handle; separate personal GitHub usernames were not supplied for this draft.

## 2. Starting point

From scratch. There is no upstream editor fork and no copied agent loop. VS Code renders the diff. TrueForge (github.com/truefoundry/trueforge, SDK @truefoundry/trueforge-sdk 0.185.0) runs the loop. The MCP TypeScript SDK exposes the editor tools. MIT licence in LICENSE.

## 3. Architecture on TrueForge

The extension is a client. On startup it listens on 127.0.0.1 and registers that URL with TrueForge as the remote MCP server forgehand-editor. The bearer header is generated in memory and never committed. TrueForge blocks loopback unless it is started with OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"] (scripts/start-trueforge.ps1). It then saves the agent in agent/forgehand.json and agent/INSTRUCTIONS.md.

Each chat is an inline TrueForge session, so a failed model can be replaced without editing the saved agent. Turns stream through sessions.createTurnStream. The panel appends model.message.delta as it arrives. Stop calls sessions.cancel and drops any review that has not been approved, so a cancelled run cannot write a partial file. An accepted file is one WorkspaceEdit, which Ctrl+Z can undo.

Editor tools, and who decides:

| Tool | Annotation | Approval |
| --- | --- | --- |
| retrieve_context, read_file, search_code | read-only, preloaded | none |
| list_files, get_symbol, git_status | read-only, deferred | none |
| propose_edit | write | TrueForge pauses; the editor accepts or rejects hunks |
| run_command | destructive | TrueForge pauses; the panel allows or denies |

The MCP handler writes only a payload the review UI staged before the extension sent user.tool_approval. A call with no staged decision returns an error and does not touch disk. The agent chooses the tool calls. preload is false. Five hot tools are in preload_tools; the rest stay behind list_tools and get_tool_info. dynamic_sub_agents is on, and the instructions tell the root agent to delegate reading when a change spans implementation and tests or docs. Compaction is on at 80,000 input tokens. Sandbox, skills, and Code Mode are off because they need a sandbox provider, which Windows does not start and the fixed tasks do not require.

## 4. How context is selected

retrieve_context is a hybrid lexical and symbol search with a hard budget (forgehand.contextBudgetTokens, default 6,000). Tokens are estimated as characters divided by four. Query terms match paths, def / class / function names, and capped line hits. Mentions of tests, docs, or a command boost paths under tests/, docs/, or a CLI module. Snippets stop when the budget is spent, and the tool names the files that did not fit. @file and @symbol mentions are pinned on a separate budget of at most 2,000 tokens, so a mention cannot crowd out the search. Numbered snippets are not valid replacement text; read_file returns exact text. The tool result includes a one-paragraph summary, and the instructions require the agent to say which files were chosen and why before the first edit. That is what the panel context card and the TrueForge session show on Task B.

## 5. Model setup

Models run only inside TrueForge local mode at http://localhost:8790 on the team machine. The extension never calls a model provider and never reads an API key. On this server the catalog is still empty: GET /api/v1/settings/model-providers and GET /api/v1/models both return no providers, so no model name and no dollar cost can be declared yet. Register two providers under Settings, Models, or with scripts/configure-models.mjs from config/models.example.json. Put the primary fully qualified name in forgehand.model and the second in forgehand.fallbackModel, then run Forgehand: Retry Connection.

A failure switches by itself. Forgehand retries the primary model once after 1.5 seconds. If that fails before any hunk is applied, sessions.update replaces the inline spec with the fallback model and resends the same request as a new root turn. Nothing is retried after a file has been applied. Approximate cost of record: none, because this TrueForge instance has not billed a turn. After the demo, replace this sentence with the two model names, the host, and the session cost TrueForge reports.

## 6. Scorecard

Timestamps follow the demo script in the README. If the recorded cut differs, change the timestamp and leave the claim.

| Criterion | Anchor claimed | Video | Claim |
| --- | --- | --- | --- |
| A1 Inline edit (10) | 10, per-hunk accept and reject | 0:20 | Task A opens a VS Code diff. Each hunk can be accepted or rejected, then applied. |
| A2 Agent mode (10) | 10, three or more files, none named | 1:20 | Task B names no files. The diff touches the command, a test, and the docs. |
| A3 Streaming and cancellation (10) | 10, immediate cancel, workspace consistent | 1:05 and 3:20 | Tokens stream. Stop aborts the turn. Unaccepted work is not written. |
| B1 Context assembly (15) | 15, budgeted retrieval, visible reasons | 1:30 | retrieve_context shows the budget, the chosen files, and why. @ mentions use a separate budget. |
| B2 Diff safety (10) | 10, per-hunk review and undo | 0:35 | Apply writes only accepted hunks. Ctrl+Z restores the previous text. |
| B3 Resilience (10) | 10, automatic fallback, workspace unchanged | 3:10 | Task C retries, then switches to the second TrueForge model with no click. git status stays clean if you do not apply. |
| B4 TrueForge integration (10) | 10, MCP tools, approval, context features | 2:10 | The session shows MCP calls, approval pauses, deferred discovery, subagents, and compaction past 80,000 tokens. |
| C1 Video (10) | 10, three tasks verified | 0:00-4:00 | A, B, and C in order, each verified on screen, with the TrueForge session during B. |
| C2 Write-up (15) | 15 | this PDF | Architecture, context budget, models, this table, and the limitations below. |

## 7. Tools used

An AI pair-programming assistant was used while authoring parts of this extension. That costs no points. The running agent still calls only TrueForge.

## 8. Known limitations and what we would do with another month

Retrieval is lexical and structural, not embedding search. It is deterministic and needs no extra service, and it misses a file that shares no terms with the request. Another month would add a local index under the same budget, not a larger prompt.

TrueForge does not yet fail over between models on its own. The docs list that as planned. Forgehand switches by updating the inline session, and only before any hunk is applied. A failure after an apply stops, on purpose.

Skills and Code Mode are unused. On Windows, TrueForge does not start its built-in local sandbox. Deferred loading, subagents, and compaction are the context features this submission runs. Compaction appears only after the thread crosses 80,000 estimated input tokens, so Task A will not show it. A long Task B can.

propose_edit refuses to write without a staged decision. Subagents share the write tools; the instructions tell them not to edit, and the approval gate still stops an edit a subagent tries to make.
