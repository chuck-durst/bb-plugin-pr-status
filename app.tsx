// bb-plugin-pr-status — frontend.
//
// - Thread header: "Create PR" when the branch has none; otherwise a split
//   button tinted by the PR's state — `#123` on the left (opens bb's GitHub
//   PR tab, see lib/github-panel.ts), the
//   next step on the right (Mark ready, Fix checks, Merge, Archive…). Right
//   click for copy / open actions.
// - Sidebar: a PR glyph on each thread row. Row statuses can only be set from
//   a content script, which has no hooks, so an invisible app overlay reads
//   bb's own per-thread PR state and hands it over. A command running in the
//   Commands plugin wins the row: see `commandsRunningThreads`.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposer,
  useComposers,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginComposerApi,
  type PluginComposerThreadRowStatus,
  type PluginSidebarPullRequest,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { PrInfo, PrSnapshot, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import {
  ACTION_LABELS,
  KIND_LABELS,
  KIND_ROW_STATUS,
  prAction,
  derivePrKind,
  type PrAction,
  type PrKind,
} from "@/lib/pr-state";
import { addGithubPrTab, openGithubPrTabViaHost } from "@/lib/github-panel";
import { prCache, useCachedPr } from "@/lib/pr-cache";
import { cn } from "@/lib/utils";

// Duplicated from server.ts: importing values from it would bundle the
// backend into the app.
const PR_CHANGED = "pr-changed";
/** The server keeps polling a thread while the app asked within 10 minutes. */
const HEARTBEAT_MS = 4 * 60_000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function changedThreadId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId = (payload as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}

/**
 * The PR snapshot of one thread: the last known one from the shared cache
 * right away (stale-while-revalidate), refreshed from the server on mount and
 * on its signal.
 */
function useThreadPr(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const snapshot = useCachedPr(threadId)?.snapshot ?? null;

  const refetch = useCallback(
    (force = false) => {
      rpc.call("pr_get", { threadId, force }).then(
        (result) => prCache.setFromServer(threadId, result as PrSnapshot),
        () => undefined,
      );
    },
    [rpc, threadId],
  );

  useEffect(() => {
    refetch();
    // Also keeps the thread on the server's watch list while it is on screen.
    const timer = setInterval(() => refetch(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetch]);
  useRealtime(PR_CHANGED, (payload) => {
    if (changedThreadId(payload) === threadId) refetch();
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);

  return { rpc, snapshot, refetch };
}

/**
 * The composer of `threadId`. A split layout renders one header per pane, so
 * the route's composer may belong to another thread.
 */
function useThreadComposer(threadId: string): PluginComposerApi {
  const routeComposer = useComposer();
  const composers = useComposers();
  return (
    composers.find(
      (composer) => composer.scope.kind === "thread" && composer.scope.threadId === threadId,
    ) ?? routeComposer
  );
}

/**
 * Send `prompt` to the thread's agent as if typed, then put back whatever the
 * user was drafting.
 */
async function sendPrompt(composer: PluginComposerApi, prompt: string): Promise<void> {
  const previous = composer.draft;
  composer.replace({ text: prompt, mentions: [], attachments: [] });
  try {
    await composer.submit({ experimental_data: { source: "pr-status" } });
  } catch (cause) {
    composer.replace(previous);
    throw cause;
  }
  if (previous.text.trim() !== "" || previous.attachments.length > 0) {
    composer.replace(previous);
  }
}

// ---------------------------------------------------------------------------
// Thread header
// ---------------------------------------------------------------------------

// Icon names must exist in bb's built-in set (a mix of Lucide and Hugeicons
// names, smaller than either); unknown names render as
// a generic glyph.

/** Tint per state. Default-palette utilities: host tokens have no greens. */
const KIND_TINT: Record<PrKind, string> = {
  ready:
    "border-green-500/40 bg-green-500/10 text-green-700 hover:bg-green-500/20 hover:text-green-700 dark:text-green-400 dark:hover:text-green-400",
  checks_failed:
    "border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/20 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400",
  conflicts:
    "border-orange-500/40 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-400",
  changes_requested:
    "border-orange-500/40 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-400",
  checks_pending:
    "border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-400",
  queued:
    "border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-400",
  review:
    "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-400",
  blocked:
    "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-400",
  behind:
    "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-400",
  merged:
    "border-purple-500/40 bg-purple-500/10 text-purple-700 hover:bg-purple-500/20 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-400",
  draft: "border-border bg-muted/60 text-muted-foreground",
  closed: "border-border bg-muted/60 text-muted-foreground",
  checking: "border-border",
  open: "border-border",
};

const KIND_ICON: Record<PrKind, string> = {
  draft: "GitPullRequestDraft",
  checks_pending: "Spinner",
  checks_failed: "CircleX",
  conflicts: "AlertTriangle",
  changes_requested: "MessageSquare",
  review: "Eye",
  blocked: "Lock",
  behind: "ArrowDown",
  queued: "ListEnd",
  checking: "Spinner",
  ready: "GitMerge",
  open: "GitPullRequest",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

const ACTION_ICON: Record<Exclude<PrAction, null>, string> = {
  mark_ready: "GitPullRequest",
  fix_checks: "ToolCase",
  fix_conflicts: "ToolCase",
  address_review: "MessageSquare",
  update_branch: "ArrowDown",
  merge: "GitMerge",
  archive: "Archive",
};

function checksSummary(pr: PrInfo): string | null {
  const { failedCount, pendingCount, totalCount, state } = pr.checks;
  if (state === "no_checks") return "no checks";
  // A sidebar-sourced snapshot has the state but no counts yet.
  if (totalCount === 0) return `checks ${state}`;
  if (failedCount > 0) return `${failedCount}/${totalCount} checks failing`;
  if (pendingCount > 0) return `${totalCount - pendingCount}/${totalCount} checks done`;
  return `${totalCount}/${totalCount} checks passed`;
}

/** Label of the right half when the state has no action. */
function statusLabel(pr: PrInfo): string {
  if (pr.kind === "checks_pending" && pr.checks.totalCount > 0) {
    const done = pr.checks.totalCount - pr.checks.pendingCount;
    return `Checks running ${done}/${pr.checks.totalCount}`;
  }
  if (pr.kind === "review") return "Review required";
  if (pr.kind === "blocked") return "Blocked";
  if (pr.kind === "checking") return "Checking…";
  return KIND_LABELS[pr.kind];
}

function prTitle(pr: PrInfo): string {
  const review =
    pr.review.state === "none" ? null : `review: ${pr.review.state.replace(/_/g, " ")}`;
  return [
    `PR #${pr.number} — ${pr.title}`,
    `${KIND_LABELS[pr.kind]} · ${[checksSummary(pr), review].filter(Boolean).join(" · ")}`,
    pr.headRefName === ""
      ? null
      : `${pr.headRefName} → ${pr.baseRefName}${pr.autoMerge ? " · auto-merge on" : ""}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch (cause) {
    toast.error(`Could not copy: ${errorMessage(cause)}`);
  }
}

function PrHeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { rpc, snapshot, refetch } = useThreadPr(threadId);
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const composer = useThreadComposer(threadId);
  const threadActions = experimental_useSidebarThreadActions();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (pending) return;
      setPending(true);
      try {
        await task();
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [pending],
  );

  const prompt = useCallback(
    (action: "create" | "fix_checks" | "fix_conflicts" | "address_review") =>
      run(async () => {
        const { prompt: text } = await rpc.call("pr_prompt", { threadId, action });
        await sendPrompt(composer, text);
      }),
    [run, rpc, threadId, composer],
  );

  const act = useCallback(
    (action: Exclude<PrAction, null>) => {
      switch (action) {
        case "mark_ready":
          return run(async () => {
            const result = await rpc.call("pr_mark_ready", { threadId });
            toast.success(result.message);
            refetch(true);
          });
        case "merge":
          return run(async () => {
            const result = await rpc.call("pr_merge", { threadId });
            toast.success(`${result.message} (${result.method})`);
            refetch(true);
          });
        case "update_branch":
          return run(async () => {
            const result = await rpc.call("pr_update_branch", { threadId });
            toast.success(result.message);
            refetch(true);
          });
        case "archive":
          return run(async () => {
            threadActions.archive(threadId);
          });
        default:
          return prompt(action);
      }
    },
    [run, rpc, threadId, refetch, threadActions, prompt],
  );

  /** bb's "GitHub PR" tab when we can reach it, else the PR in a browser. */
  const openPr = useCallback(
    async (button: Element, url: string) => {
      if (openGithubPrTabViaHost(button)) return;
      try {
        await addGithubPrTab(sdk, threadId);
        toast.success("Added a “GitHub PR” tab to the thread panel");
      } catch {
        if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
      }
    },
    [sdk, threadId, navigate],
  );

  // Nothing known yet for this thread: hold the spot with a neutral block the
  // size of the button rather than guess (no "Create PR" flash on a thread
  // that has a PR).
  if (snapshot === null) {
    return (
      <div
        aria-hidden
        data-pr-status-placeholder=""
        className="h-7 w-24 rounded-md border border-border bg-muted/40"
      />
    );
  }
  if (snapshot.outcome === "unavailable") return null;

  if (snapshot.pr === null) {
    if (!snapshot.canCreate) return null;
    return (
      <span title="Ask the agent to open a pull request for this branch" className="flex">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 border border-border px-2"
          disabled={pending}
          aria-label="Create PR"
          onClick={() => void prompt("create")}
        >
          <Icon name="GitPullRequestArrow" className="size-3.5" />
          {isCompactViewport ? null : <span>Create PR</span>}
        </Button>
      </span>
    );
  }

  const pr = snapshot.pr;
  const kind: PrKind = pr.kind;
  const action = prAction(kind);
  const tint = KIND_TINT[kind];
  const title = prTitle(pr);
  const rightLabel = action === null ? statusLabel(pr) : ACTION_LABELS[action];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex h-7 items-center" title={title}>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 gap-1 rounded-r-none border px-2 font-mono", tint)}
            aria-label={`Open pull request #${pr.number}`}
            onClick={(event) => void openPr(event.currentTarget, pr.url)}
          >
            <Icon name={KIND_ICON[kind]} className="size-3.5" />
            <span>#{pr.number}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 gap-1.5 rounded-l-none border border-l-0 px-2",
              tint,
              action === null && "pointer-events-none",
            )}
            disabled={pending}
            aria-disabled={action === null}
            aria-label={rightLabel}
            tabIndex={action === null ? -1 : undefined}
            onClick={() => {
              if (action !== null) void act(action);
            }}
          >
            {action !== null ? <Icon name={ACTION_ICON[action]} className="size-3.5" /> : null}
            {isCompactViewport && action !== null ? null : (
              <span className="max-w-40 truncate">{pending ? "…" : rightLabel}</span>
            )}
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onSelect={() => void copy(String(pr.number), "PR number")}>
          <Icon name="Copy" className="size-3.5" />
          Copy number
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy(pr.url, "PR link")}>
          <Icon name="Copy" className="size-3.5" />
          Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => window.open(pr.url, "_blank", "noopener")}>
          <Icon name="ExternalLink" className="size-3.5" />
          Open in browser
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => refetch(true)}>
          <Icon name="ArrowReloadHorizontal" className="size-3.5" />
          Refresh status
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Sidebar PR indicator
// ---------------------------------------------------------------------------

type RowStatusSetter = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;

// Shared with bb-plugin-commands. bb shows one status per row: the first
// plugin to set one keeps the row until it clears it. A running command
// matters more than the PR, so Commands publishes the rows it holds and this
// plugin stays off them.
const COMMANDS_RUNNING_GLOBAL = "__bbCommandsRunningThreads";
const COMMANDS_RUNNING_EVENT = "bb-commands:running-threads";

function commandsRunningThreads(): ReadonlySet<string> {
  const value = (globalThis as Record<string, unknown>)[COMMANDS_RUNNING_GLOBAL];
  return value instanceof Set ? (value as Set<string>) : new Set();
}

/** Bridges the hook-based overlay to the content script's row setter. */
const rowStatusBridge = {
  setter: null as RowStatusSetter | null,
  wanted: new Map<string, PluginComposerThreadRowStatus>(),
  applied: new Map<string, string>(),
  sync() {
    const setter = this.setter;
    if (setter === null) return;
    const held = commandsRunningThreads();
    const next = new Map<string, string>();
    for (const [threadId, status] of this.wanted) {
      if (!held.has(threadId)) next.set(threadId, JSON.stringify(status));
    }
    for (const threadId of this.applied.keys()) {
      if (!next.has(threadId)) setter(threadId, null);
    }
    for (const [threadId, key] of next) {
      if (this.applied.get(threadId) !== key) setter(threadId, this.wanted.get(threadId)!);
    }
    this.applied = next;
  },
};

function rowStatusOf(pr: PluginSidebarPullRequest): PluginComposerThreadRowStatus {
  const kind = derivePrKind({
    state: pr.state,
    checks: pr.experimental_checks.state,
    review: pr.experimental_review.state,
    mergeability: pr.experimental_mergeability.state,
    inMergeQueue: pr.experimental_inMergeQueue,
  });
  return { ...KIND_ROW_STATUS[kind], label: `PR #${pr.number} — ${KIND_LABELS[kind]}` };
}

/** Mirrors bb's PR state of one thread into the bridge. Renders nothing. */
function ThreadPrProbe({ threadId }: { threadId: string }) {
  const { pullRequest, isLoading } = experimental_useSidebarThreadPullRequest(threadId);
  // Warm the header's cache: opening this thread then renders at once.
  useEffect(() => {
    if (!isLoading) prCache.setFromSidebar(threadId, pullRequest);
  }, [threadId, pullRequest, isLoading]);
  // The hook may hand back a new object for the same state; key on content.
  const status = pullRequest === null ? null : rowStatusOf(pullRequest);
  const key = status === null ? null : JSON.stringify(status);
  useEffect(() => {
    if (key === null) {
      rowStatusBridge.wanted.delete(threadId);
    } else {
      rowStatusBridge.wanted.set(threadId, JSON.parse(key) as PluginComposerThreadRowStatus);
    }
    rowStatusBridge.sync();
  }, [threadId, key]);
  useEffect(
    () => () => {
      rowStatusBridge.wanted.delete(threadId);
      rowStatusBridge.sync();
    },
    [threadId],
  );
  return null;
}

function PrRowStatusSync() {
  const { threads } = experimental_useSidebarThreads();
  // Only threads on a branch can have a PR; bb shares one lookup per
  // environment with its own UI, so this adds no GitHub traffic of its own.
  const candidates = threads.filter(
    (thread) => !thread.isHidden && (thread.environment?.branchName ?? null) !== null,
  );
  return (
    <>
      {candidates.map((thread) => (
        <ThreadPrProbe key={thread.id} threadId={thread.id} />
      ))}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "pr-status",
    title: "Pull request",
    component: PrHeaderAction,
  });

  app.contentScripts.register({
    id: "pr-row-status",
    mount(context) {
      const setter = context.experimental_setThreadRowStatus;
      if (setter === undefined) return;
      rowStatusBridge.setter = setter;
      rowStatusBridge.applied = new Map();
      rowStatusBridge.sync();
      const onCommandsChanged = () => rowStatusBridge.sync();
      window.addEventListener(COMMANDS_RUNNING_EVENT, onCommandsChanged);
      return () => {
        window.removeEventListener(COMMANDS_RUNNING_EVENT, onCommandsChanged);
        // The host clears this generation's statuses itself.
        rowStatusBridge.setter = null;
        rowStatusBridge.applied = new Map();
      };
    },
  });

  app.slots.experimental_appOverlay({
    id: "pr-row-sync",
    component: PrRowStatusSync,
  });
});
