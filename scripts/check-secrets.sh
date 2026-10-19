#!/usr/bin/env bash

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

files=$(git ls-files --cached --others --exclude-standard)
fail=0

# 1. fichiers sensibles par nom
bad=$(echo "$files" | grep -E '(^|/)(\.env|.*\.pem|.*\.key|keys\.txt|.*\.agekey|vault-keys\.json)$' || true)
if [ -n "$bad" ]; then echo "Fichiers sensibles :"; echo "$bad"; fail=1; fi

# 2. motifs de secrets dans le contenu (hors .env.example et fichiers SOPS chiffrés)
pat='(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AGE-SECRET-KEY-|AKIA[0-9A-Z]{16}|(password|passwd|secret|token|api_key)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_-]{12,})'
hits=$(echo "$files" | grep -vE '(\.enc\.ya?ml|\.env\.example|check-secrets\.sh|\.gitkeep)$' \
  | xargs -I{} grep -InE "$pat" {} 2>/dev/null || true)
if [ -n "$hits" ]; then echo "Motifs suspects :"; echo "$hits"; fail=1; fi

# 3. fichiers *.enc.yaml réellement chiffrés ?
for f in $(echo "$files" | grep -E '\.enc\.ya?ml$' || true); do
  grep -q '^sops:' "$f" || { echo "Non chiffré par SOPS : $f"; fail=1; }
done

[ $fail -eq 0 ] && echo "OK : aucun secret en clair détecté." || exit 1
