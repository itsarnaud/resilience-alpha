# front

Espace client de la banque fictive : connexion, comptes, virements, bénéficiaires, historique. Il sert aussi à prouver la reprise : un virement réussit avant l'incident, et réussit de nouveau après.

React 19, TypeScript, Vite, Tailwind CSS 4, React Router. Aucune donnée réelle : IBAN et soldes sont fictifs.

## Pages

| Page          | Adresse          | Ce qu'on y fait                                                          |
| ------------- | ---------------- | ------------------------------------------------------------------------ |
| Connexion     | `/login`         | Se connecter ou créer un compte client.                                  |
| Comptes       | `/`              | Voir ses soldes et IBAN, ouvrir un compte (1 000 € fictifs).             |
| Virement      | `/virement`      | Virer vers un IBAN. Les refus anti-fraude sont expliqués.                |
| Bénéficiaires | `/beneficiaires` | Ajouter les IBAN autorisés. Un virement vers un IBAN inconnu est refusé. |
| Historique    | `/historique`    | Opérations exécutées et refusées (avec le motif), par pages.             |

Les pages, hors connexion, ne s'ouvrent qu'avec un compte `customer`. Un compte d'administration est refusé : le back-office a sa propre connexion.

## Comment il parle aux services

Le navigateur n'appelle que sa propre origine : `/auth/...` pour le service `auth` et `/api/...` pour l'API de paiement. Le WAF aiguille chaque préfixe vers le bon service **en le retirant** (`/api/v1/accounts` arrive sur l'API en `/v1/accounts`). En développement, c'est Vite qui joue ce rôle (voir `vite.config.ts`).

Il n'y a donc aucune adresse de service dans le code, et aucun secret : le seul élément sensible est le jeton de session (JWT), gardé dans `sessionStorage` (il disparaît à la fermeture de l'onglet). Un `401` de l'API ferme la session et renvoie vers la connexion.

## Points à connaître

- **Virement sans double débit.** Chaque demande porte une `Idempotency-Key`. Si la réponse se perd (réseau coupé), un nouvel envoi réutilise la même clé et ne débite pas deux fois. La clé n'est renouvelée qu'après une réponse définitive.
- **HTTP sur le réseau du labo.** `crypto.randomUUID` n'existe qu'en contexte sécurisé (HTTPS ou `localhost`). Quand le front est servi en HTTP depuis le PC Hôte, `lib/uuid.ts` utilise `getRandomValues` à la place.
- **Montants.** Ils circulent en centimes (entiers) ; la saisie « 12,50 » est convertie sans flottant.
- **En-têtes de sécurité** (`nginx.conf`) : CSP restrictive (`default-src 'self'`), pas d'intégration dans une iframe, pas de détection de type.

## Développement

```bash
npm run db:up && npm run db:init                 # PostgreSQL local (racine du dépôt), une fois
npm run dev -w services/auth                     # port 3000
npm run dev -w services/api                      # port 3001
npm run dev -w services/front                    # port 5173 -> http://localhost:5173
```

Les services `auth` et `api` doivent avoir leurs bases migrées (voir leurs README). Pour viser d'autres adresses : `AUTH_URL=... API_URL=... npm run dev -w services/front`.

```bash
npm test -w services/front        # tests (jsdom, `fetch` simulé)
npm run typecheck -w services/front
npm run build -w services/front   # compile dans dist/
```

## Structure

```
src/
├── main.tsx, App.tsx       point d'entrée et routes
├── pages/                  une page par écran
├── components/             Layout (menu), Protected (accès), ui (boutons, champs, alertes)
├── lib/                    api (appels et erreurs), session (JWT), money, uuid, refusals, useLoad
└── test/                   tests
nginx.conf                  serveur du site compilé (repli vers index.html, en-têtes)
Dockerfile                  image nginx sans privilèges, sans Node
```

## Docker

Le contexte de build est la racine du dépôt (workspaces npm) :

```bash
docker build -f services/front/Dockerfile -t resilience-front .
docker run -p 8080:8080 resilience-front        # http://localhost:8080
```

L'image ne contient que nginx et les fichiers compilés (environ 50 Mo), tourne sans droits root et expose `/healthz`.

**À prévoir côté WAF :** servir ce conteneur sur `/`, envoyer `/api/*` vers l'API et `/auth/*` vers `auth` en retirant le préfixe. Sans cela, le navigateur reçoit la page mais aucun appel ne passe.

## Tester sans le WAF

Le même chemin sans Vite : lancer l'image du front, et un petit serveur qui redirige `/api` et `/auth` (nginx ou autre) vers les services. En démo, c'est le rôle du WAF.
