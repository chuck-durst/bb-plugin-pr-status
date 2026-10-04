// The PR states this plugin distinguishes, shared by the server and the app.
//
// bb rolls checks, review and mergeability into one `attention` value, but
// only calls a PR `ready_to_merge` when its checks pass: a mergeable PR with
// no checks comes back as `none`, and `blocked` lumps together branch
// protection, a branch behind its base and GitHub's HAS_HOOKS (which is
// mergeable). So both surfaces derive the state from the raw facts with
// `derivePrKind`. Pure data only: the app imports this file, so it must not
// pull in anything server-side.

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
  | "blocked"
  | "behind"
  | "queued"
  | "checking"
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
  | "update_branch"
  | "merge"
  | "archive"
  | null;

/** The facts bb reports for a PR, as both the server and the sidebar see them. */
export interface PrFacts {
  state: "open" | "draft" | "merged" | "closed";
  checks: "failing" | "no_checks" | "passing" | "pending" | "unknown";
  review: "approved" | "changes_requested" | "none" | "review_requested" | "review_required";
  mergeability: "blocked" | "conflicts" | "draft" | "mergeable" | "unknown";
  /** GitHub's raw mergeStateStatus; the sidebar does not get it. */
  mergeStateStatus?: string | null;
  inMergeQueue: boolean | null;
}

/**
 * The state to show, most pressing first. Same order as bb's own attention
 * for everything that needs work; it differs on what bb leaves at `none` or
 * `blocked`.
 */
export function derivePrKind(facts: PrFacts): PrKind {
  if (facts.state === "merged") return "merged";
  if (facts.state === "closed") return "closed";
  if (facts.mergeability === "conflicts") return "conflicts";
  if (facts.checks === "failing") return "checks_failed";
  if (facts.review === "changes_requested") return "changes_requested";
  if (facts.state === "draft") return "draft";
  if (facts.inMergeQueue === true) return "queued";
  if (facts.checks === "pending") return "checks_pending";
  if (facts.mergeStateStatus === "BEHIND") return "behind";
  // HAS_HOOKS: mergeable, with passing statuses and pre-receive hooks.
  if (facts.mergeStateStatus === "HAS_HOOKS") return "ready";
  if (facts.mergeability === "blocked") {
    return facts.review === "review_required" || facts.review === "review_requested"
      ? "review"
      : "blocked";
  }
  // No conflict, nothing failing or running, no requested changes: GitHub
  // would show its merge button. A pending review request alone does not
  // block unless branch protection says so (that is `blocked` above).
  if (facts.mergeability === "mergeable") return "ready";
  // GitHub computes mergeability lazily; the server re-reads quickly.
  if (facts.mergeability === "unknown") return "checking";
  return "open";
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
    case "behind":
      return "update_branch";
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
  update_branch: "Update branch",
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
  blocked: "Blocked by branch rules",
  behind: "Behind base branch",
  queued: "In merge queue",
  checking: "Checking mergeability",
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
  blocked: { icon: "GitPullRequest", tone: "default" },
  behind: { icon: "GitPullRequest", tone: "default" },
  queued: { icon: "GitPullRequest", tone: "running" },
  checking: { icon: "GitPullRequest", tone: "default" },
  ready: { icon: "GitPullRequest", tone: "success" },
  open: { icon: "GitPullRequest", tone: "default" },
  merged: { icon: "GitMerge", tone: "default" },
  closed: { icon: "GitPullRequestClosed", tone: "default" },
};
