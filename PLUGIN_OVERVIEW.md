See the pull request of every thread's branch at a glance, and take the next
step in one click.

## What you get

- A button in the thread header, tinted by the PR's state: green when it is
  ready to merge, red when checks fail, orange on conflicts or requested
  changes, purple once merged.
- One click for the next step: create the PR, mark it ready, merge it, or ask
  the agent to fix failing checks, resolve conflicts or address the review,
  with the failing logs and review comments already in the prompt.
- A PR indicator on each thread in the sidebar. A command running in the
  Commands plugin takes precedence on the row.

## How it works

The PR state comes from bb's own GitHub integration. The GitHub CLI fetches
what bb does not show (failing check logs, unresolved review comments, the
repository's merge method). Merges use the method the repository allows.
