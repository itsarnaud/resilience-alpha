#!/usr/bin/env bash
# PostgreSQL local de développement, partagé par tous les services (un seul conteneur, une base
# de dev et une base de test par service). Utilisé par `npm run db:up|db:init|db:down` à la racine.
set -euo pipefail

NAME=dev-db
PORT=54329
DATABASES="auth_dev auth_test payments_dev payments_test remediation_dev remediation_test"

case "${1:-}" in
  up)
    if docker start "$NAME" >/dev/null 2>&1; then
      echo "conteneur $NAME démarré"
    else
      docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -p "$PORT:5432" postgres:16-alpine >/dev/null
      echo "conteneur $NAME créé : lancer ensuite 'npm run db:init'"
    fi
    ;;
  init)
    until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
    for db in $DATABASES; do
      docker exec "$NAME" psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
        || docker exec "$NAME" psql -U postgres -c "CREATE DATABASE $db" >/dev/null
      echo "base $db prête"
    done
    ;;
  down)
    docker rm -f "$NAME" >/dev/null && echo "conteneur $NAME supprimé (données comprises)"
    ;;
  *)
    echo "usage : $0 up|init|down" >&2
    exit 1
    ;;
esac
