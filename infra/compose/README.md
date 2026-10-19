# PROJECT RESILIENCE-ALPHA : infrastructure Docker

Stack complète du workshop : applications Node.js, bases PostgreSQL, WAF, observabilité (Prometheus, Loki, Grafana), SIEM (Wazuh) et automatisation (Ansible).

## Prérequis

- Docker Desktop (ou Docker Engine + Compose v2) démarré
- Environ 4 Go de RAM libres pour l'ensemble de la stack
- Ports libres sur la machine : `80`, `3000`, `9090`, `1514`, `1515`, `55000`

## Démarrage rapide

1. Créer le fichier `.env` à la racine de ce dossier (voir [Variables d'environnement](#variables-denvironnement)).
2. Lancer la stack :
   ```bash
   docker compose up -d
   ```
3. Vérifier que tout tourne :
   ```bash
   docker compose ps
   ```

Le premier lancement télécharge les images (quelques minutes).

## Services

| Service | Rôle | Accès depuis la machine |
|---|---|---|
| `waf` | Reverse proxy Nginx + ModSecurity (règles OWASP CRS), point d'entrée unique | http://localhost |
| `application` | Application principale (Node.js) | via le WAF |
| `auth` | Service d'authentification (Node.js) | interne |
| `api-paiement` | API de paiement (Node.js) | interne |
| `remediation` | Service de remédiation (Node.js) | interne |
| `db-app`, `db-auth`, `db-paiement` | Une base PostgreSQL 16 par application | interne |
| `prometheus` | Collecte des métriques | http://localhost:9090 |
| `node-exporter` | Métriques de la machine hôte | interne |
| `loki` | Stockage des logs | interne |
| `promtail` | Envoie les logs des conteneurs vers Loki | interne |
| `grafana` | Tableaux de bord (sources Prometheus et Loki préconfigurées) | http://localhost:3000 |
| `wazuh-manager` | SIEM (manager seul, sans interface web) | API : https://localhost:55000 |
| `ansible` | Nœud de contrôle Ansible | `docker compose exec ansible …` |

## Réseaux

Les services sont séparés en 4 réseaux pour limiter les accès :

- `frontend` : seul le WAF y est, c'est la porte d'entrée.
- `backend` : les applications entre elles.
- `data` : les applications et leur base. Les bases ne sont pas exposées sur la machine.
- `monitoring` : Prometheus, Loki, Grafana, Wazuh.

## Arborescence

```
infra/
├── docker-compose.yml
├── .env                       # à créer, ne pas partager
├── apps/                      # code des applications Node.js
│   ├── application/
│   ├── auth/
│   ├── api-paiement/
│   └── remediation/
├── ansible/
│   ├── Dockerfile             # image du nœud de contrôle
│   └── playbooks/             # vos playbooks
└── config/
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
docker compose restart application
```

## Variables d'environnement

Le fichier `.env` doit définir :

| Variable | Utilisée par |
|---|---|
| `DB_APP_USER`, `DB_APP_PASSWORD`, `DB_APP_NAME` | `db-app`, `application` |
| `DB_AUTH_USER`, `DB_AUTH_PASSWORD`, `DB_AUTH_NAME` | `db-auth`, `auth` |
| `DB_PAIEMENT_USER`, `DB_PAIEMENT_PASSWORD`, `DB_PAIEMENT_NAME` | `db-paiement`, `api-paiement` |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` | `grafana` |
| `WAZUH_API_USER`, `WAZUH_API_PASSWORD` | `wazuh-manager` |

Le mot de passe Wazuh doit être fort : au moins 8 caractères, avec majuscule, minuscule, chiffre et symbole.

## Commandes utiles

```bash
docker compose ps                          # état des services
docker compose logs -f <service>           # suivre les logs d'un service
docker compose restart <service>           # redémarrer un service
docker compose exec ansible ansible-playbook playbooks/<fichier>.yml
docker compose down                        # arrêter (les données sont conservées)
docker compose down -v                     # arrêter ET supprimer toutes les données
```

## Vérifier que la stack fonctionne

- **Grafana** : http://localhost:3000, menu *Explore*, source *Loki*, requête `{container="waf"}` pour voir les logs.
- **Prometheus** : http://localhost:9090/targets. `prometheus` et `node-exporter` doivent être *UP*.
- **WAF** : une attaque simple doit être bloquée (code 403) :
  ```bash
  curl -i "http://localhost/?id=1'%20OR%20'1'='1"
  ```

## Comportements normaux à connaître

- **Erreur 502 sur http://localhost** : aucune application ne tourne encore derrière le WAF.
- **Applications « down » dans Prometheus** : elles n'exposent pas encore `/metrics`.
- **Erreurs `wazuh.indexer` dans les logs de Wazuh** : seul le manager est installé, pas l'indexer. Le manager fonctionne quand même.
- **Le WAF ne redirige que vers `application`** : pour exposer d'autres services, il faudra une configuration Nginx avec des routes.

## Partager ce dossier

- Ne pas inclure le fichier `.env` (il contient les mots de passe).
- Ne pas inclure les dossiers `apps/*/node_modules`.
- Les données (bases, Grafana, Wazuh) sont stockées dans des volumes Docker, pas dans ce dossier : elles ne partent donc pas avec.
