#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x "${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE_BIN="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo "Unable to publish: Node.js was not found in PATH or the Codex bundled runtime." >&2
  exit 1
fi

"${NODE_BIN}" "${ARCHIVE_DIR}/scripts/update-archive.mjs"

git -C "${ARCHIVE_DIR}" add .

if git -C "${ARCHIVE_DIR}" diff --cached --quiet; then
  echo "Archive already up to date; nothing to publish."
  exit 0
fi

brief_date="$(date +%F)"
git -C "${ARCHIVE_DIR}" commit -m "Update brief archive ${brief_date}"
git -C "${ARCHIVE_DIR}" push

echo "Published $(git -C "${ARCHIVE_DIR}" rev-parse --short HEAD) to $(git -C "${ARCHIVE_DIR}" remote get-url origin)"
