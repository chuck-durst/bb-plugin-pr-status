---
name: pr-status
description: How the PR Status plugin shows and acts on the pull request of a thread's branch (header button, sidebar glyph, Fix checks / Fix conflicts / Address review prompts, direct Merge). Use when the user asks about the PR button, its colors or actions, or why it shows a given state.
---

# PR Status

The PR Status plugin shows the pull request of the thread's branch in the
thread header and on the thread's sidebar row. Its state comes from bb's
GitHub lookup for the thread's environment (`gh pr view` on the branch).

## Header button

- No PR on a feature branch: **Create PR** sends the agent a prompt to commit,
  push and open a PR against the environment's merge base (or the default
  branch). Hidden on the default branch and outside git workspaces.
- With a PR: `#<number>` opens bb's **GitHub PR** tab in the thread panel
  (falls back to the browser); the right half is the next step.
  - Draft → **Mark ready** (`gh pr ready`, no prompt).
  - Checks failing → **Fix checks**: a prompt listing each failing check, its
    link and the tail of its failed GitHub Actions log.
  - Conflicts → **Fix conflicts**: a prompt to rebase on or merge the base and
    resolve.
  - Changes requested → **Address review**: a prompt with the review bodies and
    unresolved review threads (`path:line`, author, comment).
  - Behind its base (branch rules require it) → **Update branch**
    (`gh pr update-branch`, no prompt). Pull afterwards in the workspace.
  - Ready to merge (open, no conflict, nothing failing or running, no
    changes requested, mergeable — checks or not) → **Merge**, immediately,
    with the repo's allowed method (the viewer's default if allowed, else
    squash, merge, rebase). The branch is kept.
  - Merged or closed → **Archive** the thread.
  - Checks running, review required, other branch rules, merge queue,
    mergeability still being computed → a label, no action.
- Right click: copy number, copy link, open in browser, refresh status.

When you receive one of these prompts, the data in it was fetched just before
sending. Re-check with `gh pr checks <number>` or `gh pr view <number>
--comments` if you need more than the excerpt.

## Inspect from the CLI

```sh
echo '{"threadId":"<thread-id>"}' > /tmp/in.json
bb plugin rpc call pr-status pr_get --input-file /tmp/in.json --json
```

Add `"force": true` to bypass the 15 s cache. `outcome` is `pr`, `none` (no PR;
`canCreate` says whether Create PR shows) or `unavailable` (no workspace, not
GitHub, `gh` not signed in — `message` says which).

## Constraints

- Needs `gh` signed in on the machine running bb.
- The sidebar glyph only has bb's four tones (default, error, running,
  success); the colors live in the header button.
- When the Commands plugin runs a command in a thread, its indicator wins the
  sidebar row; the PR glyph returns when the command stops.
