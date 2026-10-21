# auth

Service d'authentification : comptes utilisateurs, connexion, émission des JWT (RS256), jetons pour les services (client credentials) et publication des clés publiques (JWKS).

Contrat d'API : [`docs/api/auth.openapi.yaml`](../../docs/api/auth.openapi.yaml).

## Routes

| Route                                                      | Description                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /v1/register`                                        | Crée un compte `customer` (mot de passe de 12 caractères minimum).             |
| `POST /v1/login`                                           | Connexion d'un client, renvoie un JWT. Refuse les comptes `admin`.             |
| `POST /v1/token`                                           | Jeton de service (`client_id`, `client_secret`).                               |
| `GET /v1/me`                                               | Profil du porteur du jeton.                                                    |
| `GET /.well-known/jwks.json`                               | Clés publiques, utilisées par `api` et `remediation`.                          |
| `GET /healthz`, `/readyz`                                  | Santé (processus) et disponibilité (base de données).                          |
| `GET /metrics`                                             | Métriques Prometheus.                                                          |
| `POST /v1/backoffice/login` et suite                       | Connexion du back-office : identifiant, photo, mot de passe (voir ci-dessous). |
| `GET /v1/devices/led`                                      | État courant de la LED (`operator`, `svc:dashboard`, `admin`).                 |
| `GET`, `POST /v1/admin/users`, `PATCH /v1/admin/users/:id` | Habilitations (`admin`).                                                       |
| `POST /v1/admin/users/:id/face`                            | Enrôle un visage pour ce compte (`admin`).                                     |
| `DELETE /v1/admin/lockouts/:identifier`                    | Débloque un identifiant (`admin`).                                             |

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

lib/ contient aussi face (reconnaissance faciale) et mqtt (publication de la LED) ; services/ contient
BackofficeServices (parcours), LockoutServices (verrouillage) et LedServices (état de la LED).
prisma/               schéma et migrations
test/                 tests d'intégration
```

## Connexion du back-office

Réservée aux comptes de rôle `admin`. Trois étapes, toutes gérées côté serveur : le navigateur ne décide de rien.

```
POST /v1/backoffice/login                 { identifier }      -> 201 { session_id, state: IDENTIFIED }
POST /v1/backoffice/login/:id/face        (image/jpeg|png)    -> 200 PASSWORD_PENDING | 401 face_not_recognized
POST /v1/backoffice/login/:id/password    { password }        -> 200 { access_token, state: GRANTED } | 401 wrong_password
GET  /v1/backoffice/login/:id                                 -> état courant
```

- **Une tentative sert une fois** : un visage, un mot de passe. Après un refus, il faut en ouvrir une nouvelle (identifiant ressaisi), comme l'exige la consigne. La tentative expire au bout de 2 minutes, sans compter comme un échec.
- **Verrouillage par identifiant**, en base : deux échecs de suite (visage ou mot de passe) bloquent l'identifiant 5 minutes ; chaque verrouillage suivant double la durée, jusqu'à une heure ; un succès remet tout à zéro. Après un refus, un délai court (30 s après un visage refusé, 6 s après un mot de passe refusé) empêche de ressaisir l'identifiant tout de suite. Les lignes sont verrouillées pendant le calcul : des échecs envoyés en parallèle ne se perdent pas.
- **Aucune fuite sur les comptes.** Un identifiant inconnu, un client ou un compte désactivé suivent le même parcours, échouent à l'étape du visage, se verrouillent de la même façon, et la réponse met le même temps (`FACE_MIN_DELAY_MS`). Le service de visage n'est appelé que pour un vrai compte `admin`.
- **Une panne du service de visage n'est pas un échec** : `503`, rien n'est compté, rien n'est verrouillé.
- **Contournement impossible par l'autre porte** : un compte `admin` ne peut pas se connecter par `/v1/login`.
- **La photo** est lue en binaire (1 Mo au plus), son format est vérifié sur les premiers octets, et elle n'est jamais conservée ni journalisée.
- Le jeton émis porte `roles: [admin]` et `amr: [face, pwd]`.

### Reconnaissance faciale

`lib/face.ts` isole le service. Deux modes (`FACE_VERIFIER`) :

- `stub` (développement) : tout le monde est reconnu, ou personne (`FACE_STUB_RESULT=match|nomatch`). **Refusé en production.**
- `http` : appelle le service de l'IA, rangé dans `ml/face` (`FACE_SERVICE_URL`, `http://face:5000` par défaut) : `POST /recognize` avec `{ "user": "<identifiant du compte>", "image": "<photo en base64>" }`, réponse `{ "recognized": true, "distance": 0.31, "threshold": 0.6 }`. `distance` : plus elle est petite, plus les visages se ressemblent ; elle est conservée pour l'enquête (`backoffice_logins.face_distance`).

  Un visage différent, un identifiant jamais enregistré ou une photo sans visage répondent `recognized: false` : ce sont des **refus**. Une erreur serveur, une réponse illisible, un délai dépassé ou un service arrêté sont des **pannes** (`503`, rien n'est compté, rien n'est verrouillé).

  L'identifiant envoyé est celui du compte : c'est la clé sous laquelle le visage doit avoir été enregistré (`POST /enroll`).

### LED (ESP8266)

`auth` publie l'état sur MQTT, sujet `resilience/led`, avec les messages du firmware (`iot/esp8266-led`) : `green-blink`, `green-solid`, `red-blink`, `red-solid`, `off`.

| Moment               | Message       | Retour à `off`                                     |
| -------------------- | ------------- | -------------------------------------------------- |
| visage reconnu       | `green-blink` | à l'expiration de la tentative                     |
| connexion réussie    | `green-solid` | après 30 s                                         |
| mot de passe refusé  | `red-blink`   | après quelques secondes (le firmware fait 10 fois) |
| visage non reconnu   | `red-solid`   | après 30 s                                         |
| démarrage du service | `off`         |                                                    |

