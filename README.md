# RESILIENCE-ALPHA

Plateforme de paiement fictive capable de **encaisser une attaque et de se rétablir seule**, avec preuve de reprise (nouvelle transaction réussie après l'incident). Workshop EPSI M2 2026-27.

> Données 100 % fictives. Toute action offensive reste limitée à ce laboratoire.

## Structure du dépôt

```
services/      DEV    front, api (paiements), auth, remediation, dashboard, backoffice (TypeScript : Express, React, Prisma)
packages/      DEV    shared (schémas zod, types, client HTTP typé)
infra/         INFRA  compose/, ansible/, waf/, observability/, siem/
               CYBER  secrets/ (SOPS+age, fichiers *.enc.yaml uniquement)
ml/            IA     detector/ (détection d'anomalies), assistant/ (RAG Ollama),
                      face/ (reconnaissance faciale du back-office),
                      training/ (entraînement), data/ (jeux fictifs, non versionnés)
attacks/       CYBER  scripts Red Team, à lancer depuis le PC Attaquant
docs/          documentation (architecture, API, procédures ingérées par le RAG)
scripts/       outils : check-secrets.sh
```

## Documentation

- [Architecture, flux, sécurité et plan DEV](docs/architecture.md)
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

Démarre tout avec des images construites depuis le code réel (`services/*`), comme en démo — pas les prototypes `apps/*` ni des serveurs `npm run dev`. La pile est coupée en 3 fichiers Compose (voir [`infra/compose/README.md`](infra/compose/README.md)) : **infra** (observabilité, mosquitto, Ansible), **dev** (les 7 services DEV + leurs bases + l'IA faciale), **cyber** (WAF, SIEM).

### 1. Préparer la configuration (une fois)

```bash
cd infra/compose
cp .env.example .env # NE JAMAIS committer ce .env
mkdir -p ../../services/auth/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ../../services/auth/keys/jwt.pem
```

La clé JWT est obligatoire : sans elle, le conteneur `auth` (qui tourne en `NODE_ENV=production`) refuse de démarrer plutôt que d'utiliser une clé éphémère.

### 2. Lancer l'infra, puis la pile dev

```bash
docker compose -f docker-compose.infra.yml up -d --build   # réseaux partagés, Prometheus, Grafana, Loki, mosquitto, Ansible
docker compose -f docker-compose.dev.yml   up -d --build   # auth, api, remediation, front, dashboard, backoffice, face, 3 bases
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

| Adresse                                                   | Service                           | Remarque                                                                             |
| ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| http://localhost:3010                                      | `auth` (interne : `auth:3000`)     | Exposé tant que le WAF n'existe pas. JWKS sur `/.well-known/jwks.json`.              |
| http://localhost:3001                                      | `api` (interne : `api:3000`)       | Idem.                                                                                 |
| http://localhost:3002                                      | `remediation` (interne : `:3000`)  | Idem.                                                                                 |
| http://localhost:5173, 5174, 5175                          | `front`, `dashboard`, `backoffice` | Pages statiques servies, mais leurs appels `/auth`, `/api`, `/remediation` **échouent tant que le WAF n'est pas branché** (pile cyber, volontairement fait en dernier). |
| http://localhost:9090                                      | Prometheus                         | `/targets` pour vérifier que les services sont scrapés.                              |
| http://localhost:3000                                      | Grafana                            | Identifiants : `GRAFANA_ADMIN_*` dans `.env`.                                        |

**Tester le navigateur dès maintenant, sans attendre le WAF :** chaque README de `front`/`dashboard`/`backoffice` explique comment lancer son serveur Vite (qui sait déjà proxyfier `/auth`, `/api`, `/remediation`) contre les conteneurs `auth:3010`, `api:3001`, `remediation:3002` publiés ci-dessus. C'est une béquille de développement, pas ce qui tournera le jour J.

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

Scopes conseillés : `api`, `auth`, `remediation`, `dashboard`, `front`, `shared`, `infra`, `waf`, `siem`, `ml`, `attacks`, `docs`.

Exemples : `feat(api): add idempotency key on transactions`, `fix(remediation): verify canary before RESOLVED`, `chore: init monorepo structure`.

Avant de pousser, à lancer à la main :

- `npm run check:secrets` : aucun secret en clair dans le dépôt ;
- `npm test` : les tests de tous les workspaces (les tests d'intégration demandent `npm run db:up`).

## Rendus

Archive `Workshop2026-M2-G3-Code.zip` : sources, infra, attaques, ML, tests, documentation d'API, ce README.
