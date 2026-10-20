# Wazuh — déploiement Docker (manager + indexer + dashboard)

Déploiement autonome du SIEM Wazuh : **1 fichier compose**, 4 services, 0 dépendance externe.

```
docker compose up -d
```

---

## 1. Services

| Service          | Rôle                                          | Statut attendu   |
| ---------------- | --------------------------------------------- | ---------------- |
| `wazuh-certs`    | Génération de la CA + certificats TLS        | `Exited (0)`     |
| `wazuh-indexer`  | OpenSearch — stockage des alertes             | `Up`             |
| `wazuh-manager`  | Manager : API, agents, analyse des alertes    | `Up`             |
| `wazuh-dashboard`| Interface web du SIEM                         | `Up`             |

`wazuh-certs` est un **job** : il fait son travail et s'arrête. C'est normal.

## 2. Accès

| Service       | URL                       | Identifiants                    |
| ------------- | ------------------------- | ------------------------------- |
| Dashboard     | `https://localhost:5601`  | `admin` / `SecretPassword`      |
| Indexer (API) | `https://localhost:9200`  | `admin` / `SecretPassword`      |
| Manager (API) | `https://localhost:55000` | `wazuh-wui` / `MyS3cr37P450r.*-`|

Certificat TLS auto-signé → le navigateur affiche un avertissement (attendu).

## 3. Vérifier que tout tourne

```bash
docker compose ps -a

# API du manager : agents
TOKEN=$(curl -sk -u 'wazuh-wui:MyS3cr37P450r.*-' -X POST \
  https://localhost:55000/security/user/authenticate \
  -d '{"username":"wazuh-wui"}' | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost:55000/agents

# alertes indexees
curl -sk -u admin:SecretPassword 'https://localhost:9200/_cat/indices?h=index,docs.count' | grep alerts

# dashboard
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:5601/     # 302
```

Dans le dashboard : **Server management → Agents** doit montrer `wazuh.manager` en `Active`.

## 4. Fichiers

```
docker-compose.yml   les 4 services
.env                 versions, ports, identifiants
config/
  certs.yml                  noeuds a certifier (noms = hostnames et alias reseau)
  opensearch.yml             configuration de l'indexer
  internal_users.yml         comptes de l'indexer (hash bcrypt)
  opensearch_dashboards.yml  configuration du dashboard
  manager/ossec.conf         configuration du manager
```

## 5. Ajouter un agent

Les ports `1514` (événements) et `1515` (enrôlement) sont publiés sur l'hôte.

```bash
# sur la machine a superviser
curl -s https://packages.wazuh.com/4.14/apt/pool/main/w/wazuh-agent/wazuh-agent_4.14.9-1_amd64.deb \
  | sudo dpkg -i -
sudo /var/ossec/bin/agent-auth -m <IP_DU_MANAGER> -A <NOM_DE_L_AGENT> -G default
```

L'agent apparaît dans **Server management → Agents** dès qu'il est connecté.

> L'image Docker officielle `wazuh/wazuh-agent` est allégée : elle ne contient pas
> `wazuh-analysisd`. Les agents Docker collectent mais ne produisent pas
> d'alertes ; un agent installé nativement sur la machine, lui, en produit.

## 6. Corriger les bugs de la stack officielle

Cette stack corrige les problèmes suivants, tous appliqués dans le compose :

| Symptôme                                                        | Correctif                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cp: cannot create regular file 'root-ca-manager.pem'`          | `chmod 755 /certificates` avant la copie, dans le job `wazuh-certs`     |
| Certificats illisibles par le manager (uid 999)                  | `chmod 644 /certificates/*`                                              |
| `Directory wazuh-certificates already exists` au 2ᵉ `up`         | suppression du dossier de travail + génération idempotente              |
| `Unauthorized` sur l'API de l'indexer                            | `config/internal_users.yml` (hash bcrypt de `SecretPassword`)           |
| Les modules SCA / vulnérabilités ne trouvent pas l'indexer       | `config/manager/ossec.conf` : `<indexer>` pointé sur `wazuh.indexer`    |

## 7. Commandes utiles

```bash
docker compose logs -f wazuh-manager
docker compose exec wazuh-manager /var/ossec/bin/wazuh-control status
docker compose down -v      # supprime aussi les volumes (redemarrage a froid)
```

## 8. Prérequis

- Docker Desktop / Docker Engine + Compose **v2.20+**
- 4 Go de RAM libres (l'indexer consomme `INDEXER_HEAP_SIZE`, 1 Go par défaut)
- Ports libres sur l'hôte : `1514`, `1515`, `55000`, `9200`, `5601`
- Linux (hors Docker Desktop) : `sudo sysctl -w vm.max_map_count=262144`
  (inutile sur macOS / Windows)
