# @resilience/shared

Code commun aux services (`auth`, `api`, `remediation`). Il évite de recopier dans chaque service le logger, la gestion d'erreurs, la vérification des JWT et les métriques.

## Utilisation

Dans un service, ajouter la dépendance dans son `package.json` :

```json
"dependencies": { "@resilience/shared": "*" }
```

Puis, depuis la racine du dépôt :

```bash
npm install
npm run build -w packages/shared   # à relancer après chaque modification du package
```

Les services importent le code compilé (`dist/`). Les tests du package se lancent avec `npm test -w packages/shared`.

## Exemple : squelette d'un service

```ts
import express from 'express';
import { z } from 'zod';
import {
  authenticate,
  createJwtVerifier,
  createLogger,
  createMetrics,
  errorHandler,
  loadConfig,
  notFoundHandler,
  remoteKeys,
  requestId,
  requireRole,
} from '@resilience/shared';

const config = loadConfig(
  z.object({
    PORT: z.coerce.number().default(3000),
    AUTH_JWKS_URL: z.string().url(),
  }),
);

const logger = createLogger('api');
const metrics = createMetrics('api');
const verify = createJwtVerifier({
  getKey: remoteKeys(config.AUTH_JWKS_URL),
  issuer: 'resilience-auth',
  audience: 'resilience-platform',
});

const app = express();
app.use(requestId());
app.use(metrics.middleware);
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/metrics', metrics.handler);
app.get('/v1/me', authenticate(verify), (req, res) => res.json(req.auth));
app.post('/v1/admin', authenticate(verify), requireRole('operator'), (_req, res) =>
  res.sendStatus(204),
);

app.use(notFoundHandler()); // en dernier avant le handler d'erreurs
app.use(errorHandler(logger)); // toujours en dernier

app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'service démarré'));
```

## Ce que contient le package

| Export                                                                      | Rôle                                                                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLogger(service)`                                                     | Logger JSON `pino` ; masque `Authorization`, cookies, mots de passe.                                                                          |
| `requestId()`                                                               | Middleware : reprend `X-Request-Id` (s'il est valide) ou en génère un, et le renvoie. Disponible dans `req.id`.                               |
| `HttpError`, `errorHandler(logger)`, `notFoundHandler()`                    | Erreurs en `application/problem+json`. Lancer `throw HttpError.forbidden('motif')`. Une erreur inattendue donne un 500 sans détail au client. |
| `createJwtVerifier`, `remoteKeys(url)`, `authenticate(verify)`              | Vérifie les JWT (RS256 uniquement, émetteur, audience, expiration). Remplit `req.auth` (`sub`, `roles`).                                      |
| `requireRole(...roles)`                                                     | Refuse avec 403 si l'utilisateur n'a aucun des rôles. À placer après `authenticate`.                                                          |
| `createMetrics(service)`                                                    | Middleware de métriques HTTP et handler pour `GET /metrics`. Le label `route` est le motif de route (`/v1/accounts/:id`), pas l'URL réelle.   |
| `loadConfig(schema)`                                                        | Valide `process.env` avec zod. Échoue au démarrage avec un message lisible.                                                                   |
| `ROLES`, `IncidentReportSchema`, `TransactionRequestSchema`, types associés | Rôles, types et états d'incident, corps de `POST /v1/incidents`, corps de virement (compte interne ou IBAN externe, pas les deux).            |

## Règles

- Ne rien mettre ici qui ne soit utilisé par au moins deux services.
- Les schémas des échanges entre services (incidents, virements) vivent ici, pour que les deux côtés valident la même chose. Si un schéma change, mettre à jour le contrat OpenAPI dans `docs/api/`.
- Aucune logique métier (règle anti-fraude, playbooks) : elle reste dans le service concerné.
