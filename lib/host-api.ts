// The bb calls the server makes for a PR and a workspace, on any bb version.
// Server only.
//
// Up to bb 0.46 they are `bb.sdk.environments` methods. bb 0.49 removed
// `pullRequest`, `markPullRequestReady` and `mergePullRequest` (the call
// throws, so the header had nothing to show) and retired `status`: the
// bundled GitHub PR Status (`bb--github-pr-status`) and Git (`bb--git`)
// plugins own them, reached with `bb.sdk.plugins.callRpc`. bb 0.46 has
// neither plugin, so the choice is made at run time on what the host has.
//
// bb 0.49's build warns on any source line that reads the retired status
// method off `environments`, even behind this check, so the old methods are
// reached through `legacyEnvironments` below.
import { z } from "zod";
import type { GhPullRequest } from "./gh-pr";

export type PullRequestRead =
  | { outcome: "available"; pullRequest: GhPullRequest }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string };

/** What the server reads of a workspace's git status. */
export type WorkspaceRead =
  | {
      outcome: "available";
      currentBranch: string | null;
      defaultBranch: string | null;
      uncommittedFiles: number;
    }
  | { outcome: "unavailable" };

export type MergeMethod = "merge" | "squash" | "rebase";

export const GITHUB_PR_PLUGIN = "bb--github-pr-status";
export const GIT_PLUGIN = "bb--git";

/** The `bb.sdk` members this module uses, typed loosely across versions. */
export interface HostSdk {
  environments: object;
  /** `callRpc` from SDK 0.6.49; typed below. */
  plugins?: object;
}

type CallRpc = (args: {
  pluginId: string;
  method: string;
  input?: unknown;
  outputSchema: z.ZodType<unknown>;
}) => Promise<unknown>;

/** `bb.sdk.environments` up to bb 0.46 (removed or retired in bb 0.49). */
interface LegacyEnvironments {
  pullRequest?: (args: { environmentId: string }) => Promise<PullRequestRead>;
  markPullRequestReady?: (args: { environmentId: string }) => Promise<{ message: string }>;
  mergePullRequest?: (args: {
    environmentId: string;
    method: MergeMethod;
  }) => Promise<{ message: string; method: string }>;
  status?: (args: { environmentId: string }) => Promise<
    | {
        outcome: "available";
        workspace: {
          branch: { currentBranch: string | null; defaultBranch: string | null };
          workingTree: { files: readonly unknown[] };
        };
      }
    | { outcome: string }
  >;
}

// Only the fields read here: the output schemas let unknown keys through.
const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  attention: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  autoMerge: z.boolean(),
  inMergeQueue: z.boolean().nullable(),
  checks: z.object({
    state: z.string(),
    failedCount: z.number(),
    passedCount: z.number(),
    pendingCount: z.number(),
    totalCount: z.number(),
  }),
  review: z.object({ state: z.string(), reviewRequestCount: z.number() }),
  mergeability: z.object({ state: z.string(), mergeStateStatus: z.string().nullable() }),
});

const pullRequestRowSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);

const pullRequestsSchema = z.record(z.string(), pullRequestRowSchema);
const messageSchema = z.object({ message: z.string() });
const okSchema = z.object({ ok: z.literal(true) });

const workspaceStatusSchema = z.union([
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      branch: z.object({
        currentBranch: z.string().nullable(),
        defaultBranch: z.string().nullable(),
      }),
      workingTree: z.object({ fileCount: z.number() }),
    }),
  }),
  z.object({ outcome: z.string() }),
]);

export interface HostApi {
  /** `legacy` up to bb 0.46, `plugins` from bb 0.49. */
  readonly mode: "legacy" | "plugins";
  /** `fresh` asks GitHub again instead of bb's saved row. */
  pullRequest(environmentId: string, options?: { fresh?: boolean }): Promise<PullRequestRead>;
  markReady(environmentId: string): Promise<{ message: string }>;
  merge(environmentId: string, method: MergeMethod): Promise<{ message: string; method: string }>;
  workspace(environmentId: string): Promise<WorkspaceRead>;
}

function legacyEnvironments(sdk: HostSdk): LegacyEnvironments {
  return sdk.environments as LegacyEnvironments;
}

/**
 * The old methods while the host still has `pullRequest`, the bundled
 * plugins otherwise.
 */
export function createHostApi(sdk: HostSdk): HostApi {
  const legacy = legacyEnvironments(sdk);
  if (typeof legacy.pullRequest === "function") return legacyHostApi(legacy);
  const plugins = sdk.plugins as { callRpc?: CallRpc } | undefined;
  if (typeof plugins?.callRpc !== "function") {
    throw new Error("This bb has neither environments.pullRequest nor plugins.callRpc.");
  }
  return pluginsHostApi(plugins.callRpc.bind(plugins));
}

function legacyHostApi(legacy: LegacyEnvironments): HostApi {
  return {
    mode: "legacy",
    pullRequest: (environmentId) => legacy.pullRequest!({ environmentId }),
    markReady: (environmentId) => legacy.markPullRequestReady!({ environmentId }),
    merge: (environmentId, method) => legacy.mergePullRequest!({ environmentId, method }),
    async workspace(environmentId) {
      if (typeof legacy.status !== "function") return { outcome: "unavailable" };
      const status = await legacy.status({ environmentId });
      if (status.outcome !== "available" || !("workspace" in status)) {
        return { outcome: "unavailable" };
      }
      const { branch, workingTree } = status.workspace;
      return {
        outcome: "available",
        currentBranch: branch.currentBranch,
        defaultBranch: branch.defaultBranch,
        uncommittedFiles: workingTree.files.length,
      };
    },
  };
}

function pluginsHostApi(callRpc: CallRpc): HostApi {
  function call<T>(pluginId: string, method: string, input: unknown, outputSchema: z.ZodType<T>) {
    return callRpc({ pluginId, method, input, outputSchema }) as Promise<T>;
  }
  return {
    mode: "plugins",
    async pullRequest(environmentId, options = {}) {
      if (options.fresh === true) {
        // Resolves once the plugin's row is current; a failure still
        // leaves the saved row to read.
        await call(GITHUB_PR_PLUGIN, "refresh", { environmentId }, okSchema).catch(() => undefined);
      }
      const rows = await call(
        GITHUB_PR_PLUGIN,
        "pullRequests",
        { keys: [environmentId] },
        pullRequestsSchema,
      );
      const row = rows[environmentId];
      if (row === undefined) return { outcome: "unavailable", message: "GitHub PR Status sent no row." };
      if (row.outcome !== "available") return row;
      return { outcome: "available", pullRequest: row.pullRequest as GhPullRequest };
    },
    markReady: (environmentId) =>
      call(GITHUB_PR_PLUGIN, "markReady", { environmentId }, messageSchema),
    async merge(environmentId, method) {
      const result = await call(GITHUB_PR_PLUGIN, "merge", { environmentId, method }, messageSchema);
      return { message: result.message, method };
    },
    async workspace(environmentId) {
      const status = await call(GIT_PLUGIN, "workspaceStatus", { environmentId }, workspaceStatusSchema);
      if (status.outcome !== "available" || !("workspace" in status)) {
        return { outcome: "unavailable" };
      }
      return {
        outcome: "available",
        currentBranch: status.workspace.branch.currentBranch,
        defaultBranch: status.workspace.branch.defaultBranch,
        uncommittedFiles: status.workspace.workingTree.fileCount,
      };
    },
  };
}
