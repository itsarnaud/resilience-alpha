# PROJECT RESILIENCE-ALPHA — État du projet (Groupe 3)

_Mise à jour : 2026-10-22_

Plateforme de paiement fictive conteneurisée, capable de **subir une attaque et de se
rétablir seule**, avec **preuve de reprise** (transaction canari réussie après l'incident).
Zéro intervention humaine : détecter → décider → agir → prouver.

---

## 1. Vue d'ensemble

Trois machines :

- **PC Hôte** — héberge toute la plateforme (conteneurs Docker) : banque, WAF,
  observabilité, moteur de remédiation. C'est aussi le point d'accès Wi-Fi des objets.
- **PC Attaquant** — lance les attaques (brute-force, etc.).
- **PC Délestage IA** — assistant RAG en lecture seule (optionnel, voir §7).

Boucle de reprise autonome : **attaque → détection (logs) → décision → action (blocage WAF /
redémarrage) → transaction canari de preuve → service rétabli**. MTTR mesuré ≈ **0,9 s**.

---

## 2. Architecture Docker (3 piles Compose)

| Pile | Fichier | Contenu |
|---|---|---|
| **Infra** | `docker-compose.infra.yml` | Prometheus, node-exporter, Loki, Promtail, Grafana, Ansible, Mosquitto (MQTT), docker-socket-proxy, blackbox |
| **Dev** | `docker-compose.dev.yml` | `auth`, `api`, `remediation`, `front`, `dashboard`, `backoffice`, `face`, `log-detector`, `supervision-ai`, 3 bases PostgreSQL |
| **Cyber** | `docker-compose.cyber.yml` | `waf` (point d'entrée unique) |

**Ordre de lancement impératif** : infra → dev → cyber (infra crée les réseaux partagés).

Réseaux : `backend` (apps ↔ apps + WAF + Prometheus + Ansible),
`data` (apps ↔ bases, non exposé), `monitoring` (Prometheus, Loki, Grafana, Ansible),
`remediation` (moteur ↔ socket-proxy).

---

## 3. État par domaine

### ✅ Développement (banque de paiement)
- 7 services réels (TypeScript, Prisma) : `auth`, `api` (paiement), `remediation`,
  3 fronts React compilés (`front` banque, `dashboard` supervision, `backoffice` admin),
  `face` (IA reconnaissance faciale).
- Une base PostgreSQL par service (`db-auth`, `db-paiement`, `db-remediation`).
- Comptes seedés : operator, admin, victime + comptes de service (svc:detector/dashboard/remediation).

### ✅ Infrastructure & observabilité
- Prometheus + node-exporter + Loki + Promtail + Grafana (dashboards provisionnés).
- Mosquitto (broker MQTT pour la LED), Ansible (nœud de contrôle), docker-socket-proxy
  (accès Docker filtré pour la remédiation — jamais le socket brut).

### ✅ Cybersécurité — WAF (Nginx + ModSecurity + OWASP CRS)
- **Point d'entrée unique**, routage **par préfixe** avec un port par front :
  - `http://localhost/` → `front` ; `:8081` → `dashboard` ; `:8082` → `backoffice`
  - `/auth/*` → `auth:3000`, `/api/*` → `api:3000`, `/remediation/*` → `remediation:3000`
    (préfixe **retiré** avant transmission)
  - `/detector/*`, `/assistant/*` → services IA sur `:8081` (préfixe **conservé**)
- ModSecurity actif globalement (**858 règles CRS**, `nginx -t` OK). Exceptions ciblées
  (fichier `config/waf/modsecurity-override.conf`, chargé avant les règles CRS) :
  - `id:1100` — étape visage du login back-office (image/jpeg, faux positif CRS 920420)
  - `id:1101` — enrôlement d'un visage (`/admin/users/:id/face`)
  - `id:1102` — méthode `DELETE` sur `/remediation/v1/blocks` (débloquer une IP ; CRS 911100)
- **Blocage d'IP réel** : volume `resilience-alpha_waf_denylist` monté en lecture, inclus
  dans les 3 server blocks (`deny <ip>;`), rechargé par signal HUP depuis la remédiation.
- **Analyse de risques & continuité** : [`analyse-ebios-rm.md`](analyse-ebios-rm.md)
  (EBIOS RM : ER1–ER8, R1–R9, M1–M11) et [`PCA-PRA.md`](PCA-PRA.md)
  (cartographie, matrice PTMA/RTO/RPO, procédures P1–P5). Mesures : MTTR ≈ 0,9 s,
  bascule de base ≈ 2 s, RPO ≤ 1 h. Cotations et objectifs métier **à valider** ;
  limite assumée : piles et sauvegardes sur le **PC Hôte** unique (risque R9).

### ✅ Observabilité — Grafana + Loki
- Le SIEM Wazuh a été **retiré du périmètre** : il ne recevait aucun log applicatif
  (0 agent enregistré, le filebeat du manager ne lisant que ses propres alertes).
- La lecture des événements se fait donc dans **Grafana** (datasource **Loki** préconfigurée),
  alimenté par **Promtail** qui lit le socket Docker et scrape les conteneurs qui portent
  le label `logging=promtail` : `auth`, `api`, `remediation`, `waf`.
- Flux disponibles en temps réel : `{container="auth"}` (évenements `login_failed` /
  `login_succeeded` avec email, IP, motif), `{container="waf"}` (accès nginx : 401 puis
  403 après un ban), `{container="remediation"}` (`ip_blocked`, `incident_resolved`).
- Dashboards provisionnés : **Securite-WAF-Journaux** (blocages 403, volume de journaux par
  conteneur, journaux WAF en direct) et **Remediation** (MTTR, incidents, journal du moteur).
- **Cockpit intégré** : le back-office expose un onglet **Observabilité** qui embarque les
  dashboards Grafana + Mailpit (notifications SOC) — toute la supervision au même endroit.
- Les métriques Prometheus (état du moteur, compteurs d'incidents) complètent la lecture.

### ✅ Remédiation autonome (le cœur du sujet)
- `log-detector` (sans ML) : interroge `login_attempts` (db-auth) toutes les 5 s → IP avec
  ≥ 5 échecs sur 2 min → jeton `svc:detector` → `POST /remediation/v1/incidents`.
- Moteur `remediation` : politique → playbook adapté :
  - **`block_source`** (brute-force / inondation) : validate_ip → block_ip → verify_ready → **canary_transaction**.
  - **`restart_service`** (service tombé) : restart → verify_ready → **canary_transaction**.
- Modes de remédiation : Docker (restart via socket-proxy) **et** Ansible (playbook) — piloté
  par `REMEDIATION_MODE` (`docker` | `ansible`).
- **Testé bout en bout** : brute-force → IP bloquée dans le WAF → transaction canari
  réussie → incident `RESOLVED`. **MTTR ≈ 0,9 s.**

### ✅ Supervision autonome (IA `supervision-ai`)
- Service `supervision-ai` (sans ML) branché sur l'observabilité et le moteur de remédiation.
- **Santé des services** : poll `/readyz` de `auth`, `api`, `remediation`. Si un service tombe →
  incident `SERVICE_DOWN` → remédiation le **redémarre via Ansible** → **transaction canari** de
  preuve → incident `RESOLVED` + notification SOC. **Testé** (`docker stop api`) : **MTTR ≈ 4,6 s**.
- **Intrusion / comportement anormal** : interroge **Loki** (refus WAF 403, échecs d'auth) ;
  au-delà de `INTRUSION_MIN` (15) événements sur `INTRUSION_WINDOW_SECONDS` (120 s) → **e-mail SOC**.
- **Notifications** : e-mail via **Mailpit** (`soc@resilience-alpha.local`, UI http://localhost:8025).

### ✅ Consigne additionnelle 1 — MFA faciale + LED ESP8266
- Back-office protégé par connexion renforcée **3 étapes** : identifiant → **visage** → mot de passe.
  2 échecs = blocage 5 min (doublé à chaque fois, max 1 h).
- Service `face` (dlib / `face_recognition`, ResNet-34, seuil distance 0,6), rangé dans `ml/face`.
- **LED d'état physique** (ESP8266 NodeMCU) pilotée par MQTT (`topic resilience/led`) :
  éteinte / verte clignotante (visage OK) / verte fixe (connecté) / rouge (refus).
  - Wi-Fi `RESILIENCE-G3` (**WPA2**, 2,4 GHz) ; broker sur le PC Hôte.
  - Firmware Arduino (CH340, PubSubClient, machine à états non bloquante millis()).

---

## 4. Ce qui reste

- **Services IA `detector` / `assistant`** (ml/ai-runtime, pôle IA) : **buildent et tournent**.
  Routés par le WAF (`/detector/*`, `/assistant/*`, préfixe conservé). Le modèle et la base de
  connaissances ne sont pas versionnés (gitignorés) : à récupérer depuis la livraison IA et à
  placer dans `ml/ai-runtime/{models,data}` avant le build (voir README racine). La **livraison
  automatique des incidents reste désactivée** côté IA tant que le modèle n'est pas `validated` ;
  en attendant, la détection autonome est assurée par le `log-detector` (brute-force) et par
  `supervision-ai` (crash de service + intrusion).
- **Enrôlement du visage admin** : à faire après chaque reset (le visage n'est pas pré-seedé).
  Procédure : login via bootstrap puis `POST /admin/users/:id/face` (voir §6).
- **Cotation des risques & objectifs de reprise** : vraisemblances R1–R9, risques résiduels et
  RTO/RPO métier à valider (`docs/analyse-ebios-rm.md`, `docs/PCA-PRA.md`).
- **Contrôles à prouver** : refus serveur d'un virement non autorisé (M2), protection de
  l'interface de remédiation (M4), repli sur échec de remédiation (M7), séquence biométrique
  (M9), habilitations du back-office (M10), messages MQTT et LED (M11).
- **Continuité** : reconstruction complète de la plateforme sur un poste distinct non
  démontrée (R9) ; sauvegardes conservées sur le PC Hôte.
- **Livrables** : Dossier (PDF), Présentation (PPTX), Vidéo chronométrée (MP4).

---

## 5. Lancer la plateforme

Prérequis : Docker Desktop démarré, `.env` à la racine de `infra/compose`, clé
`services/auth/keys/jwt.pem` générée une fois
(`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out services/auth/keys/jwt.pem`).

```bash
cd infra/compose
docker compose -f docker-compose.infra.yml up -d
docker compose -f docker-compose.dev.yml  up -d --build
docker compose -f docker-compose.cyber.yml up -d
```

Seed des comptes (premier démarrage ou après reset des volumes) :
```bash
docker compose -f docker-compose.dev.yml exec auth node dist/scripts/seed.js
docker compose -f docker-compose.dev.yml exec api  node dist/scripts/seed.js
```

### URLs & comptes de démo
| Accès | URL | Compte |
|---|---|---|
| Banque client | http://localhost/ | victime@resilience.local / azerty123 |
| Dashboard supervision | http://localhost:8081/ | operator@resilience.local / operator-dev-pwd |
| Back-office (MFA faciale) | http://localhost:8082/ | admin@resilience.local / admin-dev-pwd |
| Grafana | http://localhost:3000 | admin / (voir `.env`) |

---

## 6. Enrôler le visage admin (après un reset)

Le mode `stub` n'enregistre rien (no-op) ; l'enrôlement réel se fait en mode `http`
via l'API admin (port direct `3010`, hors WAF) :

```powershell
$base  = "http://localhost:3010/v1"
$photo = "$HOME\Pictures\moi.jpg"   # JPEG, visage net, < 1 Mo
$login = Invoke-RestMethod "$base/login" -Method Post -ContentType "application/json" `
  -Body '{"email":"admin@resilience.local","password":"admin-dev-pwd"}'
$h = @{ Authorization = "Bearer $($login.access_token)" }
$admin = (Invoke-RestMethod "$base/admin/users" -Headers $h) | ? { $_.email -eq "admin@resilience.local" }
Invoke-RestMethod "$base/admin/users/$($admin.id)/face" -Method Post -Headers $h -ContentType "image/jpeg" -InFile $photo
```

---

## 7. Scénario de démo recommandé (jury)

1. Montrer la banque qui tourne (une transaction passe) + les dashboards Grafana/dashboard.
2. Connexion back-office en 3 étapes avec **reconnaissance faciale réelle** + **LED physique**
   qui réagit (verte = OK, rouge = refus).
3. Depuis le **PC Attaquant**, lancer un **brute-force** sur l'auth.
4. Observer en **temps réel** : détection (`log-detector`) → incident `BRUTE_FORCE` →
   **IP bloquée par le WAF** → **transaction canari** de preuve → incident `RESOLVED`.
   Montrer le **MTTR ≈ 1 s** et l'IP refusée par le WAF.
5. Débloquer l'IP depuis le dashboard (bouton « Débloquer »).

> Le point fort : la boucle est **100 % autonome** et **prouve** la reprise (canari),
> pas seulement un redémarrage.
