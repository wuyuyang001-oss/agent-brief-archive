#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

node "${ARCHIVE_DIR}/scripts/update-archive.mjs"

git -C "${ARCHIVE_DIR}" add .

if git -C "${ARCHIVE_DIR}" diff --cached --quiet; then
  echo "Archive already up to date; nothing to publish."
  exit 0
fi

brief_date="$(date +%F)"
git -C "${ARCHIVE_DIR}" commit -m "Update brief archive ${brief_date}"
git -C "${ARCHIVE_DIR}" push
