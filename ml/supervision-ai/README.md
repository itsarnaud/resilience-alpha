# supervision-ai

IA de **supervision de la plateforme**, sans ML, qui réutilise l'observabilité et le
moteur de remédiation déjà en place. Deux rôles :

1. **Santé des services** — poll `/readyz` des services surveillés. Si un service ne
   répond plus, elle émet un incident `SERVICE_DOWN` à la remédiation (qui le redémarre
   via **Ansible** puis **prouve la reprise** par une transaction canari) et notifie le SOC.
2. **Intrusion / comportement anormal** — interroge **Loki** (refus WAF, échecs d'auth).
   En cas de pic au-dessus d'un seuil, elle envoie une alerte **e-mail au SOC** (Mailpit).

Zéro intervention humaine : détecter → décider → agir → prouver → notifier.

## 1) Santé des services

- **Source** : `GET <url>/readyz` de chaque service de `WATCH_SERVICES`, toutes les `POLL_SECONDS`.
- **Action** : au premier échec, jeton `svc:detector` (`POST /v1/token` sur `auth`) →
  incident `SERVICE_DOWN` (`POST /v1/incidents` sur `remediation`, `dedup_key=SERVICE_DOWN:<nom>`).
  La remédiation applique le playbook `restart_service`
  (restart via Ansible → `verify_ready` → **canary_transaction** → `RESOLVED`).
- **Anti-spam** : un service déjà signalé n'est pas re-signalé tant qu'il n'est pas revenu
  `ready`. En cas d'erreur d'émission, on réessaie au tour suivant.
- **Notification** : e-mail `[Supervision] <nom> indisponible` au SOC. La remédiation envoie
  de son côté le mail `[RESOLU]` / `[ÉCHEC]` final.

Testé bout en bout (`docker stop api`) : détection → incident → redémarrage Ansible →
canari OK → `RESOLVED`. **MTTR ≈ 4,6 s.**

## 2) Intrusion / comportement anormal

- **Source** : Loki `query_range` sur
  `` {container=~"waf|auth"} |~ `(?i)(modsecurity|forbidden| 403 |login_failed|access denied|ModSecurity)` ``
  sur une fenêtre de `INTRUSION_WINDOW_SECONDS`.
- **Règle** : au moins `INTRUSION_MIN` événements suspects dans la fenêtre → pic anormal.
- **Action** : e-mail `[Supervision] Comportement suspect : N evts / <fenêtre>s` au SOC, avec
  un extrait des logs. Un cooldown (`INTRUSION_COOLDOWN_SECONDS`) évite de spammer sur un même pic.

Pour déclencher en démo : générer ≥ `INTRUSION_MIN` requêtes bloquées (403 ModSecurity) ou
échecs de login en moins de `INTRUSION_WINDOW_SECONDS`. Le mail part au poll suivant
(≤ `POLL_SECONDS`, + quelques secondes le temps que Promtail pousse les logs vers Loki).

## Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `WATCH_SERVICES` | `auth=http://auth:3000,api=http://api:3000,remediation=http://remediation:3000` | Services surveillés (`nom=url`, séparés par des virgules). |
| `AUTH_URL` | `http://auth:3000` | Base auth (le client ajoute `/v1/token`). |
| `REMEDIATION_URL` | `http://remediation:3000` | Base remédiation (ajoute `/v1/incidents`). |
| `DETECTOR_CLIENT_ID` | `svc-detector` | Compte de service. |
| `DETECTOR_CLIENT_SECRET` | — | Secret du compte (= `SVC_DETECTOR_SECRET`). |
| `POLL_SECONDS` | `10` | Période de scrutation (santé + intrusion). |
| `LOKI_URL` | `http://loki:3100` | Base Loki pour la détection d'intrusion. |
| `INTRUSION_WINDOW_SECONDS` | `120` | Fenêtre d'observation des événements suspects. |
| `INTRUSION_MIN` | `15` | Seuil d'événements suspects pour alerter. |
| `INTRUSION_COOLDOWN_SECONDS` | `120` | Délai minimal entre deux alertes d'intrusion. |
| `NOTIFY_SMTP_HOST` | `mailpit` | Serveur SMTP (Mailpit en labo). |
| `NOTIFY_SMTP_PORT` | `1025` | Port SMTP. |
| `NOTIFY_FROM` | `supervision@resilience-alpha.local` | Expéditeur des alertes. |
| `NOTIFY_TO` | `soc@resilience-alpha.local` | Destinataire (boîte SOC). |

## Docker

Service `supervision-ai` de `docker-compose.dev.yml`, sur les réseaux `backend` (accès
auth/api/remediation) et `monitoring` (accès Loki). Les mails sont visibles dans Mailpit
(http://localhost:8025). Build : `node:22-slim`, unique dépendance `nodemailer`.
