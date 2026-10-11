// A PR read with `gh pr view --json`, shaped like bb's own
// `environments.pullRequest` result. Server only.
//
// bb finds a branch's PR with a bare `gh pr view`, which looks it up by the
// local branch name. A worktree branch (`bb/…-thr_xxx`) pushed under another
// name (`git push -u origin HEAD:feature/x`) then never shows its PR: bb
// answers `absent`. The server falls back to `gh pr view <upstream branch>`
// and converts the result here, with the same rules as bb (copied from its
// server's pull-request.ts) so both sources yield the same states.

/** Fields bb asks `gh pr view` for. */
export const GH_PR_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "isDraft",
  "autoMergeRequest",
  "baseRefName",
  "headRefName",
  "statusCheckRollup",
  "reviewDecision",
  "reviewRequests",
  "mergeStateStatus",
  "mergeable",
].join(",");

export interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  attention:
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
  baseRefName: string;
  headRefName: string;
  autoMerge: boolean;
  checks: {
    state: "failing" | "no_checks" | "passing" | "pending" | "unknown";
    failedCount: number;
    passedCount: number;
    pendingCount: number;
    totalCount: number;
  };
  review: {
    state: "approved" | "changes_requested" | "none" | "review_requested" | "review_required";
    reviewRequestCount: number;
  };
  mergeability: {
    state: "blocked" | "conflicts" | "draft" | "mergeable" | "unknown";
    mergeStateStatus: string | null;
  };
  inMergeQueue: boolean | null;
}

type Json = Record<string, unknown>;

function upper(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : null;
}

function checkStatus(value: unknown): "pending" | "completed" | "unknown" {
  switch (upper(value)) {
    case "QUEUED":
    case "REQUESTED":
    case "WAITING":
    case "EXPECTED":
    case "IN_PROGRESS":
    case "PENDING":
      return "pending";
    case "COMPLETED":
    case "SUCCESS":
    case "FAILURE":
    case "ERROR":
    case "CANCELLED":
    case "SKIPPED":
    case "NEUTRAL":
      return "completed";
    default:
      return "unknown";
  }
}

function checkOutcome(value: unknown): "passed" | "failed" | null {
  switch (upper(value)) {
    case "SUCCESS":
    case "SKIPPED":
    case "NEUTRAL":
      return "passed";
    case "FAILURE":
    case "ERROR":
    case "CANCELLED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "STALE":
      return "failed";
    default:
      return null;
  }
}

/** One entry per check name, the latest run winning, then counted. */
function summarizeChecks(rollup: unknown): GhPullRequest["checks"] {
  const latest = new Map<string, { started: number; item: Json }>();
  for (const item of Array.isArray(rollup) ? (rollup as Json[]) : []) {
    if (typeof item !== "object" || item === null) continue;
    const name =
      [item.name, item.context, item.workflowName].find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      ) ?? "Unnamed check";
    const startedAt = item.startedAt ?? item.createdAt;
    const started = typeof startedAt === "string" ? Date.parse(startedAt) || 0 : 0;
    const current = latest.get(name);
    if (current === undefined || started >= current.started) latest.set(name, { started, item });
  }
  let passedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let unknownCount = 0;
  for (const { item } of latest.values()) {
    if (checkStatus(item.status ?? item.state) === "pending") {
      pendingCount += 1;
      continue;
    }
    const outcome = checkOutcome(item.conclusion) ?? checkOutcome(item.state);
    if (outcome === "passed") passedCount += 1;
    else if (outcome === "failed") failedCount += 1;
    else unknownCount += 1;
  }
  const totalCount = latest.size;
  const state =
    totalCount === 0
      ? "no_checks"
      : failedCount > 0
        ? "failing"
        : pendingCount > 0
          ? "pending"
          : unknownCount > 0
            ? "unknown"
            : "passing";
  return { state, failedCount, passedCount, pendingCount, totalCount };
}

/** bb's one-word summary, most pressing first. */
function attentionOf(
  state: GhPullRequest["state"],
  checks: GhPullRequest["checks"],
  review: GhPullRequest["review"],
  mergeability: GhPullRequest["mergeability"],
  inMergeQueue: boolean | null,
): GhPullRequest["attention"] {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  if (mergeability.state === "conflicts") return "conflicts";
  if (checks.state === "failing") return "checks_failed";
  if (review.state === "changes_requested") return "changes_requested";
  if (state === "draft") return "draft";
  if (inMergeQueue) return "queued";
  if (review.state === "review_requested" || review.state === "review_required") {
    return "review_requested";
  }
  if (checks.state === "pending") return "checks_pending";
  if (mergeability.state === "blocked") return "blocked";
  if (mergeability.state === "mergeable" && checks.state === "passing") return "ready_to_merge";
  return "none";
}

/** `gh pr view --json GH_PR_FIELDS` output as bb would report it; null if unusable. */
export function pullRequestFromGh(json: unknown, inMergeQueue: boolean | null): GhPullRequest | null {
  if (typeof json !== "object" || json === null) return null;
  const raw = json as Json;
  const ghState = upper(raw.state);
  if (
    typeof raw.number !== "number" ||
    typeof raw.title !== "string" ||
    typeof raw.url !== "string" ||
    (ghState !== "OPEN" && ghState !== "CLOSED" && ghState !== "MERGED")
  ) {
    return null;
  }
  const isDraft = raw.isDraft === true;
  const state = ghState === "MERGED" ? "merged" : ghState === "CLOSED" ? "closed" : isDraft ? "draft" : "open";
  const checks = summarizeChecks(raw.statusCheckRollup);

  const decision = upper(raw.reviewDecision);
  const reviewRequestCount = Array.isArray(raw.reviewRequests) ? raw.reviewRequests.length : 0;
  const requested = reviewRequestCount > 0 ? "review_requested" : null;
  const review: GhPullRequest["review"] = {
    state:
      decision === "APPROVED"
        ? "approved"
        : decision === "CHANGES_REQUESTED"
          ? "changes_requested"
          : decision === "REVIEW_REQUIRED"
            ? (requested ?? "review_required")
            : (requested ?? "none"),
    reviewRequestCount,
  };

  const mergeStateStatus = upper(raw.mergeStateStatus);
  const mergeable = upper(raw.mergeable);
  const mergeability: GhPullRequest["mergeability"] = {
    state:
      mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY"
        ? "conflicts"
        : ghState === "OPEN" && isDraft
          ? "draft"
          : mergeStateStatus === "BLOCKED" || mergeStateStatus === "BEHIND" || mergeStateStatus === "HAS_HOOKS"
            ? "blocked"
            : mergeable === "MERGEABLE" || mergeStateStatus === "CLEAN"
              ? "mergeable"
              : "unknown",
    mergeStateStatus,
  };

  const queued = state === "open" ? inMergeQueue : false;
  const attention = attentionOf(state, checks, review, mergeability, queued);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state,
    attention,
    baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
    headRefName: typeof raw.headRefName === "string" ? raw.headRefName : "",
    autoMerge: typeof raw.autoMergeRequest === "object" && raw.autoMergeRequest !== null,
    checks,
    review,
    mergeability,
    inMergeQueue: queued,
  };
}
