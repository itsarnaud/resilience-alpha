#!/bin/sh
# Crée (ou met à jour) le compte "replicator" sur chaque base primaire.
# Idempotent : fonctionne sur des bases neuves comme sur des bases déjà remplies.
# Mot de passe du compte = celui de la base (DB_xxx_PASSWORD), pour ne rien ajouter au .env.
set -eu

setup() {
  host=$1 user=$2 pass=$3 db=$4
  echo "==> $host : compte de réplication"
  PGPASSWORD="$pass" psql -h "$host" -U "$user" -d "$db" -v ON_ERROR_STOP=1 -q \
    -v repl_pass="$pass" <<'SQL'
SELECT format('%s ROLE replicator WITH REPLICATION LOGIN PASSWORD %L',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator')
                   THEN 'ALTER' ELSE 'CREATE' END,
              :'repl_pass') \gexec
SQL
}

setup db-auth        "$DB_AUTH_USER"        "$DB_AUTH_PASSWORD"        "$DB_AUTH_NAME"
setup db-paiement    "$DB_PAIEMENT_USER"    "$DB_PAIEMENT_PASSWORD"    "$DB_PAIEMENT_NAME"
setup db-remediation "$DB_REMEDIATION_USER" "$DB_REMEDIATION_PASSWORD" "$DB_REMEDIATION_NAME"
echo "==> comptes de réplication prêts"
