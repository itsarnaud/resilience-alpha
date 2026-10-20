# ESP8266 — LED d'état d'authentification

Objet connecté du workshop : une LED bicolore (rouge/vert) qui reflète l'état
de l'authentification du back-office, reçu en MQTT depuis le PC Hôte.

## Câblage (LED bicolore cathode commune)
- Patte **verte**  -> résistance 220 Ω -> **D1** (GPIO5)
- Patte **rouge**  -> résistance 220 Ω -> **D2** (GPIO4)
- Cathode commune  -> **GND**

(LED à anode commune : inverser la logique HIGH/LOW dans `setGreen`/`setRed`.)

## Configuration
Dans `src/main.cpp`, renseigner :
- `WIFI_SSID` / `WIFI_PASS` : le PA du groupe (`RESILIENCE-G3`)
- `MQTT_HOST` : IP du PC Hôte sur le PA (`192.168.137.1`)

## Build & flash (CLion + PlatformIO, imposé)
1. Ouvrir le dossier `iot/esp8266-led/` dans CLion (plugin PlatformIO installé).
2. Brancher l'ESP8266 en USB.
3. Build puis Upload (icônes PlatformIO), ou en terminal :
   ```
   pio run -t upload
   pio device monitor
   ```

## États (topic `resilience/led`)
| Message        | Comportement LED                         |
|----------------|------------------------------------------|
| `green-blink`  | vert clignotant (attente mot de passe)   |
| `green-solid`  | vert fixe 30 s puis éteint (connecté)     |
| `red-blink`    | rouge clignote 10× puis éteint (MDP faux) |
| `red-solid`    | rouge fixe 30 s puis éteint (non reconnu) |
| `off` / autre  | éteint                                   |

Les durées sont gérées par le firmware (non bloquant, `millis()`).
Le back-office (`auth`) publie l'état ; `GET /led-state` donne aussi l'état courant.
