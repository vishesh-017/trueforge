import * as vscode from "vscode";
import { applySelectedHunks, splitHunks, type ReviewHunk } from "../pure/diff";
import type { EditPreview } from "../editor/bridge";

export type ReviewDecision = "apply" | "reject" | "cancel";

export interface HunkState {
  id: string;
  preview: string;
  accepted: boolean;
}

export interface ReviewSnapshot {
  id: string;
  path: string;
  explanation: string;
  hunks: HunkState[];
}

interface Proposal {
  id: string;
  preview: EditPreview;
  hunks: ReviewHunk[];
  accepted: Set<string>;
  proposedUri: vscode.Uri;
}

export class ReviewController implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly contents = new Map<string, string>();
  private readonly proposals = new Map<string, Proposal>();
  private waiter: { id: string; resolve: (decision: ReviewDecision) => void } | undefined;
  onSnapshot?: (snapshot: ReviewSnapshot | undefined) => void;

  constructor() {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const proposal = [...this.proposals.values()].find((item) => item.proposedUri.toString() === document.uri.toString());
    if (!proposal) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const hunk of proposal.hunks) {
      const line = Math.min(document.lineCount - 1, Math.max(0, hunk.newStart - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const accepted = proposal.accepted.has(hunk.id);
      lenses.push(new vscode.CodeLens(range, {
        title: accepted ? "Reject hunk" : "Accept hunk",
        command: accepted ? "forgehand.rejectHunk" : "forgehand.acceptHunk",
        arguments: [proposal.id, hunk.id],
      }));
    }
    return lenses;
  }

  review(preview: EditPreview): Promise<ReviewDecision> {
    this.cancel("cancel");
    const hunks = splitHunks(preview.original, preview.proposed);
    const proposal: Proposal = {
      id: preview.key.slice(0, 12),
      preview,
      hunks,
      accepted: new Set(hunks.map((hunk) => hunk.id)),
      proposedUri: vscode.Uri.parse(`forgehand://review/${preview.key.slice(0, 12)}`),
    };
    this.proposals.set(proposal.id, proposal);
    this.contents.set(proposal.proposedUri.toString(), preview.proposed);
    this.onDidChangeEmitter.fire(proposal.proposedUri);
    this.onDidChangeCodeLensesEmitter.fire();
    this.publish(proposal);
    const left = preview.original.length === 0
      ? this.emptyUri(proposal.id)
      : preview.uri;
    if (preview.original.length === 0) {
      this.contents.set(left.toString(), "");
      this.onDidChangeEmitter.fire(left);
    }
    void vscode.commands.executeCommand("vscode.diff", left, proposal.proposedUri, `Forgehand review: ${preview.path}`, { preview: false });
    return new Promise((resolve) => {
      this.waiter = { id: proposal.id, resolve };
    });
  }

  acceptHunk(proposalId: string, hunkId: string): void {
    this.setHunk(proposalId, hunkId, true);
  }

  rejectHunk(proposalId: string, hunkId: string): void {
    this.setHunk(proposalId, hunkId, false);
  }

  apply(): void {
    const proposal = this.active();
    if (!proposal) return;
    if (proposal.accepted.size === 0) {
      this.finish(proposal.id, "reject");
      return;
    }
    this.finish(proposal.id, "apply");
  }

  rejectFile(): void {
    const proposal = this.active();
    if (!proposal) return;
    this.finish(proposal.id, "reject");
  }

  cancel(decision: ReviewDecision = "cancel"): void {
    const waiting = this.waiter;
    if (!waiting) return;
    this.finish(waiting.id, decision);
  }

  merged(proposalId: string): string | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return undefined;
    return applySelectedHunks(proposal.preview.original, proposal.preview.proposed, proposal.hunks, proposal.accepted);
  }

  activeId(): string | undefined {
    return this.waiter?.id;
  }

  private setHunk(proposalId: string, hunkId: string, accepted: boolean): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return;
    if (accepted) proposal.accepted.add(hunkId);
    else proposal.accepted.delete(hunkId);
    this.onDidChangeCodeLensesEmitter.fire();
    this.publish(proposal);
  }

  private finish(id: string, decision: ReviewDecision): void {
    const waiting = this.waiter;
    this.waiter = undefined;
    this.onSnapshot?.(undefined);
    waiting?.resolve(decision);
    if (decision !== "apply") this.proposals.delete(id);
  }

  private active(): Proposal | undefined {
    const id = this.waiter?.id;
    return id ? this.proposals.get(id) : undefined;
  }

  private publish(proposal: Proposal): void {
    this.onSnapshot?.({
      id: proposal.id,
      path: proposal.preview.path,
      explanation: proposal.preview.explanation,
      hunks: proposal.hunks.map((hunk) => ({
        id: hunk.id,
        preview: hunk.preview,
        accepted: proposal.accepted.has(hunk.id),
      })),
    });
  }

  private emptyUri(id: string): vscode.Uri {
    return vscode.Uri.parse(`forgehand://empty/${id}`);
  }
}
