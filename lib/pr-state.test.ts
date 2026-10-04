import { describe, expect, it } from "vitest";
import { derivePrKind, prAction, type PrFacts } from "./pr-state";

const open: PrFacts = {
  state: "open",
  checks: "passing",
  review: "none",
  mergeability: "mergeable",
  mergeStateStatus: "CLEAN",
  inMergeQueue: false,
};

describe("derivePrKind", () => {
  it.each<[string, Partial<PrFacts>, string]>([
    // bb says `none` for these; GitHub shows the merge button.
    ["no checks", { checks: "no_checks" }, "ready"],
    ["checks without a conclusion", { checks: "unknown" }, "ready"],
    ["review requested but not required", { review: "review_requested" }, "ready"],
    ["approved", { review: "approved" }, "ready"],
    ["HAS_HOOKS", { mergeability: "blocked", mergeStateStatus: "HAS_HOOKS" }, "ready"],
    ["UNSTABLE (optional check failed)", { mergeStateStatus: "UNSTABLE" }, "ready"],
    // What bb lumps into `blocked`.
    ["behind its base", { mergeability: "blocked", mergeStateStatus: "BEHIND" }, "behind"],
    ["required review", { mergeability: "blocked", mergeStateStatus: "BLOCKED", review: "review_required" }, "review"],
    ["other branch rules", { mergeability: "blocked", mergeStateStatus: "BLOCKED" }, "blocked"],
    // GitHub computes mergeability lazily.
    ["mergeability unknown", { mergeability: "unknown", mergeStateStatus: "UNKNOWN" }, "checking"],
    // Work to do, most pressing first.
    ["conflicts", { mergeability: "conflicts", checks: "failing" }, "conflicts"],
    ["checks failing", { checks: "failing", review: "changes_requested" }, "checks_failed"],
    ["changes requested", { review: "changes_requested" }, "changes_requested"],
    ["draft", { state: "draft", mergeability: "draft" }, "draft"],
    ["merge queue", { inMergeQueue: true }, "queued"],
    ["checks running", { checks: "pending" }, "checks_pending"],
    ["merged", { state: "merged" }, "merged"],
    ["closed", { state: "closed", mergeability: "unknown" }, "closed"],
  ])("%s", (_name, facts, kind) => {
    expect(derivePrKind({ ...open, ...facts })).toBe(kind);
  });

  it("works without mergeStateStatus (sidebar data)", () => {
    const { mergeStateStatus: _omit, ...sidebar } = open;
    expect(derivePrKind({ ...sidebar, checks: "no_checks" })).toBe("ready");
    expect(derivePrKind({ ...sidebar, mergeability: "blocked" })).toBe("blocked");
  });
});

describe("prAction", () => {
  it("offers Merge on a ready PR and nothing while waiting", () => {
    expect(prAction("ready")).toBe("merge");
    expect(prAction("behind")).toBe("update_branch");
    expect(prAction("checking")).toBeNull();
    expect(prAction("blocked")).toBeNull();
  });
});
