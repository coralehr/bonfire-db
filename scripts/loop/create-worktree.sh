#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

slug_raw="${1:-task}"
base="${2:-main}"
slug="$(printf '%s' "$slug_raw" | tr -c 'a-zA-Z0-9' '-' | sed 's/--*/-/g; s/^-//; s/-$//')"
uniq="${slug:-task}-$(date +%Y%m%d-%H%M%S)"
dir="$(dirname "$ROOT")/bonfire-db-$uniq"
branch="loop/$uniq"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "create-worktree: $ROOT is not a git repository" >&2
  exit 1
}

git rev-parse --verify HEAD >/dev/null 2>&1 || {
  echo "create-worktree: repository has no commits yet; commit the harness skeleton first" >&2
  exit 1
}

if git remote get-url origin >/dev/null 2>&1; then
  echo "create-worktree: fetching origin/$base"
  git fetch --quiet origin "$base" || true
fi

if git rev-parse --verify "origin/$base" >/dev/null 2>&1; then
  start_ref="origin/$base"
else
  start_ref="$base"
fi

echo "create-worktree: creating $dir on $branch from $start_ref"
git worktree add -b "$branch" "$dir" "$start_ref"

if [[ -d node_modules && ! -e "$dir/node_modules" ]]; then
  ln -s "$ROOT/node_modules" "$dir/node_modules"
  echo "create-worktree: linked node_modules"
fi

cat <<EOF
worktree ready:
  path:   $dir
  branch: $branch
  verify: cd "$dir" && scripts/loop/verify.sh
EOF
