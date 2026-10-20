# api (paiements)

API de paiement fictive : comptes, bénéficiaires, virements simulés avec idempotence, règle anti-fraude, et transaction de test (canari) utilisée par la remédiation pour prouver la reprise. Aucune donnée bancaire réelle : IBAN et soldes sont fictifs.

Contrat d'API : [`docs/api/payments.openapi.yaml`](../../docs/api/payments.openapi.yaml).

## Routes

| Route                          | Rôles                                | Description                                                          |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------------- |
| `POST /v1/accounts`            | `customer`                           | Ouvre un compte (solde fictif de 1 000 EUR, 5 comptes maximum).      |
| `GET /v1/accounts`, `/:id`     | `customer`, `svc:remediation-canary` | Ses comptes. Le compte d'un autre est traité comme inexistant (404). |
| `POST /v1/beneficiaries`       | `customer`                           | Ajoute un bénéficiaire (IBAN).                                       |
| `GET /v1/beneficiaries`        | `customer`                           | Liste ses bénéficiaires.                                             |
| `POST /v1/transactions`        | `customer`, `svc:remediation-canary` | Virement. En-tête `Idempotency-Key` (UUID) obligatoire.              |
| `GET /v1/transactions`, `/:id` | `customer`, `svc:remediation-canary` | Historique paginé par curseur, et détail.                            |
| `GET /healthz`, `/readyz`      | publiques                            | Santé (processus) et disponibilité (la base répond).                 |
| `GET /metrics`                 | publique (réseau interne)            | Métriques Prometheus.                                                |

Le service écoute à la racine (`/v1/...`) : le WAF doit retirer le préfixe `/api` avant de transmettre.

## Structure

Même organisation que `services/auth` : `app`, `router`, `routes`, `controllers`, `services`, `middlewares`, `schemas`, `lib`.

```
src/
├── index.ts, app.ts, router.ts
├── routes/           health, accounts, beneficiaries, transactions
├── controllers/      valide l'entrée (zod), appelle le service, formate la réponse
├── services/         AccountsServices, BeneficiariesServices, TransactionsServices
├── middlewares/      auth : vérifie le JWT avec les clés publiques d'auth (JWKS)
├── schemas/          paramètres, requêtes
├── lib/              config, logger, prisma, metrics, context, dto, iban, fraud
└── scripts/          seed (comptes du canari)
prisma/               schéma et migrations
test/                 tests d'intégration
```

## Règles métier

**Virement.** Les comptes concernés sont verrouillés (`SELECT ... FOR UPDATE`, dans l'ordre de leur id pour éviter les interblocages) pendant le contrôle du solde et la mise à jour. Le solde ne peut jamais devenir négatif (contrôle applicatif et contrainte en base). Les virements simultanés ne peuvent donc pas dépasser le solde, et la somme des soldes reste constante. Les refus enregistrés (fonds insuffisants, anti-fraude) passent par le même verrouillage : un `INSERT` dans `transactions` verrouille aussi ses comptes (clés étrangères) et, hors de ce chemin, pouvait provoquer un interblocage selon l'ordre des UUID. Tout accès aux comptes doit donc passer par `withLockedAccounts` (`TransactionsServices.ts`).

**Idempotence.** Rejouer la même `Idempotency-Key` renvoie le virement d'origine (`200`) sans débiter à nouveau. La réutiliser avec un autre contenu donne `409`. Deux requêtes simultanées avec la même clé ne produisent qu'un seul virement.

**Règle anti-fraude.** Un virement adressé par IBAN à un compte qui n'appartient pas à l'émetteur est refusé (`403`) si :

- `unknown_beneficiary` : l'IBAN n'est pas dans les bénéficiaires du client ;
- `amount_over_limit` : le montant dépasse `EXTERNAL_TRANSFER_LIMIT_CENTS` (500 EUR par défaut).

Chaque refus est enregistré (statut `REJECTED`, avec son motif), journalisé (`event: fraud_blocked`, avec l'IP, le compte et l'IBAN visés) et compté (`payments_fraud_blocked_total{reason}`). C'est le signal que la détection et le SIEM exploitent. Un virement entre comptes internes désignés par leur id n'est pas concerné.

**Transaction de test (canari).** Le rôle `svc:remediation-canary` (jeton du client `svc-remediation` d'`auth`) lit ses deux comptes (`GET /v1/accounts`, créés par le seed) et vire entre eux avec `X-Synthetic: true`. Ce rôle ne peut ni virer vers un IBAN ni omettre l'en-tête, et un client ne peut pas envoyer `X-Synthetic`. Les virements synthétiques sont marqués `synthetic: true`.

## Configuration

Copier [`.env.example`](.env.example) en `.env` (ignoré par git et par Docker, ne jamais le committer). Prisma 7 et Vitest ne lisent pas `.env` tout seuls : c'est branché dans `prisma.config.ts` (dotenv), `vitest.config.ts`, et `--env-file` pour `dev` et `seed:dev`. Dans Docker, les variables viennent de l'environnement du conteneur.

`AUTH_JWKS_URL` doit pointer vers le service `auth` : en local `http://localhost:3000/.well-known/jwks.json` (le `.env` utilise le port `3001` pour `api` afin de ne pas entrer en conflit avec `auth`).

## Développement

Première fois (depuis la racine du dépôt) :

```bash
npm run db:up                         # PostgreSQL local partagé (conteneur dev-db, port 54329)
npm run db:init                       # crée les bases de dev et de test de tous les services
(cd services/api && npx prisma migrate deploy)                                                                          # migre payments_dev
(cd services/api && DATABASE_URL=postgresql://postgres:test@localhost:54329/payments_test npx prisma migrate deploy)   # migre payments_test
npm run seed:dev -w services/api      # comptes du canari
```

Ensuite : `npm run dev -w services/api` (et `npm run dev -w services/auth` dans un autre terminal pour obtenir des jetons).

Changer le schéma : modifier `prisma/schema.prisma`, puis `npx prisma migrate dev --name <nom>` depuis `services/api`. Les contraintes SQL (solde positif, une seule destination, montant positif) sont ajoutées à la main dans la migration `init` : les conserver si on la régénère.

## Tests

Les tests d'intégration ont besoin de la base `payments_test` migrée (voir plus haut) et de `TEST_DATABASE_URL` dans `.env`. Sans cette variable, ils sont ignorés. Avec elle, ils échouent si la base n'est pas démarrée : lancer `npm run db:up` avant `npm test` (et avant un `git push`, car le hook `pre-push` lance les tests).

Ils vérifient notamment : l'atomicité des virements simultanés, l'idempotence (y compris concurrente), l'isolation entre clients, la règle anti-fraude (refus, journal, compteur, IP réelle), et les restrictions du canari. Un serveur JWKS local sert les clés de test, ce qui exerce la vraie vérification de jeton.

## Docker

Le contexte de build est la racine du dépôt (le service dépend de `packages/shared`) :

```bash
docker build -f services/api/Dockerfile -t resilience-api .
```

L'image applique les migrations au démarrage puis lance le service. Elle a un `HEALTHCHECK` sur `/healthz`. Le seed des comptes canari se lance dans le conteneur : `docker exec <conteneur> node dist/scripts/seed.js`.

## Limites assumées

- Le signal « ce compte vient de subir des échecs de connexion » (disponible dans `auth`) n'est pas encore utilisé par la règle anti-fraude. Il demanderait une route interne dans `auth`.
- Pas de limitation de débit : le flood éventuel est traité par le WAF et la remédiation.
- Les montants sont des entiers 32 bits en centimes (jusqu'à environ 21 millions d'euros par compte), suffisant pour un prototype.
