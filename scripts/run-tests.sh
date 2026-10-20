#!/usr/bin/env bash

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# packages/shared est utilisé compilé (dist/, ignoré par git). Après un clone, ou si dist/ a été
# supprimé, les services ne peuvent pas l'importer : on le compile avant de lancer les tests.
if [ ! -f packages/shared/dist/index.js ]; then
  echo "packages/shared n'est pas compilé : compilation..."
  npm run build -w packages/shared
fi

if compgen -G "services/*/package.json" >/dev/null || compgen -G "packages/*/package.json" >/dev/null; then
  npm test --workspaces --if-present
else
  echo "Aucun workspace, tests ignorés."
fi
