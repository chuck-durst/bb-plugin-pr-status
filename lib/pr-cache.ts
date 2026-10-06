// Last known PR state per thread, shared by the header and the sidebar sync,
// so the header renders the right button the moment a thread opens and then
// revalidates in the background (stale-while-revalidate).
//
// Two writers:
// - the header, with the server's full snapshot (check counts, branches);
// - the sidebar sync, which already knows every listed thread's PR from bb.
//   Its entries are coarser, so they never replace a server entry.
// Persisted to localStorage so a reload starts warm.

import { useSyncExternalStore } from "react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import type { PrSnapshot } from "../server";
import { derivePrKind } from "./pr-state";

declare const __BB_PLUGIN_ID__: string | undefined;

export interface CachedPr {
  snapshot: PrSnapshot;
  /** `sidebar` entries lack check counts, branch names and local changes. */
  source: "server" | "sidebar";
}

const MAX_ENTRIES = 300;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const STORAGE_KEY = `${typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : "pr-status"}:pr-cache:v1`;

const entries = new Map<string, CachedPr>();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function load(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as [string, CachedPr][];
    const now = Date.now();
    for (const [threadId, entry] of parsed) {
      if (entry?.snapshot && now - entry.snapshot.fetchedAt < MAX_AGE_MS) {
        entries.set(threadId, entry);
      }
    }
  } catch {
    // A corrupt or foreign value only costs a cold start.
  }
}
load();

function persistSoon(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      const newest = [...entries].sort((a, b) => b[1].snapshot.fetchedAt - a[1].snapshot.fetchedAt);
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(newest.slice(0, MAX_ENTRIES)));
    } catch {
      // Storage full or unavailable: the in-memory cache still works.
    }
  }, 500);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export const prCache = {
  get(threadId: string): CachedPr | undefined {
    return entries.get(threadId);
  },
  /** A server snapshot always wins. */
  setFromServer(threadId: string, snapshot: PrSnapshot): void {
    const current = entries.get(threadId);
    if (current?.source === "server" && JSON.stringify(current.snapshot) === JSON.stringify(snapshot)) {
      return;
    }
    entries.set(threadId, { snapshot, source: "server" });
    persistSoon();
    emit();
  },
  /** bb's sidebar knowledge, used only until the server has answered. */
  setFromSidebar(threadId: string, pr: PluginSidebarPullRequest | null): void {
    const current = entries.get(threadId);
    if (current?.source === "server") return;
    if (pr === null) {
      // "No PR" from the sidebar is too weak to cache: it is also what bb
      // reports while its lookup failed.
      return;
    }
    const snapshot = snapshotFromSidebar(pr);
    if (current !== undefined && JSON.stringify({ ...current.snapshot, fetchedAt: 0 }) === JSON.stringify({ ...snapshot, fetchedAt: 0 })) {
      return;
    }
    entries.set(threadId, { snapshot, source: "sidebar" });
    persistSoon();
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Tests only. */
  clear(): void {
    entries.clear();
    emit();
  },
};

/** The cached entry for a thread, re-rendering when it changes. */
export function useCachedPr(threadId: string): CachedPr | undefined {
  return useSyncExternalStore(prCache.subscribe, () => prCache.get(threadId));
}

/** A coarse snapshot from bb's per-row PR facts. */
export function snapshotFromSidebar(pr: PluginSidebarPullRequest): PrSnapshot {
  const facts = {
    state: pr.state,
    checks: pr.experimental_checks.state,
    review: pr.experimental_review.state,
    mergeability: pr.experimental_mergeability.state,
    inMergeQueue: pr.experimental_inMergeQueue,
  };
  return {
    outcome: "pr",
    canCreate: false,
    message: null,
    fetchedAt: Date.now(),
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      attention: pr.attention,
      kind: derivePrKind(facts),
      baseRefName: "",
      headRefName: "",
      autoMerge: pr.experimental_autoMerge,
      checks: { state: facts.checks, failedCount: 0, passedCount: 0, pendingCount: 0, totalCount: 0 },
      review: { state: facts.review, reviewRequestCount: 0 },
      mergeability: { state: facts.mergeability, mergeStateStatus: null },
      inMergeQueue: facts.inMergeQueue,
      local: null,
    },
  };
}
