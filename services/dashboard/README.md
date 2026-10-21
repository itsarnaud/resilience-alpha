# dashboard

Supervision du système, pour le jury : état des services, incidents en temps réel avec leur chronologie, IP bloquées, état de la LED. C'est la preuve visuelle que la reprise est automatique : on y voit l'état avant, pendant et après un incident.

React 19, TypeScript, Vite, Tailwind CSS 4, React Router. Réservé aux comptes de rôle `operator`.

## Pages

| Page           | Adresse          | Ce qu'on y voit                                                           |
| -------------- | ---------------- | ------------------------------------------------------------------------- |
| Connexion      | `/login`         | Connexion d'un opérateur.                                                 |
| Vue d'ensemble | `/`              | Services supervisés (en ligne ou non, dernière transaction de test), LED. |
| Incidents      | `/incidents`     | Liste en temps réel, état de chacun.                                      |
| Détail         | `/incidents/:id` | Fiche complète et chronologie étape par étape, en direct.                 |
| IP bloquées    | `/blocages`      | Blocages actifs dans le WAF, avec lien vers l'incident.                   |

## Comment il parle aux services

Comme le front : le navigateur n'appelle que sa propre origine, `/auth/...` et `/remediation/...`, que le WAF (ou Vite en développement) aiguille vers les bons services en retirant le préfixe. Seul `/v1/login` d'`auth` est utilisé (pas de connexion par visage : ce n'est pas le back-office).

**Flux temps réel.** `GET /v1/incidents/stream` (remédiation) envoie un instantané puis chaque changement en Server-Sent Events. `EventSource` ne sait pas envoyer l'en-tête `Authorization` : le flux est donc lu à la main avec `fetch` et son `ReadableStream` (`lib/sse.ts`, `lib/useIncidentStream.ts`). Une coupure (service redémarré, réseau) relance la connexion automatiquement, avec un délai qui augmente à chaque essai.

## Développement

```bash
npm run db:up && npm run db:init            # PostgreSQL local (racine du dépôt), une fois
npm run dev -w services/auth                # port 3000
npm run dev -w services/api                 # port 3001 (comptes du canari)
npm run dev -w services/remediation         # port 3002
npm run dev -w services/dashboard           # port 5174 -> http://localhost:5174
```

Connexion : le compte `operator` du seed d'`auth` (`SEED_OPERATOR_EMAIL` / `SEED_OPERATOR_PASSWORD`).

```bash
npm test -w services/dashboard
npm run typecheck -w services/dashboard
npm run build -w services/dashboard
```

## Structure

```
src/
├── main.tsx, App.tsx       point d'entrée et routes
├── pages/                  une page par écran
├── components/             Layout, Protected (rôle operator), StateBadge, LedIndicator, ui
├── lib/                    api (appels), sse (analyseur SSE générique), useIncidentStream
│                           (flux avec reconnexion), session (JWT), useLoad
└── test/
nginx.conf, Dockerfile      image nginx sans privilèges, sans Node
```

## Docker

```bash
docker build -f services/dashboard/Dockerfile -t resilience-dashboard .
docker run -p 8080:8080 resilience-dashboard
```

**À prévoir côté WAF :** router `/` vers ce conteneur, `/remediation/*` vers la remédiation et `/auth/*` vers `auth`, préfixe retiré. Sans cela la page s'affiche mais rien ne se charge.

## Avec Docker Compose (toute la plateforme)

Le conteneur `dashboard` de [`infra/compose/docker-compose.dev.yml`](../../infra/compose/docker-compose.dev.yml) tourne (voir la section [« Lancer toute la plateforme »](../../README.md#lancer-toute-la-plateforme-docker-compose) du README principal), mais tant que le WAF (pile cyber) n'est pas branché, ses appels `/auth` et `/remediation` échouent — c'est attendu. Pour tester quand même, `auth` et `remediation` sont publiés sur l'hôte (`3010` et `3002`) : `AUTH_URL=http://localhost:3010 REMEDIATION_URL=http://localhost:3002 npm run dev -w services/dashboard` fonctionne contre les vrais conteneurs.

## Vérifié en conditions réelles

Testé dans un vrai navigateur avec `auth`, `api` et `remediation` : connexion opérateur, un incident envoyé par un vrai jeton `svc:detector` apparaît sur la page Incidents sans recharger la page, sa chronologie complète (réception, validation de l'IP, blocage, vérification, transaction de test) s'affiche sur sa fiche, et il figure dans les IP bloquées.
