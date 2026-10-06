# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/chuck-durst/bb-plugin-pr-status/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/chuck-durst/bb-plugin-pr-status/releases/tag/v0.1.0
