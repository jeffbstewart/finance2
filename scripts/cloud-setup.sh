#!/usr/bin/env bash
# Environment bootstrap for cloud/CI workers on a fresh finance2
# clone (docs/design/ui-testing.md). Idempotent. The Gradle build is
# a composite that expects the (public) toolkit repos checked out
# BESIDE this repo — without them, ./gradlew cannot even configure.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
parent="$(dirname "$repo_root")"

for sibling in armeria-kotlin-toolkit h2-kotlin-toolkit auth-kotlin-toolkit; do
  if [ ! -d "$parent/$sibling" ]; then
    echo ">> cloning $sibling beside the repo"
    git clone --depth 1 "https://github.com/jeffbstewart/$sibling.git" "$parent/$sibling"
  fi
done

echo ">> toolchain check"
java -version 2>&1 | head -1 || { echo "JDK 21+ required (CI uses corretto 25)"; exit 1; }
node --version || { echo "Node 22 required"; exit 1; }

echo ">> web-app dependencies"
(cd "$repo_root/web-app" && npm ci)

echo ">> playwright browser (best effort — the e2e lane needs it;"
echo ">> without it, validate specs with 'npm run e2e:typecheck')"
(cd "$repo_root/web-app" && npx playwright install chromium) || true

echo ">> server build + tests (also generates Kotlin proto stubs)"
(cd "$repo_root" && ./gradlew build --no-daemon)

echo ">> TS client + SPA build (the e2e server serves spa/)"
(cd "$repo_root/web-app" && npm run check)

echo ">> done. Lanes: npm test -- --no-watch | npm run e2e | npm run e2e:typecheck"
