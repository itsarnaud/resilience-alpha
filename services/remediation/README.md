# remediation

Moteur de remédiation. Il reçoit les incidents signalés par le détecteur, exécute le playbook adapté, puis **prouve la reprise** avec une transaction de test (canari) sur l'API de paiement. Un conteneur qui redémarre ne suffit pas : l'incident n'est `RESOLVED` que si une vraie transaction réussit.

Contrat d'API : [`docs/api/remediation.openapi.yaml`](../../docs/api/remediation.openapi.yaml).

## Ce qui se passe quand un incident arrive

```
détecteur ──POST /v1/incidents──▶ politique ──▶ playbook ──▶ vérification ──▶ RESOLVED
                                     │             │              │
                                     ▼             ▼              ▼
                                  IGNORED     blocage WAF     services prêts ?
                                (signal trop    ou redémarrage  puis transaction de test
                                  faible)       d'un conteneur  (jusqu'à 5 essais)
                                                                      │
                                                          échec ──▶ playbook suivant, puis FAILED
```

1. **Réception** (`202`). Le détecteur n'attend pas : le traitement continue en arrière-plan. Un incident déjà en cours pour la même clé, ou résolu depuis moins de 60 s, est renvoyé tel quel (`200`).
2. **Politique.** Le score du détecteur est un indice, pas une certitude. En dessous de `MIN_SCORE`, ou pour un brute force avec moins de `MIN_FAILURES` échecs observés, ou pour un type sans playbook, l'incident passe à `IGNORED` et rien n'est fait.
3. **Playbook.** `block_source` (brute force, inondation) bloque l'IP source dans le WAF. `restart_service` (service tombé) redémarre le conteneur. Pour une inondation, si le blocage ne suffit pas, on passe au redémarrage.
4. **Vérification.** Les services supervisés répondent sur `/readyz`, puis un virement de 1 centime entre les deux comptes du canari réussit. Plusieurs essais, car un service qui redémarre met un moment à répondre.
5. **Résultat.** `RESOLVED` avec le temps de reprise, ou `FAILED` avec la raison. Un échec n'est jamais silencieux. Chaque étape est dans la chronologie de l'incident, dans les logs (`event: remediation_step`) et dans le flux temps réel.

## Garde-fous

