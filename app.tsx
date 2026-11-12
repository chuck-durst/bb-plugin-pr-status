// bb-plugin-pr-status — frontend.
//
// - Thread header: "Create PR" when the branch has none; otherwise a split
//   button tinted by the PR's state — `#123` on the left (opens bb's GitHub
//   PR tab, see lib/github-panel.ts), the
//   next step on the right (Mark ready, Fix checks, Merge, Archive…). Right
//   click for copy / open actions. Or, when the "Display" setting asks for it
//   or bb drops the plugin's own header slot, bb's shared header button
//   (bb 0.49+; label and icon, no tint): `#123 · <next step>`, with open,
//   copy and refresh in its menu. lib/display.ts picks the header,
//   lib/app-api.ts the API.
// - Sidebar: a PR glyph on each thread row. Row statuses can only be set from
//   a content script, which has no hooks, so an invisible app overlay reads
//   bb's own per-thread PR state and hands it over. A command running in the
//   Commands plugin wins the row: see `commandsRunningThreads`.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposer,
  useComposers,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  useSettings,
  type BbNavigate,
  type PluginBrowserBbSdk,
  type PluginComposerApi,
  type PluginComposerThreadRowStatus,
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
import {
  appApiMode,
  legacyHeaderSlot,
  sidebarPrFromLegacy,
  sidebarPrFromRow,
  useLegacySidebarThreadPullRequest,
  usePullRequestRows,
  type SidebarPr,
} from "@/lib/app-api";
import {
  ACTION_ICON,
  KIND_ICON,
  headerButtons,
  statusLabel,
  type HeaderButtonId,
  type HeaderCommand,
} from "@/lib/header-actions";
import { resolveDisplay, type Display, type DisplayCapabilities } from "@/lib/display";
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

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/**
 * Keeps the PR snapshots of `threadIds` in the shared cache: asks the server
 * on mount and on its signal, and keeps the threads on its watch list.
 */
