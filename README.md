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

## Prérequis

- PC Hôte : Windows 10/11, Docker Desktop + WSL2, 16 Go RAM, point d'accès mobile `RESILIENCE-G<n>` (hôte en `192.168.137.1`)
- PC Attaquant : poste distinct sur le même réseau
- Outils : Node.js 22+, `sops`, `age`, `ansible`
- Après le clone : `npm install` à la racine (installe aussi les hooks git)

## Démarrage (à compléter au fil des sprints)

```bash
cp .env.example .env # NE JAMAIS committer .env
```

## Règles de commit

Les messages suivent [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/), vérifiés par commitlint (hook `commit-msg`).

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

Hooks installés par `npm install` (husky) :

- `pre-commit` : contrôle des secrets sur les fichiers indexés, puis Prettier sur les fichiers modifiés ;
- `commit-msg` : commitlint ;
- `pre-push` : tests des workspaces (`npm test`).

Un commit refusé par un hook se corrige, il ne se contourne pas avec `--no-verify`.

## Rendus

Archive `Workshop2026-M2-G3-Code.zip` : sources, infra, attaques, ML, tests, documentation d'API, ce README.
