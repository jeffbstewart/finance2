#!/usr/bin/env bash
# Source this in any shell that runs the web lanes:
#     . scripts/cloud-env.sh
# Ensures Node >= MIN_NODE is first on PATH. Angular CLI 22 refuses
# older Nodes (ng exits 3), some sandbox images ship one, and they
# carry no version manager — so when needed this fetches a pinned
# Node tarball from nodejs.org (reachable through the sandbox proxy,
# unlike Chromium's CDN) into $HOME/.finance2-tooling. Idempotent;
# safe to source repeatedly; works in git worktrees.
MIN_NODE="22.22.3"
PIN_NODE="24.15.0"
TOOLING="${FINANCE2_TOOLING:-$HOME/.finance2-tooling}"

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(printf '%s\n%s\n' "$MIN_NODE" "$(node --version | sed 's/^v//')" | sort -V | head -1)" = "$MIN_NODE" ]
}

if [ -x "$TOOLING/node/bin/node" ]; then
  export PATH="$TOOLING/node/bin:$PATH"
fi

if ! node_version_ok; then
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
  esac
  url="https://nodejs.org/dist/v$PIN_NODE/node-v$PIN_NODE-$os-$arch.tar.gz"
  echo ">> node $(node --version 2>/dev/null || echo missing) is below $MIN_NODE — fetching Node $PIN_NODE from nodejs.org"
  rm -rf "$TOOLING/node" "$TOOLING/node.tmp"
  mkdir -p "$TOOLING/node.tmp"
  if curl -fsSL "$url" | tar -xz -C "$TOOLING/node.tmp" --strip-components=1; then
    mv "$TOOLING/node.tmp" "$TOOLING/node"
    export PATH="$TOOLING/node/bin:$PATH"
  else
    echo "!! could not fetch $url" >&2
    rm -rf "$TOOLING/node.tmp"
  fi
fi

if node_version_ok; then
  echo ">> node $(node --version) ($(command -v node))"
else
  echo "!! Node >= $MIN_NODE required (have $(node --version 2>/dev/null || echo none)) — install Node 24 manually" >&2
  return 1 2>/dev/null || exit 1
fi
