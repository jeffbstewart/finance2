#!/usr/bin/env bash
# Environment bootstrap for cloud/CI workers on a fresh finance2
# clone (docs/design/ui-testing.md). Idempotent. The Gradle build is
# a composite that expects the (public) toolkit repos checked out
# BESIDE this repo - without them, ./gradlew cannot even configure.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
# settings.gradle.kts includes the siblings as "../<name>" relative to
# THIS checkout, so they must exist beside it - even for a git
# worktree under .claude/worktrees/. In the worktree case the main
# checkout's siblings are symlinked in rather than re-cloned.
parent="$(dirname "$repo_root")"
main_repo="$(cd "$repo_root" && git rev-parse --git-common-dir 2>/dev/null | xargs -I{} sh -c 'cd "{}/.." && pwd' || echo "$repo_root")"
main_parent="$(dirname "$main_repo")"

fail() { echo "!! $*" >&2; echo "!! cloud-setup FAILED"; exit 1; }

echo ">> toolchain check (needed before anything else)"
java -version 2>&1 | head -1 || fail "JDK 21+ required on PATH (CI uses corretto 25)"

# Node: Angular CLI 22 needs >= 22.22.3; provisioned by the sourceable
# helper every worker shell must also source before running the lanes.
# shellcheck disable=SC1091
. "$repo_root/scripts/cloud-env.sh" || fail "Node provisioning failed"

for sibling in armeria-kotlin-toolkit h2-kotlin-toolkit auth-kotlin-toolkit; do
  if [ -d "$parent/$sibling" ]; then
    continue
  elif [ "$main_parent" != "$parent" ] && [ -d "$main_parent/$sibling" ]       && ln -s "$main_parent/$sibling" "$parent/$sibling" 2>/dev/null; then
    echo ">> linked $sibling from the main checkout's siblings"
  else
    echo ">> cloning $sibling beside the repo"
    git clone --depth 1 "https://github.com/jeffbstewart/$sibling.git" "$parent/$sibling"
  fi
done

echo ">> web-app dependencies"
(cd "$repo_root/web-app" && npm ci) || fail "npm ci failed"

echo ">> playwright browser (best effort - the e2e lane needs it;"
echo ">> without it, validate specs with 'npm run e2e:typecheck')"
if (cd "$repo_root/web-app" && npx playwright install chromium); then
  echo ">> chromium ready: the full e2e lane (npm run e2e) is available"
else
  echo ">> chromium NOT installed: use npm run e2e:typecheck as your e2e rung"
fi

echo ">> server build + tests (also generates Kotlin proto stubs)"
(cd "$repo_root" && ./gradlew build --no-daemon) || fail "gradle build failed"

echo ">> TS client + SPA build (the e2e server serves spa/)"
(cd "$repo_root/web-app" && npm run check) || fail "npm run check (TS client + SPA build) failed"

echo ">> cloud-setup OK. Lanes: npm test -- --no-watch | npm run e2e | npm run e2e:typecheck"
