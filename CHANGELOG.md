# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-12

### Added

- A **Display** setting (`bb plugin config pr-status set display <value>`):
  - `auto` (default): the plugin's own tinted split button while bb accepts
    it (bb 0.49 still does), else bb's shared header button;
  - `plugin`: always the plugin's own button;
  - `bb`: bb's shared header button (bb 0.49+), one button
    `#123 · <next step>` with Open PR, Copy PR link and Refresh PR status in
    its menu, without tint. bb's Commit comes first when it shows.

  A forced value bb does not offer falls back to the other one, and the
  plugin log says so.

### Changed

- The sidebar reads PRs from GitHub PR Status on bb 0.49 (one batched read for
  every listed row), and from bb's per-row hook before.
- The plugin picks the API when it loads, from what the running bb provides.
  The minimum bb version is unchanged (0.45).

### Fixed

- bb 0.49: the header button showed for a moment, then disappeared. bb 0.49
  removed `environments.pullRequest`, `markPullRequestReady` and
  `mergePullRequest` from the plugin SDK, so every PR read failed and the
  header had nothing to show. On bb 0.49 the plugin now reads and acts on the
  PR through the bundled GitHub PR Status plugin, and reads the workspace
  through the bundled Git plugin.
- bb 0.49: no more retirement warnings in the plugin log.
- A PR pushed under another branch name than the local one
  (`git push -u origin HEAD:feature/x`) now shows: bb only looks the PR up by
  the local name, so the server asks `gh` for the upstream branch's PR.

## [0.1.2] - 2026-10-06

### Fixed

- The prompts sent to the agent (Create PR, Commit and push, Fix checks, Fix
  conflicts, Address review) are now in English, like the rest of the plugin.

## [0.1.1] - 2026-10-06

### Added

- A **Local changes not pushed** state (amber, `FileDiff` glyph): on an open or
  draft PR, uncommitted files or commits not pushed to the PR's branch take
  precedence over every other open state. The button offers **Commit and
  push**, which asks the agent to commit the work and push the branch. The
  tooltip lists how many files and commits are pending.
- The sidebar row shows the same state once the header has read it.

### Changed

- **Merge** is refused while the workspace has work not on GitHub: the PR's
  state on GitHub does not include it, so a green Merge would leave it behind.

## [0.1.0] - 2026-10-04

### Added

- First release: the thread's PR in the header, tinted by state, with the next
  step one click away (Create PR, Mark ready, Fix checks, Fix conflicts,
  Address review, Update branch, Merge, Archive), and a PR glyph on each
  sidebar row.

[0.1.3]: https://github.com/chuck-durst/bb-plugin-pr-status/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/chuck-durst/bb-plugin-pr-status/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/chuck-durst/bb-plugin-pr-status/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/chuck-durst/bb-plugin-pr-status/releases/tag/v0.1.0
