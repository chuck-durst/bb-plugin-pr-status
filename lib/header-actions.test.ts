import { describe, expect, it } from "vitest";
import { headerButtons } from "./header-actions";
import type { PrInfo, PrSnapshot } from "../server";
import type { PrKind } from "./pr-state";

function pr(kind: PrKind, overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Add the thing",
    url: "https://github.com/acme/app/pull/42",
    state: kind === "merged" ? "merged" : kind === "draft" ? "draft" : "open",
    attention: "none",
    kind,
    baseRefName: "main",
    headRefName: "feature",
    autoMerge: false,
    checks: { state: "pending", failedCount: 0, passedCount: 2, pendingCount: 1, totalCount: 3 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN" },
    inMergeQueue: false,
    local: null,
    ...overrides,
  };
}

function snapshot(value: PrInfo | null, canCreate = false): PrSnapshot {
  return { outcome: value === null ? "none" : "pr", pr: value, canCreate, message: null, fetchedAt: 0 };
}

describe("headerButtons", () => {
  it("shows nothing before the first answer, without a lookup, or on the default branch", () => {
    expect(headerButtons(undefined, false)).toEqual({});
    expect(headerButtons(null, false)).toEqual({});
    expect(headerButtons({ ...snapshot(null), outcome: "unavailable" }, false)).toEqual({});
    expect(headerButtons(snapshot(null, false), false)).toEqual({});
  });

  it("offers Create PR alone when the branch has none", () => {
    const buttons = headerButtons(snapshot(null, true), false);
    expect(Object.keys(buttons)).toEqual(["pr-next"]);
    expect(buttons["pr-next"]).toMatchObject({ label: "Create PR", command: { type: "create" } });
  });

  it("puts the number and the next step on the main button", () => {
    const buttons = headerButtons(snapshot(pr("ready")), false);
    expect(buttons["pr-next"]).toMatchObject({
      label: "#42 · Merge",
      icon: "GitMerge",
      command: { type: "act", action: "merge" },
    });
    expect(buttons["pr-open"]).toMatchObject({ label: "Open PR #42", command: { type: "open" } });
    expect(buttons["pr-copy-link"]?.command).toEqual({ type: "copy_link", url: pr("ready").url });
    expect(buttons["pr-refresh"]?.command).toEqual({ type: "refresh" });
  });

  it("opens the PR from the main button when there is no next step", () => {
    const buttons = headerButtons(snapshot(pr("checks_pending")), false);
    expect(buttons["pr-next"]).toMatchObject({
      label: "#42 · Checks running 2/3",
      command: { type: "open", url: pr("ready").url },
    });
  });

  it("disables the main button while its step runs", () => {
    expect(headerButtons(snapshot(pr("checks_failed")), true)["pr-next"]).toMatchObject({
      label: "#42 · …",
      disabled: true,
    });
  });
});
