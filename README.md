# bb-plugin-pr-status

The pull request of the thread's branch, always in view in the thread header,
with the next step one click away — like Conductor.

## Install

```
bb plugin install git:https://github.com/chuck-durst/bb-plugin-pr-status.git@^0.1.0
```

Requires bb 0.45+, Plugin SDK 0.6.15+, and the GitHub CLI (`gh`) signed in on
the machine running bb.

## Use

**Thread header.** Without a PR, a **Create PR** button asks the agent to open
one (commit, push, title, description), targeting the environment's merge base
or the default branch. It is hidden on the default branch.

With a PR, a split button tinted by the PR's state: `#123` on the left opens
bb's own **GitHub PR** tab in the thread panel; the right half is the next
step.

| State | Tint | Right half |
| --- | --- | --- |
| Local work not on GitHub: uncommitted files or unpushed commits in the workspace (wins over every open state) | amber | **Commit and push** — prompt to commit the work and push the branch |
| Draft | gray | **Mark ready** — runs right away |
| Checks running | blue | `Checks running 2/5` (no action) |
| Checks failing | red | **Fix checks** — prompt with each failing check, its link and the tail of its failed log |
| Conflicts | orange | **Fix conflicts** — prompt to rebase on / merge the base and resolve |
| Changes requested | orange | **Address review** — prompt with the review bodies and unresolved review threads |
| Required review missing | yellow | `Review required` (no action) |
| Blocked by other branch rules | yellow | `Blocked` (no action) |
| Behind its base (branch rules require it up to date) | yellow | **Update branch** — `gh pr update-branch`, right away |
| In merge queue | blue | `In merge queue` (no action) |
| GitHub still computing mergeability | neutral | `Checking…` (re-read every 10 s) |
| Ready to merge: open, no conflict, nothing failing or running, no changes requested, mergeable — with or without checks | green | **Merge** — merges right away, no confirmation |
| Merged | purple | **Archive** the thread |
| Closed | gray | **Archive** the thread |

The state is derived from bb's raw PR facts (`lib/pr-state.ts`), not only from
bb's `attention`: bb only says `ready_to_merge` when checks *pass*, so a PR
without checks would otherwise stay gray, and its `blocked` mixes branch rules,
"behind base" and GitHub's HAS_HOOKS (mergeable).

GitHub only knows what was pushed, so on an open or draft PR the server also
reads the workspace (`git status --porcelain=v2 --branch`, commits ahead of the
upstream or `origin/<branch>`). Any uncommitted file or unpushed commit turns
the button to **Commit and push**: a green **Merge** would merge a PR without
that work. The server's merge refuses in that state too. On a workspace on
another machine, only uncommitted files are seen (bb's status).

Prompts go through the thread's composer and are sent as if typed (queued if
the agent is busy); a draft you were writing is put back afterwards. The
tooltip shows title, checks, review and branches. Right click: copy number,
copy link, open in browser, refresh.

**Merge** uses the repository's allowed method: your default
(`viewerDefaultMergeMethod`) when the repo allows it, else squash, merge or
rebase, whichever is allowed. The branch is not deleted.

**Sidebar.** Each thread row with a PR gets a glyph and an accessible label
(`PR #123 — Checks failing`).

| State | Glyph | Tone |
| --- | --- | --- |
| Ready to merge | `GitPullRequest` | success |
| Local work not pushed (once the header has read it) | `FileDiff` | default |
| Checks failing | `GitPullRequest` | error |
| Conflicts | `AlertTriangle` | error |
| Changes requested | `GitPullRequestArrow` | error |
| Checks running, merge queue | `GitPullRequest` | running |
| Review, blocked, behind, checking | `GitPullRequest` | default |
| Draft | `GitPullRequestDraft` | default |
| Merged | `GitMerge` | default |
| Closed | `GitPullRequestClosed` | default |

bb only lets a plugin pick an icon and one of four tones for a row, so the
sidebar cannot use the header's colors.

## With the Commands plugin

bb shows one status per row, and the first plugin to set one keeps it. A
running command (bb-plugin-commands) wins: Commands publishes the rows it
marks on `globalThis.__bbCommandsRunningThreads` and dispatches
`bb-commands:running-threads`. This plugin stays off those rows and puts its
PR glyph back when the command stops.

## Limits

- Opening bb's **GitHub PR** tab relies on bb internals: the SDK only lets a
  plugin open its own panels, so `#123` walks up React's tree to the thread
  view's own panel opener (`lib/github-panel.ts`). If a bb release changes
  that, it falls back to adding the tab through the public
  `sdk.threads.tabs` (tab added, not focused), then to the browser.
- The sidebar follows bb's own per-row PR data, refreshed every 30 s while
  checks run: it can lag the header by up to ~30 s.
- GitHub only (bb's PR lookup is GitHub-based). Failing-check logs are fetched
  for GitHub Actions jobs; other checks get their link only.
- `gh` runs on the bb server's machine. It is looked up in
  `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `PATH`.

## How it works

- `server.ts` — reads `sdk.environments.pullRequest` (bb caches it 10 s) for
  the threads the app shows, re-reads them every 30 s (checks running), 60 s
  (open), 2 min (no PR) or 5 min (merged/closed) while they were viewed in the
  last 10 minutes, and right after each agent turn. Publishes `pr-changed`
  when a snapshot changes, and re-reads 3 s and 10 s after an action (GitHub
lags). Builds the prompts and runs Mark ready / Update branch / Merge (bb's
merge, or `gh pr merge` for states bb's merge refuses, like HAS_HOOKS).
- `app.tsx` — the header button and its context menu; an invisible overlay
  mirrors bb's own per-row PR state (`experimental_useSidebarThreadPullRequest`,
  no extra GitHub calls) into row statuses through a content script.
- `lib/pr-state.ts` — the states, actions, labels and sidebar glyphs shared by
  both.

## Develop

```
npm install --include=dev
npm run typecheck && npm test
bb plugin build .
bb plugin install . --yes     # or: bb plugin dev .
```

`scripts/reset-playground.sh` puts the author's live test PRs (a private
playground repo) back in their target states — checks running, one check
failing, conflict, draft, no checks, ready — after testing has "fixed"
them. Idempotent; see its header for the targets and requirements.
