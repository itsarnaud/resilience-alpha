# Consigne additionnelle 1 — Authentification renforcée (reconnaissance faciale + objet connecté)

Renforcement de l'authentification du back-office : après l'identifiant, une **reconnaissance
faciale** (caméra USB sur le PC Hôte) conditionne la saisie du mot de passe, et un **objet
connecté ESP8266** (LED bicolore) reflète l'état de l'authentification en temps réel.

## 1. Vue d'ensemble

```
  Navigateur (PC Hôte, http://localhost)
        │  identifiant → caméra (getUserMedia) → mot de passe
        ▼
   application  ──proxy /api/auth/*──►  auth  ──►  face (IA reconnaissance)
   (page login)                         │  (machine à états MFA)
        │                               └──publie l'état──►  mosquitto (MQTT)
        ▼                                                        │
   LED à l'écran (témoin)                                        ▼
                                                        ESP8266 (WiFi) → LED bicolore
```

- **Vérification 1:1** (l'identifiant est déjà saisi → « est-ce bien cette personne ? »).
- Tout est **local**, aucune image ne sort du PC Hôte.

## 2. Carte des fichiers

| Élément | Emplacement | Rôle |
|---|---|---|
| **IA reconnaissance faciale** | `infra/compose/face/Dockerfile`, `app.py` | Service Python (dlib + face_recognition). Endpoints `/enroll`, `/recognize`, `/metrics` |
| **Back-office MFA** | `infra/compose/apps/auth/index.js` | Machine à états identifiant→visage→mot de passe, blocage 5 min, publication MQTT de l'état LED |
| **Page login + caméra** | `infra/compose/apps/application/index.js` | Sert `/login` (getUserMedia), `/enroll`, et proxy `/api/auth/*` vers `auth` |
| **Broker MQTT** | `infra/compose/config/mosquitto/mosquitto.conf` | Service `mosquitto` (port 1883) |
| **Firmware ESP8266** | `iot/esp8266-led/` | Projet PlatformIO/CLion : WiFi + MQTT + machine à états LED |
| Visages enrôlés | volume Docker `resilience-alpha_face_data` | Données (hors dépôt) |

Déclarations compose : `face` dans `docker-compose.dev.yml` · `mosquitto` dans `docker-compose.infra.yml`.

## 3. L'IA de reconnaissance faciale

- Bibliothèque **`face_recognition`** (Python) basée sur **dlib**.
- **Détection** : HOG + SVM.
- **Encodage** : CNN type **ResNet-34** pré-entraîné → **embedding de 128 dimensions**.
- **Décision** : distance euclidienne vs l'empreinte enrôlée ; reconnu si distance ≤ **0,6** (`FACE_THRESHOLD`).

## 4. Machine à états (back-office + LED)

| Étape | Condition | LED |
|---|---|---|
| Repos | page chargée | éteinte |
| Identifiant saisi + **visage reconnu** | → attente mot de passe | **vert clignotant** |
| Mot de passe **valide** | connecté | **vert fixe 30 s** puis éteinte |
| Mot de passe **erroné** | on recommence l'identification | **rouge clignote 10×** puis éteinte |
| Visage **non reconnu** | ressaisie de l'identifiant | **rouge fixe 30 s** puis éteinte |

- **2 échecs de reconnaissance → blocage 5 minutes.**
- Les **durées** (30 s, 10 clignotements) sont gérées par le **firmware** (non bloquant, `millis()`).
- `auth` publie l'état sur le topic MQTT **`resilience/led`** (non-retenu → éteinte au repos).
  `GET /led-state` renvoie aussi l'état courant.

## 5. Utilisation

### Enrôler un visage
`http://localhost/enroll` → identifiant + (mot de passe si nouvel utilisateur) → « Capturer et enrôler ».

### Se connecter
`http://localhost/login` → identifiant → scanner le visage → mot de passe.
Comptes de démo : `admin`/`admin123`, `operateur`/`op123`.

### Objet connecté (ESP8266)
1. Ouvrir `iot/esp8266-led/` dans CLion + PlatformIO.
2. Régler `WIFI_PASS` (mot de passe du PA) ; `MQTT_HOST = 192.168.137.1` (PC Hôte = PA).
3. Câblage LED bicolore : une couleur → 220 Ω → D2, l'autre → 220 Ω → D1, commune → GND.
4. Build + Upload. Moniteur série 115200 : `WiFi OK` puis `MQTT... OK`.

## 6. Contraintes / points pour le dossier

- **Caméra USB sur le PC Hôte** : capture côté navigateur (`getUserMedia`) → nécessite `http://localhost`
  (contexte sécurisé) ou HTTPS ; ne marche pas via l'IP du PA.
- **ESP8266 = 2,4 GHz uniquement** : le PA doit émettre en 2,4 GHz.
- **Pare-feu Windows** : autoriser le port **1883/TCP** entrant (règle `MQTT 1883`).
- **WAF** : exclusion/limite ajoutée pour laisser passer l'image base64 de la reconnaissance
  (`MODSEC_REQ_BODY_NO_FILES_LIMIT` + envoi du base64 sans préfixe `data:...;base64,`).
- **Démo** : broker MQTT en `allow_anonymous` et page `/enroll` ouverte → en production :
  auth MQTT + TLS, et `/enroll` derrière une habilitation admin.
