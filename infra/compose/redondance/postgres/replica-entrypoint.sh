#!/bin/sh
# Démarrage d'une réplique PostgreSQL.
# Volume vide : copie complète de la base primaire (pg_basebackup), puis suivi en continu.
# Volume déjà rempli : redémarre simplement (en réplique, ou en primaire si elle a été promue).
set -eu
PGDATA=${PGDATA:-/var/lib/postgresql/data}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "==> réplique vide : copie initiale depuis $PRIMARY_HOST"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  until pg_isready -h "$PRIMARY_HOST" -q; do
    echo "    attente de $PRIMARY_HOST..."
    sleep 2
  done
  # -R écrit standby.signal et la connexion à la primaire : la base démarre en réplique.
  su-exec postgres env PGPASSWORD="$REPLICATION_PASSWORD" \
    pg_basebackup -h "$PRIMARY_HOST" -U replicator -D "$PGDATA" -X stream -R
  echo "==> copie initiale terminée"
fi

if [ -f "$PGDATA/standby.signal" ]; then
  echo "==> démarrage en réplique de $PRIMARY_HOST (lecture seule)"
  # Mot de passe lu à chaque démarrage (fichier .pgpass) plutôt que figé dans la copie initiale :
  # si le mot de passe de la base change dans le .env, la réplique suit au prochain redémarrage.
  pgpass=/var/lib/postgresql/.pgpass
  printf '*:*:*:replicator:%s\n' "$REPLICATION_PASSWORD" > "$pgpass"
  chown postgres:postgres "$pgpass"
  chmod 600 "$pgpass"
  exec su-exec postgres postgres -c hot_standby=on \
    -c "primary_conninfo=host=$PRIMARY_HOST port=5432 user=replicator passfile=$pgpass application_name=$PRIMARY_HOST-replica"
fi
echo "==> démarrage en PRIMAIRE (cette réplique a été promue)"
exec su-exec postgres postgres
