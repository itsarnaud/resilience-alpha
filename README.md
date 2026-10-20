# RESILIENCE-ALPHA

Plateforme de paiement fictive capable de **encaisser une attaque et de se rétablir seule**, avec preuve de reprise (nouvelle transaction réussie après l'incident). Workshop EPSI M2 2026-27.

> Données 100 % fictives. Toute action offensive reste limitée à ce laboratoire.

## Structure du dépôt

```
services/      DEV    front, api (paiements), auth, remediation, dashboard (TypeScript : Express, React, Prisma)
packages/      DEV    shared (schémas zod, types, client HTTP typé)
infra/         INFRA  compose/, ansible/, waf/, observability/, siem/
               CYBER  secrets/ (SOPS+age, fichiers *.enc.yaml uniquement)
ml/            IA     detector/ (détection d'anomalies), assistant/ (RAG Ollama),
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

- PC Hôte : Windows 10/11, Docker Desktop + WSL2, 16 Go RAM, point d'accès mobile `RESILIENCE-G<n>` (hôte en `192.168.137.1`)
- PC Attaquant : poste distinct sur le même réseau
- Outils : Node.js 22+, `sops`, `age`, `ansible`
- Après le clone : `npm install` à la racine. Cela compile `packages/shared` (utilisé compilé par tous les services). Après une modification de `packages/shared` : `npm run build:shared`, ou `npm run dev -w packages/shared` pour recompiler en continu.

## Démarrage (à compléter au fil des sprints)

```bash
cp .env.example .env # NE JAMAIS committer .env
```

## Règles de commit

Les messages suivent [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/), par convention (aucune vérification automatique).

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