function useWatchPrs(threadIds: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  // The ids as one value, so a new array with the same ids changes nothing.
  const key = threadIds.join("\n");

  const refetch = useCallback(
    (threadId: string, force = false) => {
      rpc.call("pr_get", { threadId, force }).then(
        (result) => prCache.setFromServer(threadId, result as PrSnapshot),
        () => undefined,
      );
    },
    [rpc],
  );
  const refetchAll = useCallback(() => {
    if (key === "") return;
    for (const threadId of key.split("\n")) refetch(threadId);
  }, [key, refetch]);

  useEffect(() => {
    refetchAll();
    // Also keeps the threads on the server's watch list while on screen.
    const timer = setInterval(refetchAll, HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refetchAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetchAll]);
  useRealtime(PR_CHANGED, (payload) => {
    const threadId = changedThreadId(payload);
    if (threadId !== null && key.split("\n").includes(threadId)) refetch(threadId);
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refetchAll();
  }, [connection, refetchAll]);

  return { rpc, refetch };
}

/**
 * The PR snapshot of one thread: the last known one from the shared cache
 * right away (stale-while-revalidate), refreshed from the server on mount and
 * on its signal.
 */
function useThreadPr(threadId: string) {
  const threadIds = useMemo(() => [threadId], [threadId]);
  const { rpc, refetch: refetchThread } = useWatchPrs(threadIds);
  const snapshot = useCachedPr(threadId)?.snapshot ?? null;
  const refetch = useCallback(
    (force = false) => refetchThread(threadId, force),
    [refetchThread, threadId],
  );
  return { rpc, snapshot, refetch };
}

/**
 * The composer of `threadId`. A split layout renders one header per pane, so
 * the route's composer may belong to another thread.
 */
function useThreadComposer(threadId: string): PluginComposerApi {
  return composerFor(useComposers(), useComposer(), threadId);
}

function composerFor(
  composers: readonly PluginComposerApi[],
  routeComposer: PluginComposerApi,
  threadId: string,
): PluginComposerApi {
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

type PromptAction = "create" | "commit_push" | "fix_checks" | "fix_conflicts" | "address_review";

/** What a header button needs to act on one thread. */
interface PrActionContext {
  rpc: Rpc;
  threadId: string;
  composer: PluginComposerApi;
  archive: (threadId: string) => void;
  refetch: (force?: boolean) => void;
}

/** One step of the header button; throws with a message for the user. */
async function runPrAction(
  context: PrActionContext,
  action: Exclude<PrAction, null> | "create",
): Promise<void> {
  const { rpc, threadId, refetch } = context;
  switch (action) {
    case "mark_ready": {
      const result = await rpc.call("pr_mark_ready", { threadId });
      toast.success(result.message);
      refetch(true);
      return;
    }
    case "merge": {
      const result = await rpc.call("pr_merge", { threadId });
      toast.success(`${result.message} (${result.method})`);
      refetch(true);
      return;
    }
    case "update_branch": {
      const result = await rpc.call("pr_update_branch", { threadId });
      toast.success(result.message);
      refetch(true);
      return;
    }
    case "archive":
      context.archive(threadId);
      return;
    default: {
      const { prompt } = await rpc.call("pr_prompt", { threadId, action: action as PromptAction });
      await sendPrompt(context.composer, prompt);
    }
  }
}

// ---------------------------------------------------------------------------
// Thread header
// ---------------------------------------------------------------------------

/** Tint per state. Default-palette utilities: host tokens have no greens. */
const KIND_TINT: Record<PrKind, string> = {
  unpushed:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400",
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

function checksSummary(pr: PrInfo): string | null {
  const { failedCount, pendingCount, totalCount, state } = pr.checks;
  if (state === "no_checks") return "no checks";
  // A sidebar-sourced snapshot has the state but no counts yet.
  if (totalCount === 0) return `checks ${state}`;
  if (failedCount > 0) return `${failedCount}/${totalCount} checks failing`;
  if (pendingCount > 0) return `${totalCount - pendingCount}/${totalCount} checks done`;
  return `${totalCount}/${totalCount} checks passed`;
}

function localSummary(pr: PrInfo): string | null {
  if (pr.local === null || pr.local === undefined) return null;
  const parts = [
    pr.local.uncommitted > 0 ? `${pr.local.uncommitted} uncommitted file(s)` : null,
    pr.local.unpushed > 0 ? `${pr.local.unpushed} unpushed commit(s)` : null,
  ].filter(Boolean);
  return parts.length === 0 ? null : `Local: ${parts.join(", ")}`;
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
    localSummary(pr),
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

  const act = useCallback(
    (action: Exclude<PrAction, null> | "create") =>
      run(() =>
        runPrAction(
          { rpc, threadId, composer, archive: threadActions.archive, refetch },
          action,
        ),
      ),
    [run, rpc, threadId, composer, threadActions, refetch],
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
          onClick={() => void act("create")}
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
// Which header shows: the "Display" setting (lib/display.ts)
// ---------------------------------------------------------------------------

/** Set once by the app's setup, from what the running bb registers. */
let capabilities: DisplayCapabilities = { pluginSlot: true, sharedButton: false };

function useDisplayChoice() {
  const { values, isLoading } = useSettings();
  const value = (values as Record<string, unknown> | undefined)?.display;
  return { isLoading, choice: resolveDisplay(value, capabilities) };
}

/** The header to draw; null until the settings are known. */
function useDisplay(): Display | null {
  const { isLoading, choice } = useDisplayChoice();
  return isLoading ? null : choice.display;
}

function PluginHeaderAction(props: PluginThreadHeaderActionProps) {
  return useDisplay() === "plugin" ? <PrHeaderAction {...props} /> : null;
}

/** Writes the resolved header to the plugin log once per change. Renders nothing. */
function DisplayReport() {
  const rpc = useRpc<typeof rpcContract>();
  const { isLoading, choice } = useDisplayChoice();
  const key = isLoading ? null : JSON.stringify(choice);
  useEffect(() => {
    if (key === null) return;
    rpc.call("pr_display_report", JSON.parse(key) as typeof choice).catch(() => undefined);
  }, [rpc, key]);
  return null;
}

// ---------------------------------------------------------------------------
// Thread header from bb 0.49: thread actions with placement "header"
// ---------------------------------------------------------------------------

/** What the header thread actions read, for every thread with a header on screen. */
interface HeaderData {
  /** The "Display" setting resolved to bb's shared button. */
  visible: boolean;
  snapshots: ReadonlyMap<string, PrSnapshot>;
  pending: ReadonlySet<string>;
  run(threadId: string, command: HeaderCommand, hosts: OpenHosts): void;
}

/** What opening a PR from a thread action can use. */
interface OpenHosts {
  sdk: PluginBrowserBbSdk;
  navigate: BbNavigate;
  panel: { getTabs(): { tabs: readonly { key: string; title: string }[] }; selectTab(key: string): boolean };
}

const GITHUB_PR_TAB_TITLE = "GitHub PR";

/**
 * bb's "GitHub PR" tab when it is open or can be added, else the PR in a
 * browser. A thread action gets no DOM node to find bb's own panel opener
 * from, so the tab is selected through the panel controller.
 */
async function openPrFromAction(threadId: string, url: string, hosts: OpenHosts): Promise<void> {
  const select = () => {
    const tab = hosts.panel.getTabs().tabs.find((entry) => entry.title === GITHUB_PR_TAB_TITLE);
    return tab !== undefined && hosts.panel.selectTab(tab.key);
  };
  if (select()) return;
  try {
    await addGithubPrTab(hosts.sdk, threadId);
    if (!select()) toast.success("Added a “GitHub PR” tab to the thread panel");
  } catch {
    if (!hosts.navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  }
}

const NO_THREADS: readonly string[] = [];

/**
 * Called once for the whole app by bb, per registration, with the threads
 * whose header shows. Only the main button's copy watches the server; the
 * others read the same cache.
 */
function useHeaderData(threadIds: readonly string[], watch: boolean): HeaderData {
  const visible = useDisplay() === "bb";
  const { rpc, refetch } = useWatchPrs(watch && visible ? threadIds : NO_THREADS);
  const routeComposer = useComposer();
  const composers = useComposers();
  const threadActions = experimental_useSidebarThreadActions();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const version = useSyncExternalStore(prCache.subscribe, prCache.version);

  const snapshots = useMemo(() => {
    const map = new Map<string, PrSnapshot>();
    for (const threadId of threadIds) {
      const cached = prCache.get(threadId);
      if (cached !== undefined) map.set(threadId, cached.snapshot);
    }
    return map;
    // `version` changes whenever the cache does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadIds, version]);

  const run = useCallback(
    (threadId: string, command: HeaderCommand, hosts: OpenHosts) => {
      if (command.type === "open") {
        void openPrFromAction(threadId, command.url, hosts);
        return;
      }
      if (command.type === "copy_link") {
        void copy(command.url, "PR link");
        return;
      }
      if (command.type === "refresh") {
        refetch(threadId, true);
        return;
      }
      if (pending.has(threadId)) return;
      const mark = (on: boolean) =>
        setPending((current) => {
          const next = new Set(current);
          if (on) next.add(threadId);
          else next.delete(threadId);
          return next;
        });
      mark(true);
      const action = command.type === "create" ? "create" : command.action;
      runPrAction(
        {
          rpc,
          threadId,
          composer: composerFor(composers, routeComposer, threadId),
          archive: threadActions.archive,
          refetch: (force) => refetch(threadId, force),
        },
        action,
      )
        .catch((cause) => toast.error(errorMessage(cause)))
        .finally(() => mark(false));
    },
    [pending, refetch, rpc, composers, routeComposer, threadActions],
  );

  return useMemo(() => ({ visible, snapshots, pending, run }), [visible, snapshots, pending, run]);
}

function useMainHeaderData({ threadIds }: { threadIds: readonly string[] }): HeaderData {
  return useHeaderData(threadIds, true);
}

function useSecondaryHeaderData({ threadIds }: { threadIds: readonly string[] }): HeaderData {
  return useHeaderData(threadIds, false);
}

const HEADER_BUTTONS: { id: HeaderButtonId; title: string; icon: string }[] = [
  { id: "pr-next", title: "Pull request", icon: "GitPullRequest" },
  { id: "pr-open", title: "Open pull request", icon: "GitPullRequest" },
  { id: "pr-copy-link", title: "Copy pull request link", icon: "Copy" },
  { id: "pr-refresh", title: "Refresh pull request status", icon: "ArrowReloadHorizontal" },
];

/** Sorts after bb's Git group, so Commit stays the main button when it shows. */
const HEADER_GROUP = "pr-status";

/** Minimal `app.slots.experimental_threadAction` typing (SDK 0.6.94+). */
type ThreadActionSlot = (registration: {
  id: string;
  title: string;
  icon: string;
  group: string;
  order?: number;
  placement: "header";
  useData: (input: { threadIds: readonly string[] }) => HeaderData;
  item: (input: {
    thread: { id: string; archivedAt: number | null };
    data: HeaderData;
    sdk: PluginBrowserBbSdk;
    navigate: BbNavigate;
    experimental_panel: OpenHosts["panel"];
  }) => { label: string; icon: string; detail?: string; disabled?: boolean; run: () => void } | null;
}) => void;

function registerHeaderActions(slot: ThreadActionSlot): void {
  HEADER_BUTTONS.forEach(({ id, title, icon }, order) => {
    slot({
      id,
      title,
      icon,
      group: HEADER_GROUP,
      order,
      placement: "header",
      useData: id === "pr-next" ? useMainHeaderData : useSecondaryHeaderData,
      item: ({ thread, data, sdk, navigate, experimental_panel }) => {
        if (!data.visible) return null;
        if (thread.archivedAt !== null && id !== "pr-next") return null;
        const button = headerButtons(data.snapshots.get(thread.id), data.pending.has(thread.id))[id];
        if (button === undefined) return null;
        const hosts = { sdk, navigate, panel: experimental_panel };
        return {
          label: button.label,
          icon: button.icon,
          ...(button.detail === undefined ? {} : { detail: button.detail }),
          ...(button.disabled === true ? { disabled: true } : {}),
          run: () => data.run(thread.id, button.command, hosts),
        };
      },
    });
  });
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

/**
 * `hasLocalChanges` comes from the server's last snapshot of the thread, when
 * the header has asked for one: bb's sidebar data cannot know it.
 */
function rowStatusOf(pr: SidebarPr, hasLocalChanges: boolean): PluginComposerThreadRowStatus {
  const kind = derivePrKind({
    state: pr.state,
    checks: pr.checks,
    review: pr.review,
    mergeability: pr.mergeability,
    inMergeQueue: pr.inMergeQueue,
    hasLocalChanges,
  });
  return { ...KIND_ROW_STATUS[kind], label: `PR #${pr.number} — ${KIND_LABELS[kind]}` };
}

/** Mirrors bb's PR state of one thread into the bridge. Renders nothing. */
function ThreadPrProbe({
  threadId,
  pullRequest,
  isLoading,
}: {
  threadId: string;
  pullRequest: SidebarPr | null;
  isLoading: boolean;
}) {
  const cached = useCachedPr(threadId);
  const hasLocalChanges =
    cached?.source === "server" &&
    cached.snapshot.pr?.number === pullRequest?.number &&
    cached.snapshot.pr?.kind === "unpushed";
  // Warm the header's cache: opening this thread then renders at once.
  useEffect(() => {
    if (!isLoading) prCache.setFromSidebar(threadId, pullRequest);
  }, [threadId, pullRequest, isLoading]);
  // bb misses a PR pushed under another branch name; the server finds it.
  const serverPr = cached?.source === "server" ? cached.snapshot.pr : null;
  // The source may hand back a new object for the same state; key on content.
  const status =
    pullRequest !== null
      ? rowStatusOf(pullRequest, hasLocalChanges)
      : !isLoading && serverPr !== null
        ? { ...KIND_ROW_STATUS[serverPr.kind], label: `PR #${serverPr.number} — ${KIND_LABELS[serverPr.kind]}` }
        : null;
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

/** bb ≤ 0.46: bb's own per-row PR hook. */
function LegacyThreadPrProbe({ threadId }: { threadId: string }) {
  const { pullRequest, isLoading } = useLegacySidebarThreadPullRequest(threadId);
  const pr = useMemo(
    () => (pullRequest === null ? null : sidebarPrFromLegacy(pullRequest)),
    [pullRequest],
  );
  return <ThreadPrProbe threadId={threadId} pullRequest={pr} isLoading={isLoading} />;
}

/** Only threads on a branch can have a PR. */
function useCandidateThreads() {
  const { threads } = experimental_useSidebarThreads();
  return threads.filter(
    (thread) => !thread.isHidden && (thread.environment?.branchName ?? null) !== null,
  );
}

// bb shares one lookup per environment with its own UI, so neither sync adds
// GitHub traffic of its own.

function LegacyPrRowStatusSync() {
  const candidates = useCandidateThreads();
  return (
    <>
      {candidates.map((thread) => (
        <LegacyThreadPrProbe key={thread.id} threadId={thread.id} />
      ))}
    </>
  );
}

function environmentIdOf(thread: { environment: { id: string | null } | null }): string[] {
  const id = thread.environment?.id ?? null;
  return id === null ? [] : [id];
}

/** bb 0.49+: one keyed read of GitHub PR Status for every listed row. */
function PrRowStatusSync() {
  const candidates = useCandidateThreads();
  const environmentIds = useMemo(
    () => [...new Set(candidates.flatMap((thread) => environmentIdOf(thread)))].sort(),
    // The ids, not the array bb rebuilds on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates.map((thread) => thread.environment?.id ?? "").join("\n")],
  );
  const { data, error } = usePullRequestRows(environmentIds);
  return (
    <>
      {candidates.map((thread) => {
        const [environmentId] = environmentIdOf(thread);
        const row = environmentId === undefined ? undefined : data?.[environmentId];
        return (
          <ThreadPrProbe
            key={thread.id}
            threadId={thread.id}
            pullRequest={sidebarPrFromRow(row)}
            // A failed read is nothing to show, not a read in progress.
            isLoading={error == null && row === undefined}
          />
        );
      })}
    </>
  );
}

export default definePluginApp((app) => {
  const mode = appApiMode();
  const pluginSlot = legacyHeaderSlot(app.slots);
  capabilities = { pluginSlot: pluginSlot !== null, sharedButton: mode === "header-action" };
  // Both headers are registered when bb has both; each shows only when the
  // "Display" setting resolves to it. On bb 0.46 a header thread action
  // would land in the thread menus instead, so it is not registered there.
  pluginSlot?.({
    id: "pr-status",
    title: "Pull request",
    component: PluginHeaderAction,
  });
  if (capabilities.sharedButton) {
    registerHeaderActions(
      (app.slots as unknown as { experimental_threadAction: ThreadActionSlot }).experimental_threadAction.bind(
        app.slots,
      ),
    );
  }

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
    component: mode === "header-action" ? PrRowStatusSync : LegacyPrRowStatusSync,
  });

  app.slots.experimental_appOverlay({
    id: "pr-display-report",
    component: DisplayReport,
  });
});
