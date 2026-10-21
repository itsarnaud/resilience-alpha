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
| Assistant      | `/assistant`     | Question en langage naturel sur le projet, réponse avec sources citées (RAG, IA, `ml/ai-runtime`). |

## Comment il parle aux services

Comme le front : le navigateur n'appelle que sa propre origine, `/auth/...` et `/remediation/...`, que le WAF (ou Vite en développement) aiguille vers les bons services en retirant le préfixe. Seul `/v1/login` d'`auth` est utilisé (pas de connexion par visage : ce n'est pas le back-office).

**Assistant (IA, `/assistant/...`).** Contrairement à `/auth` et `/remediation`, l'API de l'assistant sert déjà ses routes sous ce préfixe (`POST /assistant/v1/chat`) : le WAF et Vite ne doivent **pas** le retirer, juste router vers le conteneur. Pas encore dans `docker-compose.dev.yml` (le service vient de `ml/ai-runtime`, pas de `services/*`) : à brancher avec l'IA une fois son conteneur prêt à rejoindre notre réseau `backend`. En développement, adresse par défaut `http://localhost:8012` (voir `ml/ai-runtime/deploy/AI_HANDOFF.md`), surchageable avec `ASSISTANT_URL`.

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

Le conteneur `dashboard` de [`infra/compose/docker-compose.dev.yml`](../../infra/compose/docker-compose.dev.yml) tourne derrière le WAF (voir la section [« Lancer toute la plateforme »](../../README.md#lancer-toute-la-plateforme-docker-compose) du README principal) : **http://localhost:8081**, appels `/auth` et `/remediation` fonctionnels. `/assistant` dépend du conteneur de l'IA, pas encore dans ce compose (voir plus haut). Si le WAF n'est pas lancé, `auth` et `remediation` restent joignables directement : `AUTH_URL=http://localhost:3010 REMEDIATION_URL=http://localhost:3002 npm run dev -w services/dashboard`.

## Vérifié en conditions réelles

Testé dans un vrai navigateur avec `auth`, `api` et `remediation`, à travers le WAF : connexion opérateur, un incident envoyé par un vrai jeton `svc:detector` apparaît sur la page Incidents sans recharger la page, sa chronologie complète (réception, validation de l'IP, blocage, vérification, transaction de test) s'affiche sur sa fiche, et il figure dans les IP bloquées.

**Pas encore vérifié :** la page Assistant (code et tests écrits, mais aucun conteneur `ml/ai-runtime` n'est encore lancé dans ce dépôt pour la tester en vrai).
