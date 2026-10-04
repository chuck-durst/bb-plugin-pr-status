// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
  PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { PrInfo, PrSnapshot, rpcContract } from "./server";
import type { PrKind } from "./lib/pr-state";

const app = await loadPluginApp(() => import("./app"));
const header = app.threadHeaderActions[0]!;
const overlay = app.appOverlays[0]!;

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__bbCommandsRunningThreads;
});

/** The header renders from the server's `kind`; the other facts feed labels. */
function pr(kind: PrKind, overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Add the thing",
    url: "https://github.com/acme/app/pull/42",
    state: kind === "merged" ? "merged" : kind === "closed" ? "closed" : kind === "draft" ? "draft" : "open",
    attention: "none",
    kind,
    baseRefName: "main",
    headRefName: "feature",
    autoMerge: false,
    checks: { state: "failing", failedCount: 1, passedCount: 2, pendingCount: 0, totalCount: 3 },
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN" },
    inMergeQueue: false,
    ...overrides,
  };
}

function snapshot(value: PrInfo | null, canCreate = false): PrSnapshot {
  return {
    outcome: value === null ? "none" : "pr",
    pr: value,
    canCreate,
    message: null,
    fetchedAt: 0,
  };
}

function renderHeader(initial: PrSnapshot) {
  return renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(
    header,
    { threadId: "t1", projectId: "p1", isCompactViewport: false },
    {
      rpc: {
        pr_get: () => initial,
        pr_mark_ready: () => ({ message: "ready" }),
        pr_update_branch: () => ({ message: "updated" }),
        pr_merge: () => ({ message: "Pull request merge started", method: "squash" }),
        pr_prompt: ({ action }) => ({ prompt: `prompt:${action}` }),
      },
      composer: { scope: { kind: "thread", threadId: "t1" } },
      openUrl: () => true,
    },
  );
}

describe("header", () => {
  it("offers Create PR when the branch has none, and sends the prompt", async () => {
    const slot = renderHeader(snapshot(null, true));
    fireEvent.click(await slot.findByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "pr_prompt")).toBe(true);
  });

  it("shows nothing on the default branch or without a GitHub PR lookup", async () => {
    const slot = renderHeader(snapshot(null, false));
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.queryByRole("button")).toBeNull();
  });

  it.each([
    ["draft", "Mark ready"],
    ["checks_failed", "Fix checks"],
    ["conflicts", "Fix conflicts"],
    ["changes_requested", "Address review"],
    ["ready", "Merge"],
    ["behind", "Update branch"],
    ["merged", "Archive"],
    ["closed", "Archive"],
  ] as const)("%s → %s", async (kind, label) => {
    const slot = renderHeader(snapshot(pr(kind)));
    expect(await slot.findByRole("button", { name: "Open pull request #42" })).toBeTruthy();
    expect(await slot.findByRole("button", { name: label })).toBeTruthy();
  });

  it.each([
    ["review", "Review required"],
    ["blocked", "Blocked"],
    ["checking", "Checking…"],
    ["queued", "In merge queue"],
  ] as const)("%s → %s, no action", async (kind, label) => {
    const slot = renderHeader(snapshot(pr(kind)));
    const button = await slot.findByRole("button", { name: label });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("updates a branch behind its base directly", async () => {
    const slot = renderHeader(snapshot(pr("behind")));
    fireEvent.click(await slot.findByRole("button", { name: "Update branch" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "pr_update_branch")).toBe(true),
    );
  });

  it("labels running checks without an action", async () => {
    const slot = renderHeader(
      snapshot(
        pr("checks_pending", {
          checks: { state: "pending", failedCount: 0, passedCount: 1, pendingCount: 2, totalCount: 3 },
        }),
      ),
    );
    const button = await slot.findByRole("button", { name: "Checks running 1/3" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("merges directly", async () => {
    const slot = renderHeader(snapshot(pr("ready")));
    fireEvent.click(await slot.findByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "pr_merge")).toBe(true),
    );
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("sends the fix-checks prompt and restores the user's draft", async () => {
    const slot = renderHeader(snapshot(pr("checks_failed")));
    await slot.behavior.setComposerText("my draft");
    fireEvent.click(await slot.findByRole("button", { name: "Fix checks" }));
    await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("my draft"));
  });

  it("archives a merged thread through the host", async () => {
    const slot = renderHeader(snapshot(pr("merged")));
    fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(slot.inspection.sidebarActionCalls).toHaveLength(1));
  });

  it("falls back to the browser when bb's GitHub tab is out of reach", async () => {
    const slot = renderHeader(snapshot(pr("ready")));
    fireEvent.click(await slot.findByRole("button", { name: "Open pull request #42" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "openUrl" }),
      ),
    );
  });
});

describe("sidebar", () => {
  function sidebarPr(
    facts: Partial<{
      checks: PluginSidebarPullRequest["experimental_checks"]["state"];
      mergeability: PluginSidebarPullRequest["experimental_mergeability"]["state"];
    }>,
  ): PluginSidebarPullRequest {
    return {
      number: 7,
      title: "x",
      url: "https://github.com/acme/app/pull/7",
      state: "open",
      attention: "none",
      experimental_autoMerge: false,
      experimental_inMergeQueue: null,
      experimental_checks: { state: facts.checks ?? "passing" },
      experimental_review: { state: "none" },
      experimental_mergeability: { state: facts.mergeability ?? "mergeable" },
    };
  }
  const thread = (id: string) =>
    ({ id, isHidden: false, environment: { id: `env-${id}`, branchName: `b-${id}` } }) as unknown as PluginSidebarThread;

  it("marks PR rows and yields rows held by a running command", async () => {
    const scripts = await mountPluginContentScripts(app, { pluginId: "pr-status" });
    const slot = renderSlot(overlay, {}, {
      sidebarThreads: { status: "ready", threads: [thread("a"), thread("b")] },
      sidebarPullRequests: {
        a: sidebarPr({ checks: "failing" }),
        // bb reports `attention: "none"` here: mergeable, no checks.
        b: sidebarPr({ checks: "no_checks" }),
      },
    });
    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("a")).toMatchObject({
        icon: "GitPullRequest",
        tone: "error",
      }),
    );
    expect(scripts.inspection.getThreadRowStatus("b")).toMatchObject({ tone: "success" });

    (globalThis as Record<string, unknown>).__bbCommandsRunningThreads = new Set(["a"]);
    window.dispatchEvent(new Event("bb-commands:running-threads"));
    expect(scripts.inspection.getThreadRowStatus("a")).toBeNull();
    expect(scripts.inspection.getThreadRowStatus("b")).not.toBeNull();

    (globalThis as Record<string, unknown>).__bbCommandsRunningThreads = new Set();
    window.dispatchEvent(new Event("bb-commands:running-threads"));
    expect(scripts.inspection.getThreadRowStatus("a")).toMatchObject({ tone: "error" });

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });
});
