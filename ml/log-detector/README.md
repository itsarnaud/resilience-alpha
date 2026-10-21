# log-detector

Détecteur de brute-force **sans ML**, qui réutilise ce qui existe déjà :

- **Source** : table `login_attempts` de `db-auth` (chaque tentative avec `ip`, `success`, `created_at`).
- **Règle** : une IP avec au moins `MIN_FAILURES` échecs (`success=false`) sur une fenêtre de `WINDOW_SECONDS` est considérée en brute-force.
- **Action** : on obtient un jeton `svc:detector` (`POST /v1/token` sur `auth`), puis on envoie un incident `BRUTE_FORCE` (`POST /v1/incidents` sur `remediation`) avec la `source_ip`. La remédiation applique le playbook `block_source` : validation IP → écriture denylist → rechargement du WAF → transaction canari de preuve de reprise.

La remédiation déduplique par `BRUTE_FORCE:<ip>` ; un petit cooldown en mémoire évite de spammer.

## Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `DATABASE_URL` | — | Connexion à `db-auth` (lecture seule de `login_attempts`). |
| `AUTH_URL` | `http://auth:3000` | Base auth (le client ajoute `/v1/token`). |
| `REMEDIATION_URL` | `http://remediation:3000` | Base remédiation (ajoute `/v1/incidents`). |
| `DETECTOR_CLIENT_ID` | `svc-detector` | Compte de service. |
| `DETECTOR_CLIENT_SECRET` | — | Secret du compte (= `SVC_DETECTOR_SECRET`). |
| `WINDOW_SECONDS` | `120` | Fenêtre d'observation. |
| `MIN_FAILURES` | `5` | Seuil d'échecs pour déclencher. |
| `POLL_SECONDS` | `5` | Période de scrutation (temps réel). |
| `SCORE` | `0.95` | Score envoyé (doit dépasser `MIN_SCORE` côté remédiation). |
| `PROTECTED_IPS` | `127.0.0.1,::1` | IP jamais signalées (en plus de la protection côté remédiation). |
