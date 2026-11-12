import { describe, expect, it } from "vitest";
import { appApiMode, sidebarPrFromLegacy, sidebarPrFromRow } from "./app-api";

describe("appApiMode", () => {
  it("keeps the legacy header slot on bb ≤ 0.46", () => {
    // SDK 0.6.49 (bb 0.46.1): keyed queries, no row metadata, no header placement.
    expect(appApiMode({ experimental_useRpcKeyedQuery: () => undefined })).toBe("legacy");
    expect(appApiMode({})).toBe("legacy");
  });

  it("uses header thread actions from bb 0.49", () => {
    expect(
      appApiMode({
        experimental_ThreadRowMetadata: () => null,
        experimental_useRpcKeyedQuery: () => undefined,
      }),
    ).toBe("header-action");
  });

  it("reads the installed SDK by default (0.6.15 in this repo's tests)", () => {
    expect(appApiMode()).toBe("legacy");
  });
});

describe("sidebar PR sources", () => {
  const legacy = {
    number: 7,
    title: "Fix",
    url: "https://github.com/acme/app/pull/7",
    state: "open" as const,
    attention: "checks_failed" as const,
    experimental_autoMerge: true,
    experimental_inMergeQueue: null,
    experimental_checks: { state: "failing" as const },
    experimental_review: { state: "none" as const },
    experimental_mergeability: { state: "mergeable" as const },
  };
  const expected = {
    number: 7,
    title: "Fix",
    url: "https://github.com/acme/app/pull/7",
    state: "open",
    attention: "checks_failed",
    autoMerge: true,
    inMergeQueue: null,
    checks: "failing",
    review: "none",
    mergeability: "mergeable",
  };

  it("maps both APIs to the same facts", () => {
    expect(sidebarPrFromLegacy(legacy)).toEqual(expected);
    expect(
      sidebarPrFromRow({
        outcome: "available",
        pullRequest: {
          number: 7,
          title: "Fix",
          url: "https://github.com/acme/app/pull/7",
          state: "open",
          attention: "checks_failed",
          autoMerge: true,
          inMergeQueue: null,
          checks: { state: "failing" },
          review: { state: "none" },
          mergeability: { state: "mergeable" },
        },
      }),
    ).toEqual(expected);
  });

  it("shows nothing for absent, unavailable or missing rows", () => {
    expect(sidebarPrFromRow({ outcome: "absent" })).toBeNull();
    expect(sidebarPrFromRow({ outcome: "unavailable", message: "offline" })).toBeNull();
    expect(sidebarPrFromRow(undefined)).toBeNull();
  });
});
