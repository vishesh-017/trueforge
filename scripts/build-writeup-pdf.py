"""Render WRITEUP content to a 1-3 page submission PDF. ASCII only."""

from fpdf import FPDF

OUT = r"D:\trueforge hackathon\Forgehand-writeup.pdf"


class Writeup(FPDF):
    def footer(self):
        self.set_y(-10)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(80, 80, 80)
        self.cell(0, 5, f"Forgehand  |  Team ID TM-D676D3DD6C3  |  {self.page_no()}/{{nb}}", align="C")


def heading(pdf: Writeup, text: str) -> None:
    pdf.ln(1.4)
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 5.2, text)
    pdf.ln(0.4)


def body(pdf: Writeup, text: str) -> None:
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 4.15, text)
    pdf.ln(0.6)


def build() -> int:
    pdf = Writeup(format="A4", unit="mm")
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.set_margins(12, 11, 12)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 7, "Forgehand", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(40, 40, 40)
    pdf.multi_cell(0, 4.2, "TrueFoundry Forge-a-thon, Techfest 2026-27. A VS Code coding agent whose loop runs on TrueForge. Techfest Team ID: TM-D676D3DD6C3.")
    pdf.ln(0.8)

    heading(pdf, "1. Team")
    body(pdf, "Aaditya Shah (aadityashah0107@gmail.com) and Vishesh Shah (24bce311@gmail.com). Team ID TM-D676D3DD6C3. The public GitHub repository is the project handle. Separate personal GitHub usernames were not supplied for this draft.")

    heading(pdf, "2. Starting point")
    body(pdf, "From scratch. There is no upstream editor fork and no copied agent loop. VS Code renders the diff. TrueForge (github.com/truefoundry/trueforge, SDK @truefoundry/trueforge-sdk 0.185.0) runs the loop. The MCP TypeScript SDK exposes the editor tools. The licence is MIT.")

    heading(pdf, "3. Architecture on TrueForge")
    body(pdf, "The extension is a client. On startup it listens on 127.0.0.1 and registers that URL with TrueForge as the remote MCP server forgehand-editor. The bearer token is generated in memory and never committed. TrueForge blocks loopback unless it is started with OUTBOUND_URL_ALLOWED_HOSTS set to 127.0.0.1 and localhost (scripts/start-trueforge.ps1). It then saves the agent from agent/forgehand.json and agent/INSTRUCTIONS.md.")
    body(pdf, "Each chat is an inline TrueForge session, so a failed model can be replaced without editing the saved agent. Turns stream through sessions.createTurnStream. The panel appends model.message.delta as it arrives. Stop calls sessions.cancel and drops any review that has not been approved, so a cancelled run cannot write a partial file. An accepted file is one WorkspaceEdit, which Ctrl+Z can undo.")
    body(pdf, "Editor tools: retrieve_context, read_file, and search_code are read-only and preloaded. list_files, get_symbol, and git_status are read-only and deferred behind list_tools and get_tool_info. propose_edit is a write and pauses for TrueForge approval, then per-hunk review. run_command is destructive and pauses for a panel allow or deny. The MCP handler writes only a payload staged before user.tool_approval. preload is false. dynamic_sub_agents is on so a change that spans code, tests, and docs can delegate reading. Compaction triggers at 80,000 input tokens. Sandbox, skills, and Code Mode are off: Windows does not start the local sandbox, and the fixed tasks do not need it.")

    heading(pdf, "4. How context is selected")
    body(pdf, "retrieve_context is a hybrid lexical and symbol search with a hard budget (forgehand.contextBudgetTokens, default 6,000). Tokens are estimated as characters divided by four. Terms match paths, def / class / function names, and capped line hits. Mentions of tests, docs, or a command boost paths under tests/, docs/, or a CLI module. Snippets stop when the budget is spent, and the tool names files that did not fit. @file and @symbol mentions are pinned on a separate budget of at most 2,000 tokens. Numbered snippets are not valid replacement text; read_file returns exact text. The result includes a short summary, and the instructions require the agent to say which files were chosen and why before the first edit. Task B shows that on the context card and in the TrueForge session.")

    heading(pdf, "5. Model setup")
    body(pdf, "Models run only inside TrueForge local mode at http://localhost:8790 on the team machine. The extension never calls a model provider and never reads an API key. On this server the catalog is still empty: both the model-provider list and the model list return no entries, so no model name and no dollar cost can be declared yet. Register two providers under Settings, Models, or with scripts/configure-models.mjs using config/models.example.json. Put the primary fully qualified name in forgehand.model and the second in forgehand.fallbackModel, then run Forgehand: Retry Connection.")
    body(pdf, "A failure switches by itself. Forgehand retries the primary model once after 1.5 seconds. If that fails before any hunk is applied, sessions.update replaces the inline spec with the fallback model and resends the same request. Nothing is retried after a file has been applied. Approximate cost on record: none, because this instance has not billed a turn. After the demo, replace that figure with the two model names, where they ran, and the session cost TrueForge reports.")

    heading(pdf, "6. Scorecard")
    body(pdf, "Timestamps follow the demo script in the README. If the recorded cut differs, change the timestamp and leave the claim.")

    rows = [
        ("Criterion", "Video", "Claim"),
        ("A1 Inline edit (10)", "0:20", "Task A opens a VS Code diff. Each hunk can be accepted or rejected, then applied."),
        ("A2 Agent mode (10)", "1:20", "Task B names no files. The diff touches the command, a test, and the docs."),
        ("A3 Streaming and cancellation (10)", "1:05, 3:20", "Tokens stream. Stop aborts the turn. Unaccepted work is not written."),
        ("B1 Context assembly (15)", "1:30", "retrieve_context shows the budget, the chosen files, and why."),
        ("B2 Diff safety (10)", "0:35", "Apply writes only accepted hunks. Ctrl+Z restores the previous text."),
        ("B3 Resilience (10)", "3:10", "Task C retries, then switches to the second model. git status stays clean if you do not apply."),
        ("B4 TrueForge integration (10)", "2:10", "The session shows MCP calls, approval pauses, deferred tools, subagents, and compaction."),
        ("C1 Video (10)", "0:00-4:00", "Tasks A, B, and C in order, each verified on screen, with the TrueForge session during B."),
        ("C2 Write-up (15)", "this PDF", "Architecture, context budget, model setup, this table, and the limitations below."),
    ]
    with pdf.table(
        width=186,
        col_widths=(52, 24, 110),
        text_align=("LEFT", "LEFT", "LEFT"),
        line_height=3.5,
        first_row_as_headings=True,
    ) as table:
        pdf.set_font("Helvetica", "", 7.4)
        for row in rows:
            table.row(row)

    pdf.ln(1.2)
    heading(pdf, "7. Tools used")
    body(pdf, "An AI pair-programming assistant was used while authoring parts of this extension. That costs no points. The running agent calls only TrueForge.")

    heading(pdf, "8. Known limitations and what you would do with another month")
    body(pdf, "Retrieval is lexical and structural, not embedding search. It is deterministic and needs no extra service, and it misses a file that shares no terms with the request. Another month would add a local index under the same budget, not a larger prompt. TrueForge does not fail over by itself; the docs list that as planned. Forgehand switches by updating the inline session, and only before a hunk is applied. A failure after an apply stops on purpose. Skills and Code Mode are unused because the Windows build does not start the local sandbox. Compaction appears only after 80,000 estimated input tokens, so a short task will not show it. A long Task B can. Subagents share the write tools. The instructions tell them not to edit, and the approval gate still stops an edit they try to make.")

    pdf.output(OUT)
    return pdf.pages_count


if __name__ == "__main__":
    print(build())
