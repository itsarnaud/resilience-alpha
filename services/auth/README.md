# auth

Service d'authentification : comptes utilisateurs, connexion, émission des JWT (RS256), jetons pour les services (client credentials) et publication des clés publiques (JWKS).

Contrat d'API : [`docs/api/auth.openapi.yaml`](../../docs/api/auth.openapi.yaml).

## Routes

| Route                        | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `POST /v1/register`          | Crée un compte `customer` (mot de passe de 12 caractères minimum). |
| `POST /v1/login`             | Connexion, renvoie un JWT. Journalise chaque échec.                |
| `POST /v1/token`             | Jeton de service (`client_id`, `client_secret`).                   |
| `GET /v1/me`                 | Profil du porteur du jeton.                                        |
| `GET /.well-known/jwks.json` | Clés publiques, utilisées par `api` et `remediation`.              |
| `GET /healthz`, `/readyz`    | Santé (processus) et disponibilité (base de données).              |
| `GET /metrics`               | Métriques Prometheus.                                              |

Le service écoute à la racine (`/v1/...`) : le WAF doit retirer le préfixe `/auth` avant de transmettre.

## Structure

Même organisation que les autres projets Express de l'équipe : `app`, `router`, `routes`, `controllers`, `services`, `middlewares`, `schemas`, `lib`. Fonctions exportées et imports directs.

```
src/
├── index.ts          point d'entrée : démarre le serveur, arrêt propre
├── app.ts            application Express (middlewares, router, erreurs)
├── router.ts         monte les routes
├── routes/           URLs : health, auth (login, token), users (register, me)
├── controllers/      valide l'entrée (zod), appelle le service, formate la réponse
├── services/         logique métier : AuthServices, UsersServices
├── middlewares/      auth : exige un JWT valide
├── schemas/          corps de requête (zod)
├── lib/              config, logger, prisma, keys (JWT), password (bcrypt),
│                     metrics, roles, context
└── scripts/          seed (données de démonstration)
prisma/               schéma et migrations
test/                 tests d'intégration
```

## Configuration

Copier [`.env.example`](.env.example) en `.env` (ignoré par git et par Docker, ne jamais le committer). Dans Docker, les variables viennent de l'environnement du conteneur.

En production, `JWT_PRIVATE_KEY` (ou `JWT_PRIVATE_KEY_FILE`) est obligatoire. Sans clé en développement, une clé éphémère est générée : les jetons ne survivent pas à un redémarrage. Générer une clé :

```bash
mkdir -p keys && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/jwt.pem   # ignoré par git
```

## Développement

Première fois :

```bash
npm run db:up      # démarre PostgreSQL (conteneur `dev-db` partagé par tous les services, port 54329)
npm run db:init    # crée les bases de dev et de test de tous les services
(cd services/auth && npx prisma migrate deploy)                                                  # migre auth_dev
(cd services/auth && DATABASE_URL=postgresql://postgres:test@localhost:54329/auth_test npx prisma migrate deploy)   # migre auth_test
npm run seed:dev -w services/auth   # comptes de démonstration
```

Ensuite : `npm run db:up` puis `npm run dev -w services/auth`. `npm run db:down` (racine) supprime le conteneur et ses données.

Changer le schéma : modifier `prisma/schema.prisma`, puis `npx prisma migrate dev --name <nom>` depuis `services/auth`. Prisma 7 ne régénère plus le client automatiquement : `npm run generate -w services/auth` (le `build`, `typecheck` et `test` le font déjà).

## Données de démonstration

`seed` crée les comptes à partir de variables d'environnement. Aucun secret n'est dans le dépôt, et chaque bloc est ignoré si ses variables manquent.

| Variables                                       | Crée                                                       |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `SEED_OPERATOR_EMAIL`, `SEED_OPERATOR_PASSWORD` | utilisateur `operator` (dashboard)                         |
| `SEED_VICTIM_EMAIL`, `SEED_VICTIM_PASSWORD`     | compte visé par le brute force (mot de passe faible voulu) |
| `SEED_SVC_DETECTOR_SECRET`                      | client `svc-detector` (`svc:detector`)                     |
| `SEED_SVC_DASHBOARD_SECRET`                     | client `svc-dashboard` (`svc:dashboard`)                   |
| `SEED_SVC_REMEDIATION_SECRET`                   | client `svc-remediation` (`svc:remediation-canary`)        |

```bash
npm run seed:dev -w services/auth          # en développement (tsx)
docker exec <conteneur> node dist/scripts/seed.js   # dans l'image
```

## Tests

Les tests d'intégration ont besoin de la base `auth_test` migrée (voir plus haut) et de `TEST_DATABASE_URL` dans `.env`. Sans cette variable, ils sont ignorés. Avec elle, ils échouent si la base n'est pas démarrée : lancer `npm run db:up` avant `npm test` (et avant un `git push`, car le hook `pre-push` lance les tests).

```bash
npm run db:up
npm test -w services/auth
```

## Docker

Le contexte de build est la racine du dépôt (le service dépend de `packages/shared`) :

```bash
docker build -f services/auth/Dockerfile -t resilience-auth .
```

L'image applique les migrations au démarrage puis lance le service. Elle a un `HEALTHCHECK` sur `/healthz`.

## Choix de sécurité à connaître

- **Pas de verrouillage de compte ni de limitation de débit.** Volontaire pour le scénario de démonstration : le brute force doit pouvoir aboutir, il est détecté par le ML et traité par la remédiation (blocage de l'IP dans le WAF). Un service de production ajouterait ces protections.
- Le même message d'erreur et le même temps de réponse sont renvoyés pour un compte inconnu et un mauvais mot de passe.
- L'IP vient de `X-Forwarded-For`, mais seule l'adresse ajoutée par le proxy de confiance est retenue (`TRUST_PROXY`) : un en-tête forgé par l'attaquant est ignoré.
- Les mots de passe sont hachés avec bcrypt (sel intégré à l'empreinte, coût réglable avec `BCRYPT_ROUNDS`, 10 par défaut) et ne sont jamais journalisés. bcrypt ignore ce qui dépasse 72 octets : l'inscription refuse les mots de passe plus longs.
- Chaque tentative est enregistrée dans la table `login_attempts` (compte visé, IP, résultat) en plus du log JSON.
