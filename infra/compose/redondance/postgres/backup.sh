#!/bin/sh
# Sauvegarde régulière des 3 bases (pg_dump, format compressé), avec rotation.
# Restauration : voir README-redondance.md.
set -eu
INTERVAL=${BACKUP_INTERVAL_SECONDS:-3600}
KEEP=${BACKUP_KEEP:-24}

dump() {
  name=$1 host=$2 user=$3 pass=$4 db=$5
  dir="/backups/$name"
  mkdir -p "$dir"
  file="$dir/$name-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if PGPASSWORD="$pass" pg_dump -h "$host" -U "$user" -d "$db" -Fc -f "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "sauvegarde OK : $file"
  else
    rm -f "$file.tmp"
    echo "sauvegarde EN ÉCHEC : $name ($host)" >&2
  fi
  # On garde les $KEEP plus récentes
  ls -1t "$dir"/*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
}

while true; do
  dump auth        db-auth        "$DB_AUTH_USER"        "$DB_AUTH_PASSWORD"        "$DB_AUTH_NAME"
  dump paiement    db-paiement    "$DB_PAIEMENT_USER"    "$DB_PAIEMENT_PASSWORD"    "$DB_PAIEMENT_NAME"
  dump remediation db-remediation "$DB_REMEDIATION_USER" "$DB_REMEDIATION_PASSWORD" "$DB_REMEDIATION_NAME"
  sleep "$INTERVAL"
done
