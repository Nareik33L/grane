#!/usr/bin/env bash
# Reproducible 60-second Grane demo. Prefer: npx grane-analytics demo
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v npx >/dev/null 2>&1; then
  exec npx tsx src/cli/index.ts demo "$@"
fi
exec node dist/cli/index.js demo "$@"
