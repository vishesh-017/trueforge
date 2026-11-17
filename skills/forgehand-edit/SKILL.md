---
name: forgehand-edit
description: Use when editing a repository through Forgehand MCP tools — budgeted retrieval, exact replacements, and per-hunk review.
---

# Forgehand edit procedure

You are editing through the `forgehand-editor` MCP server. Disk writes only happen after the user accepts hunks.

## Steps

1. Call `list_tools` / `get_tool_info` for deferred editor tools when needed.
2. Call `retrieve_context` with the user request. State which files you chose and why before the first edit.
3. Prefer `read_file` for exact text. Never use numbered snippets as `old_string`.
4. Use one `propose_edit` per file with a unique exact `old_string`.
5. For aggregating or filtering large tool output, use Code Mode in the sandbox: write a short Python script that calls the MCP tools, prints only the summary, and avoid dumping raw output into the prompt.
6. After edits are applied, verify with `run_command` when the user asked for a test or CLI check.

## Safety

- Do not claim a file changed until `propose_edit` reports the user applied it.
- Do not repeat a failing replacement unchanged.
- Stay inside the workspace.
