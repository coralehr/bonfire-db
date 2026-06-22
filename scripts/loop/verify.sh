#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "verify: $*" >&2
  exit 1
}

missing_scaffold() {
  echo "verify: Bonfire app scaffold is not present yet." >&2
  echo "verify: expected package.json, bun.lock, docker-compose.yml, and required scripts." >&2
  echo "verify: this is expected only for the harness-skeleton slice." >&2
  exit 78
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_script() {
  local script="$1"
  node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts['$script'] ? 0 : 1)" \
    || fail "package.json missing required script: $script"
}

[[ -f package.json ]] || missing_scaffold
[[ -f bun.lock ]] || fail "missing bun.lock; run bun install and commit the lockfile"
[[ -f docker-compose.yml ]] || fail "missing docker-compose.yml"

require_cmd bun
require_cmd node
require_cmd docker

echo "verify: task registry"
node scripts/loop/task.mjs validate

echo "verify: harness syntax"
bash -n scripts/loop/*.sh
node --check scripts/loop/*.mjs

echo "verify: harness tests"
node --test scripts/loop/*.test.mjs

for script in typecheck lint test smoke:demo smoke:offline scan:synthetic-only; do
  require_script "$script"
done

cleanup() {
  docker compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "verify: installing dependencies"
bun install --frozen-lockfile

echo "verify: typecheck"
bun run typecheck

echo "verify: lint"
bun run lint

echo "verify: unit tests"
bun test

echo "verify: package test script"
bun run test

echo "verify: docker build"
docker compose build

echo "verify: docker boot"
docker compose up -d

echo "verify: demo smoke"
bun run smoke:demo

echo "verify: offline runtime smoke"
bun run smoke:offline

echo "verify: synthetic-only scan"
bun run scan:synthetic-only

echo "verify: PASS"
