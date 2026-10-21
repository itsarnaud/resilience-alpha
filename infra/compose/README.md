# PROJECT RESILIENCE-ALPHA : infrastructure Docker

Stack complète du workshop : applications Node.js, bases PostgreSQL, WAF, observabilité (Prometheus, Loki, Grafana), SIEM (Wazuh) et automatisation (Ansible).

La stack est découpée en **3 piles** (3 projets Docker Compose) qui tournent sur la même machine :

| Pile      | Fichier                    | Contenu                                                                                        |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| **Infra** | `docker-compose.infra.yml` | Observabilité (Prometheus, node-exporter, Loki, Promtail, Grafana) et automatisation (Ansible) |
| **Dev**   | `docker-compose.dev.yml`   | Applications Node.js et leurs bases PostgreSQL                                                 |
| **Cyber** | `docker-compose.cyber.yml` | WAF (point d'entrée) et SIEM (Wazuh)                                                           |


## Prérequis

- Docker Desktop (ou Docker Engine + Compose v2) démarré
- Environ 4 Go de RAM libres pour l'ensemble de la stack
- Ports libres sur la machine : `80`, `1883`, `3000`, `3001`, `3002`, `3010`, `5173`, `5174`, `5175`, `8011`, `8012`, `8081`, `8082`, `9090`, `1514`, `1515`, `55000` (`3000` est pris par Grafana : `auth` est donc publié sur `3010`, voir [le README principal](../../README.md#lancer-toute-la-plateforme-docker-compose))
- `services/auth/keys/jwt.pem` généré une fois (voir le README principal, section « Lancer toute la plateforme »)
- `detector`/`assistant` (IA) : le modèle ML et la base de connaissances copiés dans `ml/ai-runtime/models` et `ml/ai-runtime/data` (gitignorés, depuis la livraison de l'IA), et [Ollama](https://ollama.com) lancé sur la machine hôte avec `qwen2.5:3b` et `embeddinggemma:300m` — voir le README principal et `ml/ai-runtime/deploy/AI_HANDOFF.md`.

## Démarrage rapide

1. Créer le fichier `.env` à la racine de ce dossier (voir [Variables d'environnement](#variables-denvironnement)). Il est commun aux 3 piles.
2. Lancer les piles **dans cet ordre** :
   ```bash
   docker compose -f docker-compose.infra.yml up -d
   ```
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```
   ```bash
   docker compose -f docker-compose.cyber.yml up -d
   ```
   - **Infra en premier** : c'est elle qui crée les réseaux partagés `backend` et `monitoring`. Sans elle, les piles dev et cyber refusent de démarrer (réseau externe introuvable).
   - **Dev avant cyber** : le WAF redirigera vers `front`/`dashboard`/`backoffice`, `auth`, `api` et `remediation`. S'ils n'existent pas encore, le WAF redémarre en boucle jusqu'à ce qu'ils soient lancés.
3. Vérifier que tout tourne :
   ```bash
   docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Label \"com.docker.compose.project\"}}"
   ```

Le premier lancement télécharge et construit les images (quelques minutes). Détail des services Dev, des variables d'environnement et du premier démarrage (clé JWT, seed des comptes) : voir [le README principal](../../README.md#lancer-toute-la-plateforme-docker-compose).

## Services

| Service                                    | Pile  | Rôle                                                                        | Accès depuis la machine                                       |
| ------------------------------------------- | ----- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `prometheus`                               | Infra | Collecte des métriques                                                      | http://localhost:9090                                          |
| `node-exporter`                            | Infra | Métriques de la machine hôte                                                | interne                                                        |
| `loki`                                      | Infra | Stockage des logs                                                           | interne                                                        |
| `promtail`                                 | Infra | Envoie les logs des conteneurs (des 3 piles) vers Loki                      | interne                                                        |
| `grafana`                                  | Infra | Tableaux de bord (sources Prometheus et Loki préconfigurées)                | http://localhost:3000                                          |
| `ansible`                                  | Infra | Nœud de contrôle Ansible                                                    | `docker compose -f docker-compose.infra.yml exec ansible …`   |
| `mosquitto`                                | Infra | Broker MQTT (LED du back-office, voir `services/auth`)                     | `1883` (l'ESP8266 s'y connecte)                                |
| `docker-socket-proxy`                      | Infra | Accès Docker filtré pour `remediation` (jamais le socket brut)             | interne                                                        |
| `auth`, `api`, `remediation`               | Dev   | Les vrais services (`services/*`, TypeScript, Prisma)                      | `3010`, `3001`, `3002` (exposés tant que le WAF n'existe pas) |
| `front`, `dashboard`, `backoffice`         | Dev   | Applications React compilées (nginx)                                       | `5173`, `5174`, `5175` — via le WAF à terme                   |
| `face`                                     | Dev   | Reconnaissance faciale du back-office (IA, `ml/face`)                      | interne (appelé par `auth`)                                   |
| `detector`                                 | Dev   | Lecture du modèle ML d'anomalies (IA, `ml/ai-runtime`)                     | `8011` (accès direct, debug)                                   |
| `assistant`                                | Dev   | Assistant RAG, documentation du projet (IA, `ml/ai-runtime` + Ollama hôte) | `8012` (accès direct, debug)                                   |
| `db-auth`, `db-paiement`, `db-remediation` | Dev   | Une base PostgreSQL 16 par service                                         | interne                                                        |
| `waf`                                       | Cyber | Reverse proxy Nginx + ModSecurity (règles OWASP CRS), point d'entrée unique | http://localhost                                              |
| `wazuh-manager`                            | Cyber | SIEM (manager seul, sans interface web)                                     | API : https://localhost:55000                                 |

## Réseaux

Les services sont séparés en 4 réseaux pour limiter les accès. Les réseaux partagés ont un nom fixe pour que les 3 piles se retrouvent :

| Réseau       | Nom Docker                    | Créé par        | Utilisé par                                                              |
| ------------ | ----------------------------- | --------------- | ------------------------------------------------------------------------ |
| `frontend`   | `resilience-alpha_frontend`   | Cyber           | WAF seul : c'est la porte d'entrée                                       |
| `backend`    | `resilience-alpha_backend`    | Infra (partagé) | Applications entre elles, WAF, Prometheus, Wazuh, Ansible                |
| `data`       | `resilience-alpha_data`       | Dev             | Applications et leur base. Les bases ne sont pas exposées sur la machine |
| `monitoring` | `resilience-alpha_monitoring` | Infra (partagé) | Prometheus, Loki, Grafana, Wazuh, Ansible, `remediation`                 |

Comme tous les services partagent ces réseaux, ils se joignent toujours par leur nom (`http://auth:3000`, `http://prometheus:9090`, `https://wazuh-manager:55000`…), même d'une pile à l'autre.

## Arborescence

```
infra/
├── docker-compose.infra.yml   # pile Infra
├── docker-compose.dev.yml     # pile Dev
├── docker-compose.cyber.yml   # pile Cyber
├── .env                       # à créer depuis .env.example, ne pas partager
├── apps/                      # anciens prototypes Node CommonJS, remplacés par services/* (voir plus bas)
├── ansible/                   # pile Infra
│   ├── Dockerfile             # image du nœud de contrôle
│   └── playbooks/             # vos playbooks
└── config/                    # pile Infra
    ├── mosquitto/mosquitto.conf
    ├── prometheus/prometheus.yml
    ├── promtail/config.yml
    └── grafana/provisioning/datasources/datasources.yml
```

## Le code des services Dev

Les anciens prototypes `apps/*` (Node CommonJS, montés à chaud dans `node:20-alpine`) ont été remplacés par les vraies images : chaque service (`auth`, `api`, `remediation`, `front`, `dashboard`, `backoffice`) a son propre `Dockerfile` dans `services/<nom>/`, buildé depuis la racine du dépôt (contexte `../..`, car c'est un monorepo npm workspaces). Le dossier `apps/*` ne sert donc plus qu'à titre d'archive.

Pour modifier le code d'un service : voir son README (`services/<nom>/README.md`). Pour relancer sa version conteneurisée après une modification :

```bash
docker compose -f docker-compose.dev.yml up -d --build <service>
```

## Variables d'environnement

Le fichier `.env` (commun aux 3 piles, voir [`.env.example`](.env.example)) doit définir :

| Variable                                                                                  | Utilisée par                                 | Pile  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- | ----- |
| `DB_AUTH_USER`, `DB_AUTH_PASSWORD`, `DB_AUTH_NAME`                                         | `db-auth`, `auth`                              | Dev   |
| `DB_PAIEMENT_USER`, `DB_PAIEMENT_PASSWORD`, `DB_PAIEMENT_NAME`                             | `db-paiement`, `api`                           | Dev   |
| `DB_REMEDIATION_USER`, `DB_REMEDIATION_PASSWORD`, `DB_REMEDIATION_NAME`                    | `db-remediation`, `remediation`                | Dev   |
| `SEED_OPERATOR_EMAIL/PASSWORD`, `SEED_ADMIN_EMAIL/PASSWORD`, `SEED_VICTIM_EMAIL/PASSWORD`  | comptes de démonstration (`auth`)              | Dev   |
| `SVC_DETECTOR_SECRET`, `SVC_DASHBOARD_SECRET`, `SVC_REMEDIATION_SECRET`                    | comptes de service (`auth`, `remediation`)     | Dev   |
| `MQTT_AUTH_USERNAME`, `MQTT_AUTH_PASSWORD`                                                 | `auth` sur le broker `mosquitto`               | Dev   |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`                                             | `grafana`                                      | Infra |
| `WAZUH_API_USER`, `WAZUH_API_PASSWORD`                                                     | `wazuh-manager`                                | Cyber |

Le mot de passe Wazuh doit être fort : au moins 8 caractères, avec majuscule, minuscule, chiffre et symbole.

## Commandes utiles

Toutes les commandes prennent le fichier de la pile visée avec `-f` (`infra`, `dev` ou `cyber`) :

```bash
docker compose -f docker-compose.<pile>.yml ps                  # état des services de la pile
docker compose -f docker-compose.<pile>.yml logs -f <service>   # suivre les logs d'un service
docker compose -f docker-compose.<pile>.yml restart <service>   # redémarrer un service
docker compose -f docker-compose.infra.yml exec ansible ansible-playbook playbooks/<fichier>.yml
```

Arrêter la stack (ordre inverse du démarrage, l'infra en dernier car elle porte les réseaux partagés) :

```bash
docker compose -f docker-compose.cyber.yml down
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.infra.yml down
```

Ajouter `-v` à chaque `down` pour supprimer **aussi** les données de la pile concernée.

## Vérifier que la stack fonctionne

- **Grafana** : http://localhost:3000, menu _Explore_, source _Loki_, requête `{container="waf"}` pour voir les logs.
- **Prometheus** : http://localhost:9090/targets. `prometheus` et `node-exporter` doivent être _UP_.
- **WAF** : une attaque simple doit être bloquée (code 403) :
  ```bash
  curl -i "http://localhost/?id=1'%20OR%20'1'='1"
  ```

## Comportements normaux à connaître

- **Erreur 502 sur http://localhost** : le WAF n'a pas encore de route vers les services dev (pile cyber pas encore branchée dessus — voir le README principal).
- **`network resilience-alpha_backend not found`** au lancement de dev ou cyber : la pile infra n'est pas lancée.
- **Services « down » dans Prometheus** : ils n'exposent pas encore `/metrics`, ou ne sont pas démarrés.
- **Erreurs `wazuh.indexer` dans les logs de Wazuh** : seul le manager est installé, pas l'indexer. Le manager fonctionne quand même.
- **Conflit de port ou de nom de conteneur au démarrage** : un autre projet Docker Compose sur la machine (TP, essai précédent) utilise déjà ce nom ou ce port — voir le README principal, section « Si un port ou un nom de conteneur est déjà pris ».

## Partager ce dossier

- Ne pas inclure le fichier `.env` (il contient les mots de passe).
- Les données (bases, Grafana, Wazuh, visages enrôlés) sont stockées dans des volumes Docker, pas dans ce dossier : elles ne partent donc pas avec.
