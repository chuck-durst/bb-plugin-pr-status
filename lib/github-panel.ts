// Open bb's built-in "GitHub PR" thread panel tab (plugin `github`, panel
// action `pull`) from this plugin.
//
// The SDK only lets a plugin open its own panels: `useBbNavigate()
// .openThreadPanel` stamps the caller's plugin id. Two ways around it, best
// first:
//
// 1. The thread view hands its real opener — the one bb's own "new tab"
//    launcher calls, which takes any `{ pluginId, actionId }` — down to its
//    children as an `openThreadPanel` prop. Walking up React's fiber tree from
//    our button finds it. It selects the tab and opens the panel, in this
//    window only. Internal: a bb release can rename it, so every step is
//    guarded and a miss falls through.
// 2. `sdk.threads.tabs` (public) persists the tab in the thread's tab list.
//    It shows up in every window but is neither selected nor opened.

import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

const GITHUB_PLUGIN_ID = "github";
const PULL_ACTION_ID = "pull";
const PULL_TITLE = "GitHub PR";

type HostPanelOpener = (options: {
  pluginId: string;
  actionId: string;
  title?: string;
}) => unknown;

/** Opens and focuses the tab through bb's own opener. False when not found. */
export function openGithubPrTabViaHost(from: Element): boolean {
  try {
    const fiberKey = Object.keys(from).find((key) => key.startsWith("__reactFiber$"));
    if (fiberKey === undefined) return false;
    const tried = new Set<unknown>();
    type Fiber = { return: Fiber | null; memoizedProps?: Record<string, unknown> | null };
    for (
      let fiber: Fiber | null = (from as unknown as Record<string, Fiber>)[fiberKey] ?? null;
      fiber !== null;
      fiber = fiber.return
    ) {
      const opener = fiber.memoizedProps?.openThreadPanel;
      if (typeof opener !== "function" || tried.has(opener)) continue;
      tried.add(opener);
      // A plugin-facing wrapper re-stamps our own id and declines (we have
      // no `pull` action); keep climbing until the host's opener accepts.
      const accepted = (opener as HostPanelOpener)({
        pluginId: GITHUB_PLUGIN_ID,
        actionId: PULL_ACTION_ID,
        title: PULL_TITLE,
      });
      if (accepted === true) return true;
    }
  } catch {
    // Internal shape changed: fall back.
  }
  return false;
}

/** Adds the tab to the thread's persisted tab list (not selected). */
export async function addGithubPrTab(sdk: PluginBrowserBbSdk, threadId: string): Promise<void> {
  const id = `plugin-panel:${encodeURIComponent(`${GITHUB_PLUGIN_ID}:${PULL_ACTION_ID}:`)}:none`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await sdk.threads.tabs.get({ threadId });
    if (current.tabs.some((tab) => tab.kind === "plugin-panel" && tab.id === id)) return;
    try {
      await sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: [
          ...current.tabs,
          {
            id,
            kind: "plugin-panel",
            pluginId: GITHUB_PLUGIN_ID,
            actionId: PULL_ACTION_ID,
            paramsJson: null,
            title: PULL_TITLE,
          },
        ],
      });
      return;
    } catch (cause) {
      // Another client changed the tabs in between: re-read and retry.
      if (!String(cause).includes("conflict")) throw cause;
    }
  }
}
