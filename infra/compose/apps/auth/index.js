// auth — MFA back-office : identifiant -> reconnaissance faciale -> mot de passe.
// Expose aussi l'état LED courant (consommé par le bloc ESP8266/MQTT).
const express = require('express');
const crypto = require('crypto');
const client = require('prom-client');
const mqtt = require('mqtt');

// ---------- MQTT : publie l'état LED pour l'ESP8266 ----------
const MQTT_URL = process.env.MQTT_URL || 'mqtt://mosquitto:1883';
const LED_TOPIC = process.env.LED_TOPIC || 'resilience/led';
let mqttClient = null;
try {
  mqttClient = mqtt.connect(MQTT_URL, { reconnectPeriod: 2000 });
  mqttClient.on('connect', () => console.log('MQTT connecté ->', MQTT_URL));
  mqttClient.on('error', () => {});
} catch (e) { console.log('MQTT indisponible:', e.message); }
function publishLed(state) {
  try { if (mqttClient && mqttClient.connected) mqttClient.publish(LED_TOPIC, state, { retain: false }); } catch (e) {}
}

const SERVICE = 'auth';
const FACE_URL = process.env.FACE_URL || 'http://face:5000';
const BLOCK_MS = Number(process.env.BLOCK_MS || 5 * 60 * 1000); // 5 min
const MAX_TRIES = Number(process.env.MAX_TRIES || 2);           // 2 essais de reconnaissance

const app = express();
app.use(express.json({ limit: '5mb' })); // images base64

// ---------- métriques ----------
const register = client.register;
client.collectDefaultMetrics();
register.setDefaultLabels({ service: SERVICE });
const httpRequests = new client.Counter({ name: 'http_requests_total', help: 'Requetes HTTP', labelNames: ['method', 'route', 'status'] });
const mFace = new client.Counter({ name: 'auth_face_total', help: 'Etapes reconnaissance', labelNames: ['result'] });
const mPwd = new client.Counter({ name: 'auth_password_total', help: 'Etapes mot de passe', labelNames: ['result'] });
const mBlocks = new client.Counter({ name: 'auth_blocks_total', help: 'Blocages 5 min' });
app.use((req, res, next) => {
  res.on('finish', () => httpRequests.inc({ method: req.method, route: req.path, status: res.statusCode }));
  next();
});

// ---------- "base" utilisateurs (démo) + habilitations ----------
// En prod : table SQL. Ici, en mémoire, avec rôle (habilitation).
const users = {
  admin:   { password: 'admin123', role: 'admin' },
  operateur: { password: 'op123',  role: 'operateur' },
};
const blocked = {};   // username -> timestamp de déblocage
const sessions = {};  // sessionId -> { username, step, tries }

// ---------- état LED (machine à états de la consigne) ----------
// valeurs : off | green-blink | green-solid | red-blink | red-solid
let led = { state: 'off', until: 0 };
function setLed(state, ttlMs = 0) { led = { state, until: ttlMs ? Date.now() + ttlMs : 0 }; publishLed(state); }
function currentLed() {
  if (led.until && Date.now() > led.until) led = { state: 'off', until: 0 };
  return led.state;
}

const newId = () => crypto.randomBytes(12).toString('hex');

// ---------- étape 1 : identifiant ----------
app.post('/identify', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ ok: false, error: 'identifiant requis' });
  const until = blocked[username] || 0;
  if (Date.now() < until) {
    return res.json({ ok: false, blocked: true, retryInSec: Math.ceil((until - Date.now()) / 1000) });
  }
  if (!users[username]) {
    // on ne révèle pas si l'utilisateur existe : on demande quand même la caméra
    const sid = newId();
    sessions[sid] = { username, step: 'face', tries: 0, unknown: true };
    return res.json({ ok: true, sessionId: sid, step: 'face' });
  }
  const sid = newId();
  sessions[sid] = { username, step: 'face', tries: 0 };
  res.json({ ok: true, sessionId: sid, step: 'face' });
});

// ---------- étape 2 : reconnaissance faciale ----------
app.post('/face', async (req, res) => {
  const { sessionId, image } = req.body || {};
  const s = sessions[sessionId];
  if (!s || s.step !== 'face') return res.status(409).json({ ok: false, error: 'session invalide' });

  let recognized = false;
  if (!s.unknown) {
    try {
      const r = await fetch(`${FACE_URL}/recognize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: s.username, image }), signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      recognized = !!j.recognized;
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'service de reconnaissance indisponible' });
    }
  }

  if (recognized) {
    s.step = 'password';
    mFace.labels('match').inc();
    setLed('green-blink'); // vert clignotant jusqu'à la saisie du mot de passe
    return res.json({ ok: true, recognized: true, step: 'password', led: 'green-blink' });
  }

  // non reconnu
  s.tries += 1;
  mFace.labels('no_match').inc();
  setLed('red-solid', 30000); // rouge fixe 30 s puis caméra éteinte
  if (s.tries >= MAX_TRIES) {
    blocked[s.username] = Date.now() + BLOCK_MS;
    mBlocks.inc();
    delete sessions[sessionId];
    return res.json({ ok: false, recognized: false, blocked: true, retryInSec: Math.ceil(BLOCK_MS / 1000), led: 'red-solid' });
  }
  s.step = 'face'; // on reste en identification, l'utilisateur ressaisit
  res.json({ ok: false, recognized: false, triesLeft: MAX_TRIES - s.tries, led: 'red-solid' });
});

// ---------- étape 3 : mot de passe ----------
app.post('/password', (req, res) => {
  const { sessionId, password } = req.body || {};
  const s = sessions[sessionId];
  if (!s || s.step !== 'password') return res.status(409).json({ ok: false, error: 'session invalide' });
  const u = users[s.username];
  if (u && password === u.password) {
    mPwd.labels('ok').inc();
    setLed('green-solid', 30000); // vert fixe 30 s puis éteinte
    const token = crypto.randomBytes(16).toString('hex'); // jeton de session (démo)
    delete sessions[sessionId];
    return res.json({ ok: true, token, role: u.role, led: 'green-solid' });
  }
  mPwd.labels('ko').inc();
  setLed('red-blink', 6000); // rouge clignote 10x puis on recommence l'identification
  delete sessions[sessionId];
  res.json({ ok: false, error: 'mot de passe incorrect', restart: true, led: 'red-blink' });
});

// ---------- enrôlement d'un visage (admin / démo) ----------
app.post('/enroll', async (req, res) => {
  const { username, image, password, role } = req.body || {};
  if (!username || !image) return res.status(400).json({ ok: false, error: 'username et image requis' });
  if (!users[username]) users[username] = { password: password || 'changeme', role: role || 'operateur' };
  try {
    const r = await fetch(`${FACE_URL}/enroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: username, image }), signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return res.status(r.ok ? 200 : 422).json(j);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'service de reconnaissance indisponible' });
  }
});

// ---------- état LED (pour l'ESP8266) ----------
app.get('/led-state', (req, res) => res.json({ state: currentLed() }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));
app.get('/metrics', async (req, res) => { res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`${SERVICE} (MFA back-office) up on :${port}`));
