#!/usr/bin/env bash
# Vérifie qu'aucun secret évident n'est présent dans le dépôt.
#   scripts/check-secrets.sh            tous les fichiers suivis ou à suivre (avant le ZIP de rendu)
#   scripts/check-secrets.sh --staged   seulement les fichiers indexés (hook pre-commit)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "${1:-}" = "--staged" ]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR)
else
  files=$(git ls-files --cached --others --exclude-standard)
fi
[ -z "$files" ] && { echo "OK : rien à vérifier."; exit 0; }
fail=0

# 1. fichiers sensibles par nom (.env.example autorisé)
bad=$(echo "$files" | grep -E '(^|/)(\.env|\.env\.[^/]*|[^/]*\.pem|[^/]*\.key|keys\.txt|[^/]*\.agekey|vault-keys\.json)$' | grep -v '\.env\.example$' || true)
if [ -n "$bad" ]; then echo "Fichiers sensibles :"; echo "$bad"; fail=1; fi

# 2. motifs de secrets dans le contenu (hors exemples, fichiers SOPS chiffrés, ce script)
pat='(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AGE-SECRET-KEY-|AKIA[0-9A-Z]{16}|(password|passwd|secret|token|api_key)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_-]{12,})'
hits=$(echo "$files" | grep -vE '(\.enc\.ya?ml|\.env\.example|check-secrets\.sh|\.gitkeep|package-lock\.json)$' \
  | while read -r f; do [ -f "$f" ] && grep -InE "$pat" "$f" | sed "s#^#$f:#" || true; done)
if [ -n "$hits" ]; then echo "Motifs suspects :"; echo "$hits"; fail=1; fi

# 3. fichiers *.enc.yaml réellement chiffrés ?
for f in $(echo "$files" | grep -E '\.enc\.ya?ml$' || true); do
  [ -f "$f" ] && ! grep -q '^sops:' "$f" && { echo "Non chiffré par SOPS : $f"; fail=1; }
done

if [ $fail -eq 0 ]; then echo "OK : aucun secret en clair détecté."; else exit 1; fi
