# backoffice

Application d'administration du SI de paiement. Connexion renforcée en trois étapes (identifiant, visage, mot de passe), avec LED simulée à l'écran, puis gestion des habilitations : comptes, rôles, enrôlement d'un visage, déblocage.

C'est la réponse à la « consigne additionnelle 1 » du sujet. React 19, TypeScript, Vite, Tailwind CSS 4, React Router. Réservé aux comptes de rôle `admin`.

## La connexion

1. **Identifiant.** Ouvre une tentative côté serveur (`POST /v1/backoffice/login`), valable 2 minutes.
2. **Visage.** Dès cette étape, la caméra s'active (`getUserMedia`) ; un bouton prend une photo et l'envoie (`lib/camera.ts`, capture JPEG via `<canvas>`). Reconnu : passage au mot de passe, LED verte clignotante. Non reconnu : LED rouge fixe 30 s, retour automatique à l'identifiant (vidé).
3. **Mot de passe.** Bon : jeton obtenu, LED verte fixe, puis redirection vers les habilitations. Faux : LED rouge clignotante, retour automatique à l'identifiant après quelques secondes.

Toute la logique (verrouillage, délais, ce qui suit quoi) est côté serveur (`services/auth`) : cette page ne fait qu'afficher ce qu'il répond et gérer la caméra. La LED affichée ici est une **simulation locale** : la vraie LED est pilotée par `auth` sur MQTT, vers l'ESP8266.

**Important :** `getUserMedia` exige un contexte sécurisé (HTTPS ou `localhost`). Pendant la démo, cette page doit être ouverte depuis le navigateur du **PC Hôte**, sinon la caméra utilisée ne serait pas la bonne, ou l'accès serait refusé.

## Habilitations

Après connexion :

- **Créer un compte** (email, mot de passe, rôles).
- **Modifier les rôles et l'activation** d'un compte, en cases à cocher.
- **Enrôler un visage** : une fenêtre ouvre la caméra, capture une photo, l'envoie (`POST /v1/admin/users/:id/face`). Un refus « aucun visage détecté » est affiché sans casser l'écran.
- **Débloquer un identifiant** verrouillé par le parcours de connexion.

Le serveur applique les règles de sécurité (dernier administrateur non retirable, pas d'auto-modification) : cette page ne fait qu'afficher ses refus.

## Développement

```bash
npm run db:up && npm run db:init     # PostgreSQL local (racine du dépôt), une fois
npm run dev -w services/auth         # port 3000
npm run dev -w services/backoffice   # port 5175 -> http://localhost:5175
```

Connexion : le compte `admin` du seed d'`auth` (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`). En développement, `auth` tourne avec `FACE_VERIFIER=stub` : la reconnaissance est simulée (tout le monde est reconnu), donc une vraie photo n'est pas nécessaire pour tester le parcours.

```bash
npm test -w services/backoffice
npm run typecheck -w services/backoffice
npm run build -w services/backoffice
```

## Structure

```
src/
├── main.tsx, App.tsx       point d'entrée et routes
├── pages/                  LoginPage (parcours en étapes), UsersPage (habilitations)
├── components/             Layout, Protected (rôle admin), LedIndicator (simulation), ui
├── lib/                    api (appels à auth), camera (capture), session (JWT),
│                           useCountdown (délais de retour automatique), useLoad
└── test/
nginx.conf, Dockerfile      image nginx sans privilèges, sans Node
```

## Vérifié en conditions réelles

Testé dans un vrai navigateur avec un vrai `auth` : connexion en trois étapes avec une vraie capture de caméra (photo envoyée en JPEG et acceptée par le serveur), arrivée sur les habilitations, enrôlement d'un visage pour un compte existant, déblocage d'un identifiant.

## Point corrigé pendant le développement

Le minuteur qui ramène automatiquement à l'identifiant après un refus (30 s pour un visage, quelques secondes pour un mot de passe) avait un défaut : la remise à zéro pouvait se déclencher **immédiatement** après le refus, avant que la personne n'ait eu le temps de lire le message, à cause d'une course entre deux rendus React. Trouvé par les tests, corrigé en faisant déclencher la fin du délai par le minuteur lui-même plutôt que par une comparaison faite ailleurs dans le code (`lib/useCountdown.ts`).

## Docker

```bash
docker build -f services/backoffice/Dockerfile -t resilience-backoffice .
docker run -p 8080:8080 resilience-backoffice
```

**Côté WAF :** route vers ce conteneur, et `/auth/*` vers `auth`, préfixe retiré. **Fait**, sur son propre port (voir ci-dessous).

## Avec Docker Compose (toute la plateforme)

Le conteneur `backoffice` de [`infra/compose/docker-compose.dev.yml`](../../infra/compose/docker-compose.dev.yml) tourne derrière le WAF (voir la section [« Lancer toute la plateforme »](../../README.md#lancer-toute-la-plateforme-docker-compose) du README principal) : **http://localhost:8082**. Identifiant et mot de passe passent. Si le WAF n'est pas lancé (pile cyber), `auth` reste joignable directement pour tester sans lui : `AUTH_URL=http://localhost:3010 npm run dev -w services/backoffice` fonctionne (Vite bascule sur un port libre si `5175` est pris par le conteneur).

### Limite connue avec le WAF (en cours de correction côté cyber)

L'étape photo envoie un corps `Content-Type: image/jpeg`, que les règles OWASP CRS par défaut n'autorisent pas (anomalie bloquante, **403**). L'exception prévue dans `custom-before.conf` (passer cette route en `DetectionOnly`) ciblait encore l'ancien chemin `/api/auth` au lieu de `/auth/v1/backoffice/login/:id/face` : signalé à la cyber le 2026-10-21, correctif transmis. En attendant, tester la photo en direct sur l'auth exposé (`:3010`), pas à travers le WAF.

## Limites assumées

- La reconnaissance faciale dépend entièrement du service `ml/face` (IA) : pas d'authentification sur ses routes à ce jour, à corriger avant la démo (voir `ml/face/README.md`).
- Pas de suppression d'un visage enrôlé (le service de l'IA n'a pas cette route).
- La LED affichée est une simulation locale : elle ne prouve pas que l'ESP8266 physique reçoit le bon état, seulement que `auth` a décidé de le publier.
