# Redondance de l'infrastructure

Objectif : qu'une panne d'un conteneur applicatif ou d'une base de données n'arrête pas la plateforme, et qu'on puisse revenir en arrière en cas de perte de données.

Tout est **ajouté à côté** des fichiers existants, sans les modifier : deux fichiers compose se superposent aux piles dev et infra. Sans eux, la plateforme tourne exactement comme avant.

| Fichier | Rôle |
|---|---|
| `docker-compose.dev.redondance.yml` | 2e instance des services, répliques PostgreSQL, sauvegardes |
| `docker-compose.infra.redondance.yml` | Proxy Docker dédié à la bascule des bases, accès d'Ansible à ce proxy |
| `redondance/postgres/` | `pg_hba.conf` des primaires, scripts de réplique, d'initialisation et de sauvegarde |
| `redondance/backups/` | Sauvegardes produites (ignorées par Git) |
| `ansible/playbooks/bascule-db.yml` | Playbook de bascule d'une base sur sa réplique |

## Ce qui est redondé

### Niveau 1 : les services applicatifs

| Service | Instances | Comment le trafic est réparti |
|---|---|---|
| `auth` | `auth`, `auth-2` | alias réseau `auth` |
| `api` | `api`, `api-2` | alias réseau `api` |
| `front`, `dashboard`, `backoffice` | `xxx`, `xxx-2` | alias réseau du service |

La 2e instance est une copie exacte de la première (même image, même configuration), qui porte le **même nom réseau**. Le DNS de Docker renvoie alors les deux adresses : le WAF et les autres services répartissent leurs requêtes entre les deux, et si une instance tombe, le trafic continue sur l'autre.

Ces services peuvent être doublés parce qu'ils ne gardent rien en mémoire : sessions, verrouillages et comptes sont dans leur base PostgreSQL, partagée par les deux instances.

**Pas doublés, volontairement :**

- `remediation` : un seul moteur doit agir à la fois (sinon deux blocages ou deux redémarrages pour un même incident). Il reprend ses incidents en cours au redémarrage, grâce à sa base.
- `face` et `detector` : leurs données sont dans un fichier local (visages, SQLite), qu'on ne peut pas partager entre deux instances.
- `assistant` : dépend d'Ollama sur l'hôte, qui n'est pas redondé.
- Le WAF : c'est le point d'entrée unique. Le doubler n'a de sens qu'avec une adresse IP virtuelle (keepalived) partagée entre deux machines, impossible sur un seul PC Hôte.

### Niveau 2 : les bases de données

| Base primaire | Réplique |
|---|---|
| `db-auth` | `db-auth-replica` |
| `db-paiement` | `db-paiement-replica` |
| `db-remediation` | `db-remediation-replica` |

- Chaque réplique reçoit en continu les modifications de sa primaire (*streaming replication* PostgreSQL). Elle est en lecture seule tant qu'on ne la promeut pas.
- Perte de données en cas de panne de la primaire : quasi nulle (quelques millisecondes de retard).
- La bascule n'est **pas automatique** : elle se fait par le playbook Ansible. Une bascule automatique demande un gestionnaire de cluster (Patroni + etcd), trop lourd pour le PC Hôte et source de « double primaire » mal maîtrisé.

Les seuls changements appliqués aux bases existantes : un `pg_hba.conf` qui autorise la réplication pour le compte `replicator`, et `wal_keep_size=256MB` pour qu'une réplique arrêtée un moment puisse rattraper son retard.

Le compte `replicator` de chaque base a **le même mot de passe que la base** (`DB_AUTH_PASSWORD`, `DB_PAIEMENT_PASSWORD`, `DB_REMEDIATION_PASSWORD`) : rien à ajouter au `.env`. Si un mot de passe change dans le `.env`, relancer la pile dev suffit : le compte et la réplique sont mis à jour au démarrage.

### Sauvegardes

Le service `db-backup` fait un `pg_dump` des 3 bases toutes les heures, dans `redondance/backups/<base>/`, et garde les 24 dernières.

La réplique ne remplace pas la sauvegarde : un `DELETE` par erreur (ou une attaque) est recopié sur la réplique en quelques millisecondes. Seule une sauvegarde permet de revenir à l'état d'avant.

## Lancer la plateforme avec la redondance

1. Aucune variable à ajouter au `.env`. Facultatif : `BACKUP_INTERVAL_SECONDS` (défaut `3600`) et `BACKUP_KEEP` (défaut `24`).
2. Lancer les piles dans le même ordre qu'habituellement, en ajoutant les fichiers de redondance :
   ```bash
   docker compose -f docker-compose.infra.yml -f docker-compose.infra.redondance.yml up -d
   ```
   ```bash
   docker compose -f docker-compose.dev.yml -f docker-compose.dev.redondance.yml up -d
   ```
   ```bash
   docker compose -f docker-compose.cyber.yml up -d
   ```

