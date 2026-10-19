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
- Outils : `sops`, `age`, `ansible`

## Démarrage (à compléter au fil des sprints)
```bash
cp .env.example .env # NE JAMAIS committer .env
```

## Rendus
Archive `Workshop2026-M2-G3-Code.zip` : sources, infra, attaques, ML, tests, documentation d'API, ce README.
