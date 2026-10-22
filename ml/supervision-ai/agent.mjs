// IA de supervision de la plateforme.
//  1) Santé : poll /readyz des services. Si un service tombe -> incident
//     SERVICE_DOWN a la remediation (qui le redemarre via Ansible + notifie le SOC).
//  2) Intrusion / comportement bizarre : interroge Loki (refus WAF, echecs d'auth).
//     Si pic anormal -> email au SOC via Mailpit.
import nodemailer from 'nodemailer';

const env = process.env;
const LOKI = env.LOKI_URL ?? 'http://loki:3100';
const AUTH_URL = env.AUTH_URL ?? 'http://auth:3000';
const REMEDIATION_URL = env.REMEDIATION_URL ?? 'http://remediation:3000';
const CLIENT_ID = env.DETECTOR_CLIENT_ID ?? 'svc-detector';
const CLIENT_SECRET = env.DETECTOR_CLIENT_SECRET ?? '';
const POLL_MS = Number(env.POLL_SECONDS ?? '10') * 1000;
// Services surveilles : "nom=url,nom=url"
const SERVICES = (env.WATCH_SERVICES ?? 'auth=http://auth:3000,api=http://api:3000,remediation=http://remediation:3000')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((p) => { const [name, url] = p.split('='); return { name, url }; });
// Notif email (Mailpit)
const SMTP_HOST = env.NOTIFY_SMTP_HOST ?? 'mailpit';
const SMTP_PORT = Number(env.NOTIFY_SMTP_PORT ?? '1025');
const NOTIFY_FROM = env.NOTIFY_FROM ?? 'supervision@resilience-alpha.local';
const NOTIFY_TO = env.NOTIFY_TO ?? 'soc@resilience-alpha.local';
// Intrusion
const INTRUSION_WINDOW_S = Number(env.INTRUSION_WINDOW_SECONDS ?? '120');
const INTRUSION_MIN = Number(env.INTRUSION_MIN ?? '15');   // seuil d'evenements suspects
const INTRUSION_COOLDOWN_MS = Number(env.INTRUSION_COOLDOWN_SECONDS ?? '120') * 1000;

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const mailer = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false });

async function notify(subject, text) {
  try {
    await mailer.sendMail({ from: NOTIFY_FROM, to: NOTIFY_TO, subject, text });
    log({ event: 'notified', subject });
  } catch (e) {
    log({ event: 'notify_error', error: String(e?.message ?? e) });
  }
}

// --- Jeton svc:detector (pour creer des incidents de remediation) ---
let token = null, tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  const res = await fetch(`${AUTH_URL}/v1/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  token = (await res.json()).access_token;
  tokenExp = Date.now() + 14 * 60 * 1000;
  return token;
}

// --- 1) Sante des services ---
const down = new Map(); // name -> depuis quand signale
async function isReady(url) {
  try {
    const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}
async function reportServiceDown(name) {
  const t = await getToken();
  const report = {
    type: 'SERVICE_DOWN', score: 0.95, detected_at: new Date().toISOString(),
    target_service: name, dedup_key: `SERVICE_DOWN:${name}`,
  };
  const res = await fetch(`${REMEDIATION_URL}/v1/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify(report),
  });
  log({ event: 'incident_sent', service: name, status: res.status });
}
async function checkHealth() {
  for (const { name, url } of SERVICES) {
    const ready = await isReady(url);
    if (ready) { down.delete(name); continue; }
    if (down.has(name)) continue; // deja signale, on attend la reprise
    down.set(name, Date.now());
    log({ event: 'service_down', service: name });
    try {
      await reportServiceDown(name); // -> remediation redemarre (Ansible) + notifie
      await notify(`[Supervision] ${name} indisponible`,
        `Le service "${name}" ne repond plus (/readyz KO).\nIncident SERVICE_DOWN emis : redemarrage automatique via Ansible en cours, avec verification par transaction canari.`);
    } catch (e) {
      log({ event: 'report_error', service: name, error: String(e?.message ?? e) });
      down.delete(name); // on reessaiera au prochain tour
    }
  }
}

// --- 2) Intrusion / comportement bizarre (Loki) ---
let lastIntrusion = 0;
async function checkIntrusion() {
  if (Date.now() - lastIntrusion < INTRUSION_COOLDOWN_MS) return;
  const query = '{container=~"waf|auth"} |~ `(?i)(modsecurity|forbidden| 403 |login_failed|access denied|ModSecurity)`';
  const end = Date.now() * 1e6;
  const start = end - INTRUSION_WINDOW_S * 1e9;
  const url = `${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&limit=300`;
  let body;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { log({ event: 'loki_error', status: res.status }); return; }
    body = await res.json();
  } catch (e) { log({ event: 'loki_error', error: String(e?.message ?? e) }); return; }

  const streams = body?.data?.result ?? [];
  const count = streams.reduce((n, s) => n + (s.values?.length ?? 0), 0);
  if (count < INTRUSION_MIN) return;

  lastIntrusion = Date.now();
  const sample = streams.flatMap((s) => (s.values ?? []).slice(0, 3).map((v) => v[1])).slice(0, 8).join('\n');
  log({ event: 'intrusion_suspected', count });
  await notify(`[Supervision] Comportement suspect : ${count} evts / ${INTRUSION_WINDOW_S}s`,
    `L'IA de supervision a repere ${count} evenements suspects (refus WAF / echecs d'authentification) sur les ${INTRUSION_WINDOW_S} dernieres secondes.\n\nExtrait :\n${sample}\n\nA verifier cote SOC (dashboard securite Grafana).`);
}

log({ event: 'start', services: SERVICES.map((s) => s.name), pollMs: POLL_MS,
      loki: LOKI, notifyTo: NOTIFY_TO });

async function loop() {
  try { await checkHealth(); } catch (e) { log({ event: 'health_tick_error', error: String(e?.message ?? e) }); }
  try { await checkIntrusion(); } catch (e) { log({ event: 'intrusion_tick_error', error: String(e?.message ?? e) }); }
  setTimeout(loop, POLL_MS);
}
loop();

for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => { log({ event: 'shutdown', sig }); process.exit(0); });
