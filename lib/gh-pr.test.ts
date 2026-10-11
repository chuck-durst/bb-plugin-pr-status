import { describe, expect, it } from "vitest";
import { pullRequestFromGh } from "./gh-pr";

const base = {
  number: 750,
  title: "Arm states",
  state: "OPEN",
  url: "https://github.com/owner/repo/pull/750",
  isDraft: false,
  autoMergeRequest: null,
  baseRefName: "main",
  headRefName: "feature/player-anim-pr3",
  statusCheckRollup: [],
  reviewDecision: "",
  reviewRequests: [],
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
};

const check = (name: string, status: string, conclusion: string, startedAt = "2026-10-11T10:00:00Z") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  startedAt,
});

describe("pullRequestFromGh", () => {
  it("reads an open PR the way bb does", () => {
    const pr = pullRequestFromGh(
      { ...base, statusCheckRollup: [check("test", "COMPLETED", "SUCCESS")] },
      null,
    );
    expect(pr).toMatchObject({
      number: 750,
      state: "open",
      attention: "ready_to_merge",
      headRefName: "feature/player-anim-pr3",
      autoMerge: false,
      checks: { state: "passing", passedCount: 1, totalCount: 1 },
      review: { state: "none", reviewRequestCount: 0 },
      mergeability: { state: "mergeable", mergeStateStatus: "CLEAN" },
    });
  });

  it("keeps the latest run of each check", () => {
    const pr = pullRequestFromGh(
      {
        ...base,
        statusCheckRollup: [
          check("test", "COMPLETED", "FAILURE", "2026-10-11T10:00:00Z"),
          check("test", "IN_PROGRESS", "", "2026-10-11T11:00:00Z"),
          { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE" },
        ],
      },
      null,
    );
    expect(pr?.checks).toEqual({
      state: "failing",
      failedCount: 1,
      passedCount: 0,
      pendingCount: 1,
      totalCount: 2,
    });
    expect(pr?.attention).toBe("checks_failed");
  });

  it("maps drafts, conflicts, reviews and finished PRs", () => {
    expect(pullRequestFromGh({ ...base, isDraft: true, mergeStateStatus: "DRAFT" }, null)).toMatchObject({
      state: "draft",
      attention: "draft",
      mergeability: { state: "draft" },
    });
    expect(pullRequestFromGh({ ...base, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, null)?.attention).toBe(
      "conflicts",
    );
    expect(
      pullRequestFromGh({ ...base, reviewDecision: "REVIEW_REQUIRED", reviewRequests: [{ login: "a" }] }, null)?.review,
    ).toEqual({ state: "review_requested", reviewRequestCount: 1 });
    expect(pullRequestFromGh({ ...base, state: "MERGED" }, true)).toMatchObject({
      state: "merged",
      attention: "merged",
      inMergeQueue: false,
    });
  });

  it("rejects output that is not a PR", () => {
    expect(pullRequestFromGh(null, null)).toBeNull();
    expect(pullRequestFromGh({ ...base, number: "750" }, null)).toBeNull();
    expect(pullRequestFromGh({ ...base, state: "UNKNOWN" }, null)).toBeNull();
  });
});