Au premier lancement, chaque réplique copie entièrement sa primaire, puis la suit en continu. Cela marche aussi sur des bases déjà remplies.

**Ressources** : environ 230 Mo de RAM en plus, mesurés (dont ~130 Mo pour `auth-2` et `api-2`, ~70 Mo pour les 3 répliques).

## Vérifier que la redondance fonctionne

**Les répliques suivent bien leur primaire** (une ligne `streaming` par base) :

```bash
docker exec db-paiement psql -U api_user -d payments -c "select client_addr, state, replay_lag from pg_stat_replication;"
```

**Une instance applicative peut tomber sans coupure** :

```bash
docker stop api
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/readyz
```

La réponse reste `200` (servie par `api-2`). Puis `docker start api`.

Testé : avec `api` puis `auth` coupés brutalement (`docker kill`), une seule requête sur une cinquantaine a échoué, toutes les autres sont servies en moins de 70 ms.

## Basculer une base sur sa réplique

En cas de panne de la primaire (exemple pour la base des paiements) :

```bash
docker compose -f docker-compose.infra.yml exec ansible ansible-playbook playbooks/bascule-db.yml -e base=paiement
```

Le playbook :

1. vérifie que la réplique est bien en attente (pas déjà promue) ;
2. arrête l'ancienne primaire si elle tourne encore (pour éviter deux primaires) ;
3. promeut la réplique en primaire ;
4. lui donne le nom réseau `db-paiement` : `api` et `api-2` s'y reconnectent sans changer de configuration.

Testé : la bascule prend environ 2 secondes, l'API repasse à `200` sans redémarrage, et les données écrites avant la panne sont présentes sur la nouvelle primaire.

**Après une bascule, ne pas relancer `docker compose up -d`** : Docker redémarrerait l'ancienne primaire sous le même nom, et il y aurait deux bases `db-paiement`. Faire d'abord le retour à la normale.

## Retour à la normale après une bascule

Une fois la panne comprise, on recopie les données de la réplique promue dans la primaire, puis on recrée une réplique neuve (exemple pour `paiement`, depuis `infra/compose`) :

1. Arrêter les services qui utilisent la base, et la réplique promue :
   ```bash
   docker stop api api-2 db-paiement-replica
   ```
2. Recopier les données de la réplique promue dans le volume de la primaire :
   ```bash
   docker run --rm -v resilience-alpha_db_paiement_replica_data:/from -v resilience-alpha_db_paiement_data:/to alpine:3.21 sh -c "rm -rf /to/* && cp -a /from/. /to/ && rm -f /to/standby.signal"
   ```
3. Supprimer la réplique et son volume (elle sera recréée à partir de la primaire) :
   ```bash
   docker rm db-paiement-replica
   ```
   ```bash
   docker volume rm resilience-alpha_db_paiement_replica_data
   ```
4. Relancer la pile dev :
   ```bash
   docker compose -f docker-compose.dev.yml -f docker-compose.dev.redondance.yml up -d
   ```

## Restaurer une sauvegarde

Exemple : remettre la base des paiements dans l'état d'une sauvegarde.

```bash
ls redondance/backups/paiement/
```

```bash
docker exec -i db-paiement pg_restore -U api_user -d payments --clean --if-exists < redondance/backups/paiement/paiement-AAAAMMJJTHHMMSSZ.dump
```

La restauration est recopiée automatiquement sur la réplique.

## Limites

- **Tout tourne sur un seul PC Hôte** : s'il tombe, tout tombe. C'est la limite principale, à faire figurer dans le PCA/PRA. La suite logique serait de mettre les répliques sur une 2e machine du groupe.
- **Juste après la panne d'une instance, une requête peut rester bloquée** : le WAF garde l'adresse de l'instance morte en cache 5 secondes, et attend jusqu'à 60 secondes (`proxy_connect_timeout` dans `config/waf/proxy_common.conf.template`) avant d'essayer l'autre. Baisser ce délai à 3 secondes réduirait ce cas : c'est une modification du WAF, à voir avec la cyber.
- **Le WAF reste un point unique** : son redémarrage automatique (`restart: unless-stopped`) et son healthcheck limitent la coupure à quelques secondes.
- **La remédiation ne connaît que `api` et `auth`** (noms de conteneurs dans sa configuration). Un redémarrage demandé par la remédiation ne touche que la 1re instance, ce qui est sans gravité puisque la 2e continue de servir.
- **Prometheus** ne collecte pas encore les métriques des 2es instances (`auth-2`, `api-2`) : il faut les ajouter à `config/prometheus/prometheus.yml`.
