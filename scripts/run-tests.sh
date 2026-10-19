#!/usr/bin/env bash

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if compgen -G "services/*/package.json" >/dev/null || compgen -G "packages/*/package.json" >/dev/null; then
  npm test --workspaces --if-present
else
  echo "Aucun workspace, tests ignorés."
fi