- **Seul le détecteur** (`svc:detector`) peut signaler un incident. Opérateurs et dashboard ne peuvent que lire.
- **L'IP est validée strictement** (IPv4 ou IPv6, rien d'autre) à la réception, et une seconde fois avant d'être écrite dans la liste du WAF : une valeur comme `1.2.3.4; deny all` ne peut pas se glisser dans la configuration.
- **IP protégées** (`PROTECTED_IPS` : l'hôte, la boucle locale) : jamais bloquées, même sur un signalement à score maximal. Un faux positif ne doit pas couper la passerelle.
- **Un blocage raté n'est jamais « confirmé »** par le simple fait que le service répond : la vérification n'a lieu que si l'action a réussi.
- **Docker :** accès uniquement par le proxy filtré (`DOCKER_HOST`), jamais le socket brut, et seulement pour les conteneurs de `ALLOWED_CONTAINERS`. La liste est vérifiée aussi dans le code, en plus du filtrage du proxy. Sans `DOCKER_HOST`, tout redémarrage échoue proprement et visiblement.
- **Blocages temporaires** (`BLOCK_DURATION_SECONDS`, 5 minutes par défaut) : levés automatiquement à l'échéance, même après un redémarrage de la remédiation (ils sont en base).
- **Reprise après redémarrage :** les incidents laissés en cours sont repris au démarrage.

## Routes

| Route                                       | Rôles                       | Description                                             |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------- |
| `POST /v1/incidents`                        | `svc:detector`              | Signale un incident.                                    |
| `GET /v1/incidents`, `/:id`                 | `operator`, `svc:dashboard` | Liste et détail, avec la chronologie des étapes.        |
| `GET /v1/incidents/stream`                  | `operator`, `svc:dashboard` | Flux temps réel (SSE), voir ci-dessous.                 |
| `GET /v1/playbooks`, `/services`, `/blocks` | `operator`, `svc:dashboard` | Playbooks, état des services, IP actuellement bloquées. |
| `DELETE /v1/blocks/:id`                     | `operator`                  | Lève un blocage avant son échéance (bouton « Débloquer » du dashboard). `404` si déjà levé ou inconnu. |
| `GET /healthz`, `/readyz`, `/metrics`       | publiques (réseau interne)  | Santé, disponibilité (la base répond), métriques.       |

**Flux temps réel.** À la connexion, un événement `snapshot` (les 20 derniers incidents), puis un événement `incident` à chaque étape ou changement d'état. `EventSource` ne sait pas envoyer l'en-tête `Authorization` : le dashboard doit lire le flux avec `fetch` et son `ReadableStream`.

## Structure

Même organisation que `services/auth` et `services/api`.

```
src/
├── index.ts, app.ts, router.ts
├── routes/           health, incidents, supervision
├── controllers/      valide l'entrée, appelle le service, formate la réponse
├── services/         IncidentsServices (création, états), EngineServices (playbooks,
│                     vérification), BlocksServices (blocages), ActionsServices (chronologie),
│                     ServicesStatus
├── middlewares/      auth : vérifie le JWT avec les clés publiques d'auth (JWKS)
├── schemas/          requêtes
└── lib/              config, logger, prisma, metrics, context, dto, events,
                      playbooks (définitions et politique), platform (appels à auth et api),
                      waf (liste de blocage), docker (redémarrages)
prisma/               schéma et migrations
test/                 tests d'intégration
```

Deux adaptateurs isolent ce qui dépend d'autres équipes : `lib/waf.ts` (comment le WAF reçoit sa liste de blocage) et `lib/docker.ts` (accès à Docker). Si le mécanisme du WAF change, seul `waf.ts` change.

## Configuration

Copier [`.env.example`](.env.example) en `.env` (ignoré par git et par Docker, ne jamais le committer). `REMEDIATION_CLIENT_SECRET` doit être le même secret que `SEED_SVC_REMEDIATION_SECRET` du service `auth` : c'est notre identité pour obtenir un jeton de service.

En local, `auth` écoute sur 3000, `api` sur 3001 et `remediation` sur 3002 (voir le `.env`).

## Développement

Première fois (depuis la racine) :

```bash
npm run db:up && npm run db:init                                                                     # PostgreSQL local, toutes les bases
(cd services/remediation && npx prisma migrate deploy)                                               # remediation_dev
(cd services/remediation && DATABASE_URL=postgresql://postgres:test@localhost:54329/remediation_test npx prisma migrate deploy)
```

Ensuite : `npm run dev -w services/remediation`. En local, la liste de blocage est écrite dans `services/remediation/waf/denylist.conf` (ignoré par git).

Changer le schéma : modifier `prisma/schema.prisma`, puis `npx prisma migrate dev --name <nom>` depuis `services/remediation`. Deux contraintes sont ajoutées à la main dans la migration `init` (un seul blocage actif par IP, un seul incident actif par clé) : les conserver si on la régénère.

## Tests

Les tests d'intégration ont besoin de `remediation_test` migrée et de `TEST_DATABASE_URL` dans `.env`. Sans cette variable, ils sont ignorés. Avec elle, ils échouent si la base n'est pas démarrée : lancer `npm run db:up` avant `npm test` (et avant un `git push`, par convention — aucun hook ne les lance automatiquement).

`auth` et `api` sont simulés par un petit serveur HTTP, ce qui permet de provoquer des pannes précises (transaction de test qui échoue N fois, service qui ne répond plus). La liste de blocage est un vrai fichier ; Docker est simulé.

## Docker

Le contexte de build est la racine du dépôt :

```bash
docker build -f services/remediation/Dockerfile -t resilience-remediation .
```

Le dossier `/waf` est un volume : il doit être monté **à la fois** sur la remédiation (écriture) et sur le WAF (lecture), à `WAF_DENYLIST_FILE`.

**Via Docker Compose** (toute la plateforme, pas seulement `remediation`) : voir la section [« Lancer toute la plateforme »](../../README.md#lancer-toute-la-plateforme-docker-compose) du README principal. `DOCKER_HOST` y pointe déjà vers `docker-socket-proxy` (pile infra) et le volume `/waf` est créé (`resilience-alpha_waf_denylist`) : il ne reste que le WAF lui-même (pile cyber) à brancher dessus pour qu'un blocage soit réellement appliqué.

## Ce qui reste à confirmer avec les autres équipes

- **Cyber :** le WAF doit lire `WAF_DENYLIST_FILE` (dans la version actuelle : des lignes `deny <ip>;` à inclure dans la configuration nginx), monter le même volume (`resilience-alpha_waf_denylist`) et se recharger quand il change. Soit via `WAF_RELOAD_CONTAINER` (signal `HUP` envoyé par le proxy Docker), soit par un mécanisme de surveillance côté WAF. Le format est dans `lib/waf.ts`.
- **IA :** le détecteur envoie `POST /v1/incidents` avec un jeton `svc:detector` (client `svc-detector` d'`auth`). Champs : voir le contrat.

## Limites assumées

- La transaction de test appelle l'API **directement** (`API_URL`), pas à travers le WAF : elle prouve que l'API fonctionne, pas que le chemin public est rétabli. Pointer `API_URL` vers le WAF le ferait, à condition que l'IP de la remédiation ne soit pas bloquée.
- Un seul exemplaire de la remédiation : les incidents sont verrouillés en mémoire, pas en base.
