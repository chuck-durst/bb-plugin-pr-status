// The app-side bb API this plugin uses, on any bb version.
//
// bb 0.49 (Plugin SDK 0.6.94+) retired the header slot and the sidebar PR
// hook: a header button is a thread action with `placement: "header"`, and
// PRs are read from the bundled GitHub PR Status plugin. bb 0.46 has
// neither: it drops `placement` and shows the action in thread menus. Both
// arrived with `experimental_ThreadRowMetadata`, so its presence picks the
// API for PR reads and tells whether bb has the shared header button
// (lib/display.ts decides which header shows). The old members are read off the module namespace and by key: bb
// 0.49's build scans the source for named imports and dotted accesses of
// them, and warns even behind this check.
import * as sdkApp from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { z } from "zod";
import type { PrAttention, PrFacts } from "./pr-state";

export type AppApiMode = "header-action" | "legacy";

type Members = Record<string, unknown>;

const runtime = sdkApp as unknown as Members;

/** `header-action` from bb 0.49, `legacy` before. */
export function appApiMode(members: Members = runtime): AppApiMode {
  return members.experimental_ThreadRowMetadata !== undefined &&
    typeof members.experimental_useRpcKeyedQuery === "function"
    ? "header-action"
    : "legacy";
}

// ---------------------------------------------------------------------------
// One PR as the sidebar knows it, whichever API it came from
// ---------------------------------------------------------------------------

export interface SidebarPr {
  number: number;
  title: string;
  url: string;
  state: PrFacts["state"];
  attention: PrAttention;
  autoMerge: boolean;
  inMergeQueue: boolean | null;
  checks: PrFacts["checks"];
  review: PrFacts["review"];
  mergeability: PrFacts["mergeability"];
}

/** `experimental_useSidebarThreadPullRequest`'s pull request (bb ≤ 0.46). */
export interface LegacySidebarPullRequest {
  number: number;
  title: string;
  url: string;
  state: PrFacts["state"];
  attention: PrAttention;
  experimental_autoMerge: boolean;
  experimental_inMergeQueue: boolean | null;
  experimental_checks: { state: PrFacts["checks"] };
  experimental_review: { state: PrFacts["review"] };
  experimental_mergeability: { state: PrFacts["mergeability"] };
}

export function sidebarPrFromLegacy(pr: LegacySidebarPullRequest): SidebarPr {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    attention: pr.attention,
    autoMerge: pr.experimental_autoMerge,
    inMergeQueue: pr.experimental_inMergeQueue,
    checks: pr.experimental_checks.state,
    review: pr.experimental_review.state,
    mergeability: pr.experimental_mergeability.state,
  };
}

// The part of GitHub PR Status's `pullRequests` read this plugin uses
// (`bb plugin rpc inspect bb--github-pr-status pullRequests`). A plain
// object, as `defineRpcContract` returns: the app bundle stays off the SDK's
// server entry.
export const githubPrStatusContract = {
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
            attention: z.string(),
            autoMerge: z.boolean(),
            inMergeQueue: z.boolean().nullable(),
            checks: z.object({ state: z.string() }),
            review: z.object({ state: z.string() }),
            mergeability: z.object({ state: z.string() }),
            // Also updatedAt, branches, counts and raw merge state.
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
};

type PullRequestRows = z.infer<(typeof githubPrStatusContract)["pullRequests"]["output"]>;
export type PullRequestRow = PullRequestRows[string];

/** A row of `pullRequests`; null for `absent`, `unavailable` or no row. */
export function sidebarPrFromRow(row: PullRequestRow | undefined): SidebarPr | null {
  if (row?.outcome !== "available") return null;
  const pr = row.pullRequest;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    // The enums of bb's own PR facts, as the legacy hook types them.
    attention: pr.attention as PrAttention,
    autoMerge: pr.autoMerge,
    inMergeQueue: pr.inMergeQueue,
    checks: pr.checks.state as PrFacts["checks"],
    review: pr.review.state as PrFacts["review"],
    mergeability: pr.mergeability.state as PrFacts["mergeability"],
  };
}

// ---------------------------------------------------------------------------
// Members missing from one SDK version's typings
// ---------------------------------------------------------------------------

/** `experimental_useSidebarThreadPullRequest` (bb ≤ 0.46). */
export function useLegacySidebarThreadPullRequest(threadId: string): {
  pullRequest: LegacySidebarPullRequest | null;
  isLoading: boolean;
} {
  const hook = runtime["experimental_useSidebarThreadPullRequest"] as (threadId: string) => {
    pullRequest: LegacySidebarPullRequest | null;
    isLoading: boolean;
  };
  return hook(threadId);
}

/** `experimental_useRpcKeyedQuery` over GitHub PR Status (bb 0.49+). */
export function usePullRequestRows(environmentIds: readonly string[]): {
  data: PullRequestRows | undefined;
  error: unknown;
} {
  const hook = runtime["experimental_useRpcKeyedQuery"] as (options: {
    pluginId: string;
    contract: typeof githubPrStatusContract;
    method: "pullRequests";
    keys: readonly string[];
  }) => { data: PullRequestRows | undefined; error?: unknown };
  const { data, error } = hook({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatusContract,
    method: "pullRequests",
    keys: environmentIds,
  });
  return { data, error };
}

/** `app.slots` members this plugin registers, across versions. */
export interface LegacyHeaderSlot {
  (registration: {
    id: string;
    title: string;
    component: ComponentType<{ threadId: string; projectId: string; isCompactViewport: boolean }>;
  }): void;
}

/** The plugin's own header slot; null once bb no longer has it. */
export function legacyHeaderSlot(slots: object): LegacyHeaderSlot | null {
  const slot = (slots as Members)["experimental_threadHeaderAction"];
  return typeof slot === "function" ? (slot as LegacyHeaderSlot).bind(slots) : null;
}
