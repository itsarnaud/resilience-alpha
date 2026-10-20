// RESILIENCE-ALPHA — Objet connecté ESP8266 : LED bicolore d'état d'authentification.
// Reçoit l'état via MQTT (topic resilience/led) publié par le back-office,
// et applique la machine à états de la consigne (durées gérées ici).
#include <ESP8266WiFi.h>
#include <PubSubClient.h>

// ===================== CONFIGURATION (à adapter) =====================
const char* WIFI_SSID = "RESILIENCE-G3";           // PA du groupe
const char* WIFI_PASS = "CHANGEZ_MOI";             // mot de passe du PA
const char* MQTT_HOST = "192.168.137.1";   // PC Hote = PA (hotspot Windows, IP fixe)
const uint16_t MQTT_PORT = 1883;
const char* MQTT_TOPIC = "resilience/led";

// LED RGB : on utilise rouge + vert (bleu non branche). Adapter les broches si besoin.
const uint8_t PIN_GREEN = D1;   // GPIO5
const uint8_t PIN_RED   = D2;   // GPIO4
// true  = LED a ANODE commune  (patte commune au 3V3)  -> logique inversee
// false = LED a CATHODE commune (patte commune au GND)
const bool COMMON_ANODE = false;
// ====================================================================

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

enum LedMode { OFF, GREEN_BLINK, GREEN_SOLID, RED_BLINK, RED_SOLID };
LedMode mode = OFF;
unsigned long modeStart = 0, lastToggle = 0;
bool blinkOn = false;
int redToggles = 0;

static inline int lvl(bool on) { return (COMMON_ANODE ? !on : on) ? HIGH : LOW; }
void setGreen(bool on) { digitalWrite(PIN_GREEN, lvl(on)); }
void setRed(bool on)   { digitalWrite(PIN_RED,   lvl(on)); }
void allOff()          { setGreen(false); setRed(false); }

void setMode(LedMode m) {
  mode = m; modeStart = millis(); lastToggle = millis(); blinkOn = false; redToggles = 0; allOff();
}

// Applique l'animation en continu, sans bloquer (millis()).
void applyLed() {
  unsigned long now = millis();
  switch (mode) {
    case OFF:
      allOff();
      break;
    case GREEN_BLINK:                       // vert clignotant tant qu'aucun nouvel état n'arrive
      if (now - lastToggle >= 300) { blinkOn = !blinkOn; lastToggle = now; setGreen(blinkOn); setRed(false); }
      break;
    case GREEN_SOLID:                        // vert fixe 30 s puis éteint
      if (now - modeStart < 30000) { setGreen(true); setRed(false); } else { allOff(); mode = OFF; }
      break;
    case RED_BLINK:                          // rouge clignote 10 fois (20 bascules) puis éteint
      if (redToggles < 20) {
        if (now - lastToggle >= 250) { blinkOn = !blinkOn; lastToggle = now; setRed(blinkOn); setGreen(false); redToggles++; }
      } else { allOff(); mode = OFF; }
      break;
    case RED_SOLID:                          // rouge fixe 30 s puis éteint
      if (now - modeStart < 30000) { setRed(true); setGreen(false); } else { allOff(); mode = OFF; }
      break;
  }
}

void onMessage(char* topic, byte* payload, unsigned int len) {
  String s; for (unsigned int i = 0; i < len; i++) s += (char)payload[i];
  if      (s == "green-blink") setMode(GREEN_BLINK);
  else if (s == "green-solid") setMode(GREEN_SOLID);
  else if (s == "red-blink")   setMode(RED_BLINK);
  else if (s == "red-solid")   setMode(RED_SOLID);
  else                          setMode(OFF);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.println(" OK " + WiFi.localIP().toString());
}

void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("MQTT...");
    if (mqtt.connect("esp8266-led")) { mqtt.subscribe(MQTT_TOPIC); Serial.println(" OK"); }
    else { Serial.println(" echec, retry"); delay(1000); }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_GREEN, OUTPUT); pinMode(PIN_RED, OUTPUT); allOff();
  connectWifi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();
  applyLed();
}
