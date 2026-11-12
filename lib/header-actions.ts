// What the thread header shows for a PR snapshot, as plain data: the
// legacy split button (bb ≤ 0.46) and the header thread actions (bb 0.49+)
// both draw from it.
import type { PrInfo, PrSnapshot } from "../server";
import { ACTION_LABELS, KIND_LABELS, prAction, type PrAction, type PrKind } from "./pr-state";

// Icon names must exist in bb's built-in set (a mix of Lucide and Hugeicons
// names, smaller than either); unknown names render as
// a generic glyph.

export const KIND_ICON: Record<PrKind, string> = {
  unpushed: "FileDiff",
  draft: "GitPullRequestDraft",
  checks_pending: "Spinner",
  checks_failed: "CircleX",
  conflicts: "AlertTriangle",
  changes_requested: "MessageSquare",
  review: "Eye",
  blocked: "Lock",
  behind: "ArrowDown",
  queued: "ListEnd",
  checking: "Spinner",
  ready: "GitMerge",
  open: "GitPullRequest",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

export const ACTION_ICON: Record<Exclude<PrAction, null>, string> = {
  commit_push: "ArrowUp",
  mark_ready: "GitPullRequest",
  fix_checks: "ToolCase",
  fix_conflicts: "ToolCase",
  address_review: "MessageSquare",
  update_branch: "ArrowDown",
  merge: "GitMerge",
  archive: "Archive",
};

/** Label of the right half when the state has no action. */
export function statusLabel(pr: PrInfo): string {
  if (pr.kind === "checks_pending" && pr.checks.totalCount > 0) {
    const done = pr.checks.totalCount - pr.checks.pendingCount;
    return `Checks running ${done}/${pr.checks.totalCount}`;
  }
  if (pr.kind === "review") return "Review required";
  if (pr.kind === "blocked") return "Blocked";
  if (pr.kind === "checking") return "Checking…";
  return KIND_LABELS[pr.kind];
}

/** What a header button does when clicked. */
export type HeaderCommand =
  | { type: "create" }
  | { type: "act"; action: Exclude<PrAction, null> }
  | { type: "open"; url: string }
  | { type: "copy_link"; url: string }
  | { type: "refresh" };

/** The buttons of the header thread actions, by registration id. */
export type HeaderButtonId = "pr-next" | "pr-open" | "pr-copy-link" | "pr-refresh";

export interface HeaderButton {
  label: string;
  icon: string;
  detail?: string;
  disabled?: boolean;
  command: HeaderCommand;
}

/**
 * The header thread actions for one thread: the main button carries the PR
 * number and the next step (or the state when there is none), the others
 * open, copy and refresh. Empty while nothing is known, without a
 * workspace, or on a branch where a PR makes no sense.
 */
export function headerButtons(
  snapshot: PrSnapshot | null | undefined,
  pending: boolean,
): Partial<Record<HeaderButtonId, HeaderButton>> {
  if (snapshot === null || snapshot === undefined || snapshot.outcome === "unavailable") return {};
  if (snapshot.pr === null) {
    if (!snapshot.canCreate) return {};
    return {
      "pr-next": {
        label: pending ? "Create PR…" : "Create PR",
        icon: "GitPullRequestArrow",
        detail: "Ask the agent to open a pull request for this branch",
        disabled: pending,
        command: { type: "create" },
      },
    };
  }
  const pr = snapshot.pr;
  const action = prAction(pr.kind);
  const next = action === null ? statusLabel(pr) : ACTION_LABELS[action];
  return {
    "pr-next": {
      label: `#${pr.number} · ${pending ? "…" : next}`,
      icon: action === null ? KIND_ICON[pr.kind] : ACTION_ICON[action],
      detail: `${KIND_LABELS[pr.kind]} — ${pr.title}`,
      disabled: pending,
      // Without a next step, the button opens the PR rather than do nothing.
      command: action === null ? { type: "open", url: pr.url } : { type: "act", action },
    },
    "pr-open": {
      label: `Open PR #${pr.number}`,
      icon: "GitPullRequest",
      command: { type: "open", url: pr.url },
    },
    "pr-copy-link": {
      label: "Copy PR link",
      icon: "Copy",
      command: { type: "copy_link", url: pr.url },
    },
    "pr-refresh": {
      label: "Refresh PR status",
      icon: "ArrowReloadHorizontal",
      command: { type: "refresh" },
    },
  };
}
