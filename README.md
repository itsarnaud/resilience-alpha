# RESILIENCE-ALPHA

Plateforme de paiement fictive capable de **encaisser une attaque et de se rétablir seule**, avec preuve de reprise (nouvelle transaction réussie après l'incident). Workshop EPSI M2 2026-27.

> Données 100 % fictives. Toute action offensive reste limitée à ce laboratoire.

## Structure du dépôt

```
services/      DEV    front, api (paiements), auth, remediation, dashboard, backoffice (TypeScript : Express, React, Prisma)
packages/      DEV    shared (schémas zod, types, client HTTP typé)
infra/         INFRA  compose/, ansible/, waf/, observability/
               CYBER  secrets/ (SOPS+age, fichiers *.enc.yaml uniquement)
ml/            IA     ai-runtime/ (detector : détection d'anomalies ; assistant : RAG Ollama),
                      log-detector/ (brute-force sans ML → incident de remédiation),
                      supervision-ai/ (santé des services + intrusion → remédiation & notif SOC),
                      face/ (reconnaissance faciale du back-office),
                      training/ (entraînement), data/ (jeux fictifs, non versionnés)
attacks/       CYBER  scripts Red Team, à lancer depuis le PC Attaquant
docs/          documentation (architecture, API, procédures ingérées par le RAG)
scripts/       outils : check-secrets.sh
```

## Documentation

- [Architecture, flux, sécurité et plan DEV](docs/architecture.md)
- [Analyse de risques EBIOS RM](docs/analyse-ebios-rm.md) — ateliers, événements redoutés, risques R1–R9, mesures M1–M11
- [PCA/PRA — continuité et reprise](docs/PCA-PRA.md) — cartographie, matrice de reprise, procédures P1–P5
- Contrats d'API : [auth](docs/api/auth.openapi.yaml), [paiements](docs/api/payments.openapi.yaml), [remédiation](docs/api/remediation.openapi.yaml)

### Visualiser les contrats d'API

```bash
npm run docs:api
```

Puis ouvrir http://localhost:8081 (Swagger UI, menu déroulant en haut à droite pour passer de `auth`, `paiements`, `remediation` et `ia`). Nécessite Docker. Les fichiers sont relus à chaque chargement de la page, il suffit de la recharger après une modification d'un `.yaml`. `Ctrl+C` pour arrêter.

## Prérequis

- PC Hôte : Windows 10/11, Docker Desktop + WSL2, 16 Go RAM, point d'accès mobile `RESILIENCE-G3` (hôte en `192.168.137.1`)
- PC Attaquant : poste distinct sur le même réseau
- Outils : Node.js 22+, `sops`, `age`, `ansible`
- Après le clone : `npm install` à la racine. Cela compile `packages/shared` (utilisé compilé par tous les services). Après une modification de `packages/shared` : `npm run build:shared`, ou `npm run dev -w packages/shared` pour recompiler en continu.

## Démarrage sans Docker (développement d'un seul service)

```bash
cp .env.example .env # NE JAMAIS committer .env
```

Chaque service a son propre `.env.example` (`services/<nom>/.env.example`) avec des valeurs de labo qui fonctionnent telles quelles pour `npm run dev -w services/<nom>` (voir son README). C'est la façon la plus rapide d'itérer sur un seul service.

## Lancer toute la plateforme (Docker Compose)

Démarre tout avec des images construites depuis le code réel (`services/*`), comme en démo — pas les prototypes `apps/*` ni des serveurs `npm run dev`. La pile est coupée en 3 fichiers Compose (voir [`infra/compose/README.md`](infra/compose/README.md)) : **infra** (observabilité, mosquitto, Ansible), **dev** (les 7 services DEV + leurs bases, l'IA faciale, le détecteur et l'assistant RAG, le `log-detector` et la `supervision-ai`), **cyber** (le WAF, point d'entrée unique — routage par préfixe : `/auth`, `/api`, `/remediation` préfixe retiré ; `/detector`, `/assistant` préfixe conservé ; fronts `front`/`dashboard`/`backoffice` sur 3 ports).

### 1. Préparer la configuration (une fois)

```bash
cd infra/compose
cp .env.example .env # NE JAMAIS committer ce .env
mkdir -p ../../services/auth/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ../../services/auth/keys/jwt.pem
```

La clé JWT est obligatoire : sans elle, le conteneur `auth` (qui tourne en `NODE_ENV=production`) refuse de démarrer plutôt que d'utiliser une clé éphémère.

**Détecteur et assistant (IA, `ml/ai-runtime`)** : le modèle ML et la base de connaissances ne sont pas dans le dépôt (gitignorés, données trop lourdes ou sensibles). Les récupérer depuis la livraison de l'IA (archive `resilience-ai-complete-*.zip` ou équivalent) et les placer dans :

```bash
# Depuis la racine du dépôt, après avoir extrait la livraison IA quelque part :
mkdir -p ml/ai-runtime/models ml/ai-runtime/data
cp <livraison>/models/*.joblib <livraison>/models/*.json ml/ai-runtime/models/
cp -R <livraison>/data/knowledge_base ml/ai-runtime/data/
```

Sans ça, le conteneur `detector` démarre puis boucle en échec (modèle introuvable). Nécessite aussi Ollama lancé sur la machine hôte (`qwen2.5:3b` et `embeddinggemma:300m` téléchargés : `ollama pull qwen2.5:3b && ollama pull embeddinggemma:300m`) — voir `ml/ai-runtime/deploy/AI_HANDOFF.md`.

### 2. Lancer l'infra, puis la pile dev, puis le WAF

```bash
docker compose -f docker-compose.infra.yml  up -d --build   # réseaux partagés, Prometheus, Grafana, Loki, mosquitto, Ansible
docker compose -f docker-compose.dev.yml    up -d --build   # auth, api, remediation, front, dashboard, backoffice, face, detector, assistant, log-detector, supervision-ai, 3 bases
docker compose -f docker-compose.cyber.yml  up -d waf       # le WAF, point d'entrée unique
```

Vérifier que tout est sain :

```bash
docker compose -f docker-compose.dev.yml ps      # tous les services doivent passer "healthy"
```

### 3. Créer les comptes et données de démonstration (une fois, après le premier démarrage)

```bash
docker compose -f docker-compose.dev.yml exec auth node dist/scripts/seed.js   # operator, admin, victime, comptes de service
docker compose -f docker-compose.dev.yml exec api  node dist/scripts/seed.js   # comptes du virement canari
```

Identifiants créés : voir `SEED_*` dans `infra/compose/.env`. Le visage de l'admin n'est pas pré-enregistré : connecte-toi au back-office (voir ci-dessous) puis enrôle-le depuis Habilitations.

### Ce qui est joignable, et comment

**Via le WAF (pile cyber lancée) — c'est ce qui tournera le jour J :**

| Adresse               | Service      | Remarque                                                        |
| ---------------------- | ------------ | ----------------------------------------------------------------- |
| http://localhost       | `front`      | Banque client. `/auth/*` et `/api/*` routés, préfixe retiré.      |
| http://localhost:8081  | `dashboard`  | Supervision. `/auth/*` et `/remediation/*` routés (préfixe retiré) ; `/detector/*` et `/assistant/*` routés (préfixe conservé). |
| http://localhost:8082  | `backoffice` | Admin + visage. `/auth/*` routé.                                  |

Chaque front a son propre port WAF (les 3 apps React sont compilées pour la racine `/`, elles ne peuvent pas partager un seul port avec des sous-chemins sans être reconstruites).

**Exceptions ModSecurity et routage (en place) :**
- L'étape photo du back-office (`POST /auth/v1/backoffice/login/:id/face`, corps `image/jpeg`) passe : l'exception est portée par `config/waf/modsecurity-override.conf` (chargé avant les règles CRS), voir `services/backoffice/README.md`.
- `/detector/*` et `/assistant/*` sont routés **sans retrait de préfixe** (contrairement à `/auth`/`/api`/`/remediation`), car ces API servent déjà ce chemin.

**Accès directs (debug, sans passer par le WAF) :**

| Adresse               | Service                             | Remarque                              |
| ---------------------- | ------------------------------------- | -------------------------------------- |
| http://localhost:3010  | `auth` (interne : `auth:3000`)        | JWKS sur `/.well-known/jwks.json`.     |
| http://localhost:3001  | `api` (interne : `api:3000`)          |                                         |
| http://localhost:3002  | `remediation` (interne : `:3000`)     |                                         |
| http://localhost:8011  | `detector` (interne : `detector:8000`) | `GET /detector/v1/model`, `/v1/anomalies`. |
| http://localhost:8012  | `assistant` (interne : `assistant:8000`) | `POST /assistant/v1/chat`.           |
| http://localhost:9090  | Prometheus                            | `/targets` pour vérifier le scraping.  |
| http://localhost:3000  | Grafana                               | Identifiants : `GRAFANA_ADMIN_*`.      |

**Si le WAF n'est pas lancé** (pile cyber pas démarrée) : chaque README de `front`/`dashboard`/`backoffice` explique comment lancer son serveur Vite (qui sait proxyfier `/auth`, `/api`, `/remediation`, `/assistant`) contre les conteneurs ci-dessus. Une béquille de développement, plus nécessaire une fois le WAF up.

### Arrêter

```bash
docker compose -f docker-compose.dev.yml down     # garde les volumes (bases, visages enrôlés, Grafana…)
docker compose -f docker-compose.infra.yml down
```

Ajouter `-v` à chaque commande pour repartir de zéro (supprime aussi les données).

### Si un port ou un nom de conteneur est déjà pris

Docker refuse de démarrer un service si son port ou son nom est utilisé par un **autre** projet Compose présent sur la machine (TP, essai précédent...). `docker ps -a` puis `docker rm <nom>` (conteneur arrêté) ou `docker compose -p <projet> down` (pile complète d'un autre projet) débloquent la situation — en vérifiant d'abord qu'il ne s'agit pas d'un travail en cours de quelqu'un d'autre.

## Règles de commit

Les messages suivent [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/), vérifié automatiquement à chaque commit par un hook Husky (`commit-msg` + commitlint, voir `commitlint.config.js`). Après `npm install`, le hook est actif. Ce hook ne vérifie **que la forme du message** : aucun lint, aucun test n'est lancé automatiquement.

```
<type>(<scope optionnel>): <description courte à l'impératif, 100 caractères max>
```

| Type       | Usage                                      |
| ---------- | ------------------------------------------ |
| `feat`     | nouvelle fonctionnalité                    |
| `fix`      | correction de bug                          |
| `docs`     | documentation uniquement                   |
| `style`    | mise en forme, sans changement de logique  |
| `refactor` | réécriture sans changement de comportement |
| `perf`     | amélioration de performance                |
| `test`     | ajout ou modification de tests             |
| `build`    | dépendances, Dockerfile, packaging         |
| `ci`       | pipeline d'intégration                     |
| `chore`    | maintenance, outillage, structure          |
| `revert`   | annulation d'un commit                     |

Scopes conseillés : `api`, `auth`, `remediation`, `dashboard`, `front`, `shared`, `infra`, `waf`, `ml`, `attacks`, `docs`.

Exemples : `feat(api): add idempotency key on transactions`, `fix(remediation): verify canary before RESOLVED`, `chore: init monorepo structure`.

Avant de pousser, à lancer à la main :

- `npm run check:secrets` : aucun secret en clair dans le dépôt ;
- `npm test` : les tests de tous les workspaces (les tests d'intégration demandent `npm run db:up`).

## Rendus

Archive `Workshop2026-M2-G3-Code.zip` : sources, infra, attaques, ML, tests, documentation d'API, ce README.
