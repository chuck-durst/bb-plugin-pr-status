#!/usr/bin/env bash
# Reset the PR Status test playground (chuck-durst/anamnese) so each test PR
# shows its intended state again. Testing the plugin "repairs" them (Fix
# checks, Fix conflicts, Mark ready, slow checks finishing); run this to put
# them back. Idempotent: a PR already in its target state is left alone.
#
# Usage:
#   scripts/reset-playground.sh            # reset every test PR
#   scripts/reset-playground.sh 11 13      # only these PR numbers
#
# Targets (all PRs target `pr-status-playground`, never `main`):
#   #10 pr-test/no-checks  only touches pr-status/no-checks/ → no checks at all
#   #11 pr-test/running    ci.json build=slow; re-runs CI → checks running ~10 min
#   #12 pr-test/failing    ci.json test=fail → 1 of 3 checks failing
#   #13 pr-test/conflict   edits the line the base also edited → conflict
#   #14 pr-test/draft      draft
#   #16 (Create PR test)   ready: not a draft
#
# Needs: gh signed in, git >= 2.38, jq, and the worktrees created for the
# playground (one per branch) under $PLAYGROUND_DIR. Refuses to touch a
# worktree with local changes. Pushes only pr-test/* branches.
set -euo pipefail

REPO="${REPO:-chuck-durst/anamnese}"
BASE="pr-status-playground"
PLAYGROUND_DIR="${PLAYGROUND_DIR:-$HOME/Work/projects/anamnese/pr-status-playground}"
ONLY=("$@")

log() { printf '  %s\n' "$*"; }
want() { [ ${#ONLY[@]} -eq 0 ] || [[ " ${ONLY[*]} " == *" $1 "* ]]; }

# A clean worktree of pr-test/<name>, synced to its remote branch.
worktree() {
  local name=$1 dir="$PLAYGROUND_DIR/$1"
  [ -d "$dir" ] || { echo "missing worktree $dir" >&2; exit 1; }
  [ -z "$(git -C "$dir" status --porcelain)" ] || { echo "$dir has local changes; aborting" >&2; exit 1; }
  [ "$(git -C "$dir" branch --show-current)" = "pr-test/$name" ] || { echo "$dir is not on pr-test/$name" >&2; exit 1; }
  git -C "$dir" fetch -q origin "$BASE" "pr-test/$name"
  git -C "$dir" reset -q --hard "origin/pr-test/$name"
  echo "$dir"
}

push() { # dir name [--force]
  local dir=$1 name=$2
  case "$name" in main | "$BASE") echo "refusing to push $name" >&2; exit 1 ;; esac
  if [ "${3:-}" = "--force" ]; then
    git -C "$dir" push -q --force-with-lease origin "pr-test/$name"
  else
    git -C "$dir" push -q origin "pr-test/$name"
  fi
}

# Make pr-status/ci.json on pr-test/<name> say $2; prints "changed" or "same".
set_ci() {
  local name=$1 json=$2 dir
  dir=$(worktree "$name")
  if [ "$(jq -cS . "$dir/pr-status/ci.json")" = "$(jq -cS . <<<"$json")" ]; then
    echo same
    return
  fi
  jq . <<<"$json" >"$dir/pr-status/ci.json"
  git -C "$dir" commit -qam "test: reset ci.json for the PR Status playground"
  push "$dir" "$name"
  echo changed
}

latest_run() { # branch → "<id> <status>"
  gh run list -R "$REPO" -b "$1" -L 1 --json databaseId,status -q '.[0] | "\(.databaseId) \(.status)"'
}

if want 10; then
  echo "#10 no checks"
  dir=$(worktree no-checks)
  extra=$(git -C "$dir" diff --name-only "origin/$BASE...HEAD" | grep -v '^pr-status/no-checks/' || true)
  if [ -n "$extra" ]; then
    git -C "$dir" reset -q --hard "origin/$BASE"
    mkdir -p "$dir/pr-status/no-checks" && echo "no checks" >"$dir/pr-status/no-checks/note.md"
    git -C "$dir" add -A && git -C "$dir" commit -qm "test: Ready without checks"
    push "$dir" no-checks --force
    log "branch rebuilt to touch only pr-status/no-checks/"
  else
    log "ok"
  fi
fi

if want 11; then
  echo "#11 checks running"
  result=$(set_ci running '{ "lint": "pass", "test": "pass", "build": "slow" }')
  if [ "$result" = changed ]; then
    log "ci.json set to slow (push starts a run)"
  else
    read -r run status <<<"$(latest_run pr-test/running)"
    if [ "$status" = "completed" ]; then
      gh run rerun "$run" -R "$REPO" && log "re-ran run $run"
    else
      log "ok (run $run $status)"
    fi
  fi
fi

if want 12; then
  echo "#12 one check failing"
  result=$(set_ci failing '{ "lint": "pass", "test": "fail", "build": "pass" }')
  if [ "$result" = changed ]; then
    log "ci.json set to fail test"
  else
    log "ok"
  fi
fi

if want 13; then
  echo "#13 conflict"
  dir=$(worktree conflict)
  if git -C "$dir" merge-tree --write-tree "origin/$BASE" HEAD >/dev/null 2>&1; then
    # Restart from the playground commit that created conflict.md and edit
    # the line the base edited since.
    anchor=$(git -C "$dir" log --format=%H --diff-filter=A "origin/$BASE" -- pr-status/conflict.md | tail -1)
    base_line=$(git -C "$dir" show "origin/$BASE:pr-status/conflict.md" | sed -n 2p)
    anchor_line=$(git -C "$dir" show "$anchor:pr-status/conflict.md" | sed -n 2p)
    [ "$base_line" != "$anchor_line" ] || { echo "the base no longer edits conflict.md; nothing to conflict with" >&2; exit 1; }
    git -C "$dir" reset -q --hard "$anchor"
    printf 'Shared line edited by both the base and pr-test/conflict.\nbranch: conflicting edit\n' >"$dir/pr-status/conflict.md"
    git -C "$dir" commit -qam "test: Conflict with base"
    push "$dir" conflict --force
    log "branch rebuilt to conflict with $BASE"
  else
    log "ok"
  fi
fi

if want 14; then
  echo "#14 draft"
  if [ "$(gh pr view 14 -R "$REPO" --json isDraft -q .isDraft)" = "true" ]; then
    log "ok"
  else
    gh pr ready 14 -R "$REPO" --undo >/dev/null && log "back to draft"
  fi
fi

if want 16; then
  echo "#16 ready"
  if [ "$(gh pr view 16 -R "$REPO" --json isDraft -q .isDraft)" = "true" ]; then
    gh pr ready 16 -R "$REPO" >/dev/null && log "marked ready"
  else
    log "ok"
  fi
fi

echo
echo "State on GitHub (mergeability and checks can take a minute to settle):"
for n in 10 11 12 13 14 16; do
  want "$n" || continue
  gh pr view "$n" -R "$REPO" --json number,state,isDraft,mergeable,headRefName \
    -q '"  #\(.number) \(.headRefName): \(.state) draft=\(.isDraft) mergeable=\(.mergeable)"'
done
