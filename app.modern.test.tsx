// @vitest-environment jsdom
// The app's registrations on bb 0.49 (SDK 0.6.94+). This repo's tests run
// on SDK 0.6.15 (bb ≤ 0.46, see app.test.tsx), so the SDK module gains the
// two members the app looks for, and setup runs against a recording `app`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { PrSnapshot, rpcContract } from "./server";

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  experimental_ThreadRowMetadata: () => null,
  experimental_useRpcKeyedQuery: () => ({ data: undefined }),
}));

type Registration = Record<string, unknown> & {
  id: string;
  item?: (input: unknown) => { label: string; icon: string; run: () => void } | null;
};

afterEach(cleanup);

/** `pluginSlot: false` stands for a bb that dropped the plugin's header slot. */
async function setUp({ pluginSlot = true } = {}) {
  const { default: plugin } = (await import("./app")) as unknown as {
    default: { setup: (app: unknown) => void };
  };
  const threadActions: Registration[] = [];
  const headerActions: Registration[] = [];
  const overlays: Registration[] = [];
  plugin.setup({
    slots: {
      experimental_threadAction: (registration: Registration) => threadActions.push(registration),
      ...(pluginSlot
        ? { experimental_threadHeaderAction: (registration: Registration) => headerActions.push(registration) }
        : {}),
      experimental_appOverlay: (registration: Registration) => overlays.push(registration),
    },
    contentScripts: { register: () => undefined },
  });
  return { threadActions, headerActions, overlays };
}

const snapshot: PrSnapshot = {
  outcome: "pr",
  canCreate: false,
  message: null,
  fetchedAt: 0,
  pr: {
    number: 42,
    title: "Add the thing",
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    attention: "checks_failed",
    kind: "checks_failed",
    baseRefName: "main",
    headRefName: "feature",
    autoMerge: false,
    checks: { state: "failing", failedCount: 1, passedCount: 2, pendingCount: 0, totalCount: 3 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN" },
    inMergeQueue: false,
    local: null,
  },
};

describe("on bb 0.49", () => {
  it("registers both headers while bb still has the plugin's slot", async () => {
    const { threadActions, headerActions } = await setUp();
    expect(headerActions.map((action) => action.id)).toEqual(["pr-status"]);
    expect(threadActions).toHaveLength(4);
  });

  it("registers only bb's shared button once the plugin's slot is gone", async () => {
    const { threadActions, headerActions } = await setUp({ pluginSlot: false });
    expect(headerActions).toEqual([]);
    expect(threadActions.map((action) => [action.id, action.placement, action.order])).toEqual([
      ["pr-next", "header", 0],
      ["pr-open", "header", 1],
      ["pr-copy-link", "header", 2],
      ["pr-refresh", "header", 3],
    ]);
    // Sorts after bb's Git group: Commit stays the main button.
    expect(threadActions.every((action) => (action.group as string) > "git")).toBe(true);
  });

  it("derives each button from the shared data and runs its command", async () => {
    const { threadActions } = await setUp();
    const run = vi.fn();
    const data = { visible: true, snapshots: new Map([["t1", snapshot]]), pending: new Set(), run };
    const input = (id: string) => ({
      thread: { id, archivedAt: null },
      data,
      sdk: {},
      navigate: {},
      experimental_panel: {},
    });
    const [next, open] = threadActions;
    expect(next!.item!(input("t1"))).toMatchObject({ label: "#42 · Fix checks", icon: "ToolCase" });
    expect(open!.item!(input("t1"))).toMatchObject({ label: "Open PR #42" });
    // A thread with nothing known yet shows no button.
    expect(next!.item!(input("t2"))).toBeNull();
    // Hidden whenever the "Display" setting resolves to the plugin's own header.
    expect(next!.item!({ ...input("t1"), data: { ...data, visible: false } })).toBeNull();
    next!.item!(input("t1"))!.run();
    expect(run).toHaveBeenCalledWith(
      "t1",
      { type: "act", action: "fix_checks" },
      expect.objectContaining({ panel: {} }),
    );
  });

  it("reads sidebar PRs through GitHub PR Status", async () => {
    const { overlays } = await setUp();
    expect((overlays[0]!.component as { name: string }).name).toBe("PrRowStatusSync");
  });

  function renderPluginHeader(component: unknown, display: string | undefined) {
    return renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(
      { component } as never,
      { threadId: "t1", projectId: "p1", isCompactViewport: false },
      {
        rpc: {
          pr_get: () => snapshot,
          pr_mark_ready: () => ({ message: "ready" }),
          pr_update_branch: () => ({ message: "updated" }),
          pr_merge: () => ({ message: "merged", method: "squash" }),
          pr_prompt: () => ({ prompt: "" }),
          pr_display_report: () => ({ ok: true }),
        },
        ...(display === undefined ? {} : { settings: { display } }),
      },
    );
  }

  it.each([
    [undefined, true],
    ["auto", true],
    ["plugin", true],
    ["bb", false],
  ])("Display %s → the plugin's own header shows: %s", async (display, shown) => {
    const { headerActions } = await setUp();
    const slot = renderPluginHeader(headerActions[0]!.component, display);
    if (shown) {
      expect(await slot.findByRole("button", { name: "Open pull request #42" })).toBeTruthy();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slot.container.innerHTML).toBe("");
    }
  });
});
