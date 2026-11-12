import { describe, expect, it, vi } from "vitest";
import { createHostApi, GIT_PLUGIN, GITHUB_PR_PLUGIN } from "./host-api";
import type { GhPullRequest } from "./gh-pr";

const pullRequest: GhPullRequest = {
  number: 42,
  title: "Add the thing",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
  attention: "ready_to_merge",
  baseRefName: "main",
  headRefName: "feature",
  autoMerge: false,
  checks: { state: "passing", failedCount: 0, passedCount: 3, pendingCount: 0, totalCount: 3 },
  review: { state: "approved", reviewRequestCount: 0 },
  mergeability: { state: "mergeable", mergeStateStatus: "CLEAN" },
  inMergeQueue: false,
};

/** bb ≤ 0.46: the PR and git reads are `environments` methods. */
function legacySdk() {
  return {
    environments: {
      pullRequest: vi.fn(async () => ({ outcome: "available" as const, pullRequest })),
      markPullRequestReady: vi.fn(async () => ({ message: "ready" })),
      mergePullRequest: vi.fn(async ({ method }: { method: string }) => ({ message: "merged", method })),
      status: vi.fn(async () => ({
        outcome: "available" as const,
        workspace: {
          branch: { currentBranch: "feature", defaultBranch: "main" },
          workingTree: { files: [{}, {}] },
        },
      })),
    },
    plugins: { callRpc: vi.fn() },
  };
}

/** bb 0.49: those methods are gone; the bundled plugins answer. */
function pluginsSdk(answers: Record<string, (input: unknown) => unknown> = {}) {
  const callRpc = vi.fn(async ({ pluginId, method, input, outputSchema }: {
    pluginId: string;
    method: string;
    input: unknown;
    outputSchema: { parse(value: unknown): unknown };
  }) => {
    const answer = answers[`${pluginId}.${method}`];
    if (answer === undefined) throw new Error(`no ${pluginId}.${method}`);
    return outputSchema.parse(answer(input));
  });
  return {
    environments: { get: vi.fn(), commit: vi.fn() },
    plugins: { callRpc },
  };
}

describe("createHostApi", () => {
  it("uses bb's environments API while it still has pullRequest (bb ≤ 0.46)", async () => {
    const sdk = legacySdk();
    const host = createHostApi(sdk);
    expect(host.mode).toBe("legacy");
    await expect(host.pullRequest("env1")).resolves.toEqual({ outcome: "available", pullRequest });
    await expect(host.markReady("env1")).resolves.toEqual({ message: "ready" });
    await expect(host.merge("env1", "squash")).resolves.toEqual({ message: "merged", method: "squash" });
    await expect(host.workspace("env1")).resolves.toEqual({
      outcome: "available",
      currentBranch: "feature",
      defaultBranch: "main",
      uncommittedFiles: 2,
    });
    expect(sdk.environments.pullRequest).toHaveBeenCalledWith({ environmentId: "env1" });
    expect(sdk.environments.mergePullRequest).toHaveBeenCalledWith({ environmentId: "env1", method: "squash" });
    expect(sdk.plugins.callRpc).not.toHaveBeenCalled();
  });

  it("uses the GitHub PR Status and Git plugins once pullRequest is gone (bb 0.49)", async () => {
    const sdk = pluginsSdk({
      [`${GITHUB_PR_PLUGIN}.pullRequests`]: () => ({
        env1: { outcome: "available", pullRequest: { ...pullRequest, updatedAt: "2026-11-12T10:00:00Z" } },
      }),
      [`${GITHUB_PR_PLUGIN}.markReady`]: () => ({ message: "ready" }),
      [`${GITHUB_PR_PLUGIN}.merge`]: () => ({ message: "merged" }),
      [`${GIT_PLUGIN}.workspaceStatus`]: () => ({
        outcome: "available",
        workspace: {
          branch: { currentBranch: "feature", defaultBranch: "main" },
          workingTree: { fileCount: 3, files: [] },
        },
      }),
    });
    const host = createHostApi(sdk);
    expect(host.mode).toBe("plugins");
    const read = await host.pullRequest("env1");
    expect(read).toMatchObject({ outcome: "available", pullRequest: { number: 42, attention: "ready_to_merge" } });
    await expect(host.markReady("env1")).resolves.toEqual({ message: "ready" });
    // The plugin's merge does not echo the method; the caller chose it.
    await expect(host.merge("env1", "rebase")).resolves.toEqual({ message: "merged", method: "rebase" });
    await expect(host.workspace("env1")).resolves.toEqual({
      outcome: "available",
      currentBranch: "feature",
      defaultBranch: "main",
      uncommittedFiles: 3,
    });
    const calls = sdk.plugins.callRpc.mock.calls.map(([args]) => [args.pluginId, args.method, args.input]);
    expect(calls).toEqual([
      [GITHUB_PR_PLUGIN, "pullRequests", { keys: ["env1"] }],
      [GITHUB_PR_PLUGIN, "markReady", { environmentId: "env1" }],
      [GITHUB_PR_PLUGIN, "merge", { environmentId: "env1", method: "rebase" }],
      [GIT_PLUGIN, "workspaceStatus", { environmentId: "env1" }],
    ]);
  });

  it("re-checks GitHub before a fresh read, and still reads when that fails", async () => {
    const refresh = vi.fn(() => {
      throw new Error("gh failed");
    });
    const sdk = pluginsSdk({
      [`${GITHUB_PR_PLUGIN}.refresh`]: refresh,
      [`${GITHUB_PR_PLUGIN}.pullRequests`]: () => ({ env1: { outcome: "absent" } }),
    });
    const host = createHostApi(sdk);
    await expect(host.pullRequest("env1", { fresh: true })).resolves.toEqual({ outcome: "absent" });
    expect(refresh).toHaveBeenCalledWith({ environmentId: "env1" });
    await host.pullRequest("env1");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("passes on unavailable rows and reports a missing one", async () => {
    let rows: Record<string, unknown> = { env1: { outcome: "unavailable", message: "gh is not signed in" } };
    const host = createHostApi(pluginsSdk({ [`${GITHUB_PR_PLUGIN}.pullRequests`]: () => rows }));
    await expect(host.pullRequest("env1")).resolves.toEqual({
      outcome: "unavailable",
      message: "gh is not signed in",
    });
    rows = {};
    await expect(host.pullRequest("env1")).resolves.toMatchObject({ outcome: "unavailable" });
  });

  it("treats a non-git workspace as unavailable", async () => {
    const host = createHostApi(
      pluginsSdk({ [`${GIT_PLUGIN}.workspaceStatus`]: () => ({ outcome: "not_applicable" }) }),
    );
    await expect(host.workspace("env1")).resolves.toEqual({ outcome: "unavailable" });
  });

  it("fails loudly on a host with neither API", () => {
    expect(() => createHostApi({ environments: {}, plugins: {} })).toThrow(/neither/);
  });
});