La LED est un signal, pas une condition d'accès : une panne du broker est journalisée (`led_publish_failed`) et comptée (`auth_led_publish_total{result="failed"}`) mais ne bloque jamais une connexion, et la publication n'est jamais attendue par la requête. Un nouvel état annule l'échéance de l'ancien. Pas de message conservé (`retain`).

**Broker.** Sans `MQTT_URL`, la LED n'est pas pilotée. En démo, le broker doit exiger un identifiant : sans cela, n'importe qui sur le réseau du labo pourrait publier `green-solid`. Droits attendus : l'utilisateur d'`auth` peut **écrire** sur `resilience/led`, celui de l'ESP seulement **lire**. Exemple Mosquitto (vérifié) :

```
# mosquitto.conf                # acl
listener 1883                   user auth
allow_anonymous false           topic write resilience/led
password_file .../passwd
acl_file .../acl                user esp
                                topic read resilience/led
```

### Habilitations

Réservées aux comptes `admin`. `services/AdminServices.ts` :

- **Lister, créer, modifier.** Un compte créé ou modifié a des rôles parmi `customer`, `operator`, `admin` : jamais un rôle de service (`svc:...`), refusé par le schéma.
- **Le dernier administrateur actif ne peut pas être retiré** (ni par perte du rôle, ni par désactivation) : on se couperait l'accès au back-office. Un administrateur ne peut pas non plus modifier ses propres habilitations, pour éviter de se bloquer par erreur ou de s'auto-promouvoir en silence.
- **Enrôlement d'un visage** : `POST /v1/admin/users/:id/face`, même validation de la photo que pour la connexion. Enregistré sous l'email du compte (la clé utilisée à la connexion). Une photo sans visage détectable renvoie `422`, propre, sans panne ; une panne du service renvoie `503`.
- **Déblocage** d'un identifiant verrouillé, avant son échéance.
- Chaque action est journalisée (`admin_user_created`, `admin_user_updated`, `admin_face_enrolled`, `admin_lockout_cleared`), avec qui l'a faite.

Pas de suppression d'un visage (le service de l'IA n'a pas cette route) : limite documentée dans `ml/face/README.md`.

### Journalisation (observabilité)

Chaque étape est un événement JSON : `backoffice_login_started`, `backoffice_face_result` (avec le score), `backoffice_login_failed` (`stage`: `face` ou `password`, `locked`, `lock_level`), `backoffice_login_blocked`, `backoffice_login_succeeded`, `led_state_changed`, `led_publish_failed`, `face_service_unavailable`. Métriques : `auth_backoffice_logins_total{result}`, `auth_backoffice_lockouts_total`, `auth_led_publish_total{result}`.

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

| Variables                                       | Crée                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `SEED_OPERATOR_EMAIL`, `SEED_OPERATOR_PASSWORD` | utilisateur `operator` (dashboard)                           |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`       | compte du back-office (rôle `admin` : visage + mot de passe) |
| `SEED_VICTIM_EMAIL`, `SEED_VICTIM_PASSWORD`     | compte visé par le brute force (mot de passe faible voulu)   |
| `SEED_SVC_DETECTOR_SECRET`                      | client `svc-detector` (`svc:detector`)                       |
| `SEED_SVC_DASHBOARD_SECRET`                     | client `svc-dashboard` (`svc:dashboard`)                     |
| `SEED_SVC_REMEDIATION_SECRET`                   | client `svc-remediation` (`svc:remediation-canary`)          |

```bash
npm run seed:dev -w services/auth          # en développement (tsx)
docker exec <conteneur> node dist/scripts/seed.js   # dans l'image
```

## Tests

Les tests d'intégration ont besoin de la base `auth_test` migrée (voir plus haut) et de `TEST_DATABASE_URL` dans `.env`. Sans cette variable, ils sont ignorés. Avec elle, ils échouent si la base n'est pas démarrée : lancer `npm run db:up` avant `npm test` (et avant un `git push`, par convention — aucun hook ne les lance automatiquement).

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

**Via Docker Compose** (toute la plateforme, pas seulement `auth`) : voir la section [« Lancer toute la plateforme »](../../README.md#lancer-toute-la-plateforme-docker-compose) du README principal. `JWT_PRIVATE_KEY_FILE` y est monté depuis `services/auth/keys/jwt.pem` (à générer une fois, voir plus haut) ; `FACE_VERIFIER=http` y est obligatoire (le conteneur refuse de démarrer sinon, `NODE_ENV=production`).

## Choix de sécurité à connaître

- **Pas de verrouillage de compte ni de limitation de débit.** Volontaire pour le scénario de démonstration : le brute force doit pouvoir aboutir, il est détecté par le ML et traité par la remédiation (blocage de l'IP dans le WAF). Un service de production ajouterait ces protections.
- Le même message d'erreur et le même temps de réponse sont renvoyés pour un compte inconnu et un mauvais mot de passe.
- L'IP vient de `X-Forwarded-For`, mais seule l'adresse ajoutée par le proxy de confiance est retenue (`TRUST_PROXY`) : un en-tête forgé par l'attaquant est ignoré.
- Les mots de passe sont hachés avec bcrypt (sel intégré à l'empreinte, coût réglable avec `BCRYPT_ROUNDS`, 10 par défaut) et ne sont jamais journalisés. bcrypt ignore ce qui dépasse 72 octets : l'inscription refuse les mots de passe plus longs.
- Chaque tentative est enregistrée dans la table `login_attempts` (compte visé, IP, résultat) en plus du log JSON.
