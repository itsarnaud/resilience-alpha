# PROJECT RESILIENCE-ALPHA : infrastructure Docker

Stack complète du workshop : applications Node.js, bases PostgreSQL, WAF, observabilité (Prometheus, Loki, Grafana), SIEM (Wazuh) et automatisation (Ansible).

La stack est découpée en **3 piles** (3 projets Docker Compose) qui tournent sur la même machine :

| Pile      | Fichier                    | Contenu                                                                                        |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| **Infra** | `docker-compose.infra.yml` | Observabilité (Prometheus, node-exporter, Loki, Promtail, Grafana) et automatisation (Ansible) |
| **Dev**   | `docker-compose.dev.yml`   | Applications Node.js et leurs bases PostgreSQL                                                 |
| **Cyber** | `docker-compose.cyber.yml` | WAF (point d'entrée) et SIEM (Wazuh)                                                           |

L'ancien fichier unique `docker-compose.yml` est conservé pour référence, mais ne doit pas être lancé en même temps que les 3 piles (mêmes noms de conteneurs et de ports).

## Prérequis

- Docker Desktop (ou Docker Engine + Compose v2) démarré
- Environ 4 Go de RAM libres pour l'ensemble de la stack
- Ports libres sur la machine : `80`, `3000`, `9090`, `1514`, `1515`, `55000`

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
   - **Dev avant cyber** : le WAF redirige vers `application`. Si elle n'existe pas encore, le WAF redémarre en boucle jusqu'à ce qu'elle soit lancée.
3. Vérifier que tout tourne :
   ```bash
   docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Label \"com.docker.compose.project\"}}"
   ```

Le premier lancement télécharge les images (quelques minutes).

### Migration depuis l'ancien `docker-compose.yml`

Si l'ancienne stack tourne, l'arrêter d'abord (**sans** `-v`, pour garder les données) :

```bash
docker compose -f docker-compose.yml down
```

Les volumes des 3 piles portent les mêmes noms qu'avant (`resilience-alpha_*`) : bases, Grafana, Prometheus, Loki et Wazuh retrouvent leurs données.

## Services

| Service                            | Pile  | Rôle                                                                        | Accès depuis la machine                                     |
| ---------------------------------- | ----- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `prometheus`                       | Infra | Collecte des métriques                                                      | http://localhost:9090                                       |
| `node-exporter`                    | Infra | Métriques de la machine hôte                                                | interne                                                     |
| `loki`                             | Infra | Stockage des logs                                                           | interne                                                     |
| `promtail`                         | Infra | Envoie les logs des conteneurs (des 3 piles) vers Loki                      | interne                                                     |
| `grafana`                          | Infra | Tableaux de bord (sources Prometheus et Loki préconfigurées)                | http://localhost:3000                                       |
| `ansible`                          | Infra | Nœud de contrôle Ansible                                                    | `docker compose -f docker-compose.infra.yml exec ansible …` |
| `application`                      | Dev   | Application principale (Node.js)                                            | via le WAF                                                  |
| `auth`                             | Dev   | Service d'authentification (Node.js)                                        | interne                                                     |
| `api-paiement`                     | Dev   | API de paiement (Node.js)                                                   | interne                                                     |
| `remediation`                      | Dev   | Service de remédiation (Node.js)                                            | interne                                                     |
| `db-app`, `db-auth`, `db-paiement` | Dev   | Une base PostgreSQL 16 par application                                      | interne                                                     |
| `waf`                              | Cyber | Reverse proxy Nginx + ModSecurity (règles OWASP CRS), point d'entrée unique | http://localhost                                            |
| `wazuh-manager`                    | Cyber | SIEM (manager seul, sans interface web)                                     | API : https://localhost:55000                               |

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
├── docker-compose.yml         # ancien fichier unique (référence)
├── .env                       # à créer, ne pas partager
├── apps/                      # code des applications Node.js (pile Dev)
│   ├── application/
│   ├── auth/
│   ├── api-paiement/
│   └── remediation/
├── ansible/                   # pile Infra
│   ├── Dockerfile             # image du nœud de contrôle
│   └── playbooks/             # vos playbooks
└── config/                    # pile Infra
    ├── prometheus/prometheus.yml
    ├── promtail/config.yml
    └── grafana/provisioning/datasources/datasources.yml
```

## Ajouter le code d'une application Node.js

Chaque application utilise l'image `node:20-alpine` et monte son dossier `apps/<nom>` dans `/app`.

- Tant qu'il n'y a pas de `package.json`, le conteneur reste allumé et attend.
- Dès qu'un `package.json` est présent, le conteneur lance `npm install` puis `npm start`.

Contraintes pour le code :

- Écouter sur le **port 3000** (fourni dans la variable `PORT`).
- Se connecter à la base via la variable `DATABASE_URL` (déjà fournie à `application`, `auth` et `api-paiement`).
- Pour joindre un autre service, utiliser son nom : `http://auth:3000`, `http://api-paiement:3000`…
- Pour apparaître dans Prometheus, exposer une route `/metrics` (par exemple avec le paquet `prom-client`).

Après avoir ajouté ou modifié le code :

```bash
docker compose -f docker-compose.dev.yml restart application
```

## Variables d'environnement

Le fichier `.env` (commun aux 3 piles) doit définir :

| Variable                                                       | Utilisée par                  | Pile  |
| -------------------------------------------------------------- | ----------------------------- | ----- |
| `DB_APP_USER`, `DB_APP_PASSWORD`, `DB_APP_NAME`                | `db-app`, `application`       | Dev   |
| `DB_AUTH_USER`, `DB_AUTH_PASSWORD`, `DB_AUTH_NAME`             | `db-auth`, `auth`             | Dev   |
| `DB_PAIEMENT_USER`, `DB_PAIEMENT_PASSWORD`, `DB_PAIEMENT_NAME` | `db-paiement`, `api-paiement` | Dev   |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`                 | `grafana`                     | Infra |
| `WAZUH_API_USER`, `WAZUH_API_PASSWORD`                         | `wazuh-manager`               | Cyber |

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

- **Erreur 502 sur http://localhost** : aucune application ne tourne encore derrière le WAF.
- **Le WAF redémarre en boucle** : la pile dev n'est pas lancée (`application` introuvable). Il repart seul une fois la pile dev démarrée.
- **`network resilience-alpha_backend not found`** au lancement de dev ou cyber : la pile infra n'est pas lancée.
- **Applications « down » dans Prometheus** : elles n'exposent pas encore `/metrics`.
- **Erreurs `wazuh.indexer` dans les logs de Wazuh** : seul le manager est installé, pas l'indexer. Le manager fonctionne quand même.
- **Le WAF ne redirige que vers `application`** : pour exposer d'autres services, il faudra une configuration Nginx avec des routes.

## Partager ce dossier

- Ne pas inclure le fichier `.env` (il contient les mots de passe).
- Ne pas inclure les dossiers `apps/*/node_modules`.
- Les données (bases, Grafana, Wazuh) sont stockées dans des volumes Docker, pas dans ce dossier : elles ne partent donc pas avec.
