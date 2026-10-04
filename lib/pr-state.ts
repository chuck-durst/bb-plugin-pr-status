// The PR states this plugin distinguishes, shared by the server and the app.
//
// bb already rolls checks, review and mergeability into one `attention`
// value; the header and the sidebar both start from it so they never
// disagree. Pure data only: the app imports this file, so it must not pull
// in anything server-side.

export type PrAttention =
  | "blocked"
  | "changes_requested"
  | "checks_failed"
  | "checks_pending"
  | "closed"
  | "conflicts"
  | "draft"
  | "merged"
  | "none"
  | "queued"
  | "ready_to_merge"
  | "review_requested";

export type PrKind =
  | "draft"
  | "checks_pending"
  | "checks_failed"
  | "conflicts"
  | "changes_requested"
  | "review"
  | "queued"
  | "ready"
  | "open"
  | "merged"
  | "closed";

/** What the right half of the header button does for a kind. */
export type PrAction =
  | "mark_ready"
  | "fix_checks"
  | "fix_conflicts"
  | "address_review"
  | "merge"
  | "archive"
  | null;

export function prKind(attention: PrAttention): PrKind {
  switch (attention) {
    case "ready_to_merge":
      return "ready";
    case "review_requested":
    case "blocked":
      return "review";
    case "none":
      return "open";
    default:
      return attention;
  }
}

export function prAction(kind: PrKind): PrAction {
  switch (kind) {
    case "draft":
      return "mark_ready";
    case "checks_failed":
      return "fix_checks";
    case "conflicts":
      return "fix_conflicts";
    case "changes_requested":
      return "address_review";
    case "ready":
      return "merge";
    case "merged":
    case "closed":
      return "archive";
    default:
      return null;
  }
}

export const ACTION_LABELS: Record<Exclude<PrAction, null>, string> = {
  mark_ready: "Mark ready",
  fix_checks: "Fix checks",
  fix_conflicts: "Fix conflicts",
  address_review: "Address review",
  merge: "Merge",
  archive: "Archive",
};

export const KIND_LABELS: Record<PrKind, string> = {
  draft: "Draft",
  checks_pending: "Checks running",
  checks_failed: "Checks failing",
  conflicts: "Merge conflicts",
  changes_requested: "Changes requested",
  review: "Waiting for review",
  queued: "In merge queue",
  ready: "Ready to merge",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

/**
 * Sidebar glyph for a kind. Row statuses only take a bb icon name and one of
 * four tones, so colour is limited to what the tone gives.
 */
export const KIND_ROW_STATUS: Record<
  PrKind,
  { icon: string; tone: "default" | "error" | "running" | "success" }
> = {
  draft: { icon: "GitPullRequestDraft", tone: "default" },
  checks_pending: { icon: "GitPullRequest", tone: "running" },
  checks_failed: { icon: "GitPullRequest", tone: "error" },
  conflicts: { icon: "AlertTriangle", tone: "error" },
  changes_requested: { icon: "GitPullRequestArrow", tone: "error" },
  review: { icon: "GitPullRequest", tone: "default" },
  queued: { icon: "GitPullRequest", tone: "running" },
  ready: { icon: "GitPullRequest", tone: "success" },
  open: { icon: "GitPullRequest", tone: "default" },
  merged: { icon: "GitMerge", tone: "default" },
  closed: { icon: "GitPullRequestClosed", tone: "default" },
};
