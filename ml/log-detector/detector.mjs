// Détecteur de brute-force sans ML.
// Boucle : interroge login_attempts (db-auth) -> IP avec trop d'échecs ->
// jeton svc:detector (auth) -> incident BRUTE_FORCE (remediation) -> ban WAF.
import pg from 'pg';

const env = process.env;
const AUTH_URL = env.AUTH_URL ?? 'http://auth:3000';
const REMEDIATION_URL = env.REMEDIATION_URL ?? 'http://remediation:3000';
const CLIENT_ID = env.DETECTOR_CLIENT_ID ?? 'svc-detector';
const CLIENT_SECRET = env.DETECTOR_CLIENT_SECRET ?? '';
const WINDOW_SECONDS = Number(env.WINDOW_SECONDS ?? '120');
const MIN_FAILURES = Number(env.MIN_FAILURES ?? '5');
const POLL_MS = Number(env.POLL_SECONDS ?? '5') * 1000;
const SCORE = Number(env.SCORE ?? '0.95');
const PROTECTED = new Set(
  (env.PROTECTED_IPS ?? '127.0.0.1,::1').split(',').map((s) => s.trim()).filter(Boolean),
);
const COOLDOWN_MS = Number(env.COOLDOWN_SECONDS ?? '60') * 1000;

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });

// --- Jeton de service (mis en cache ~14 min, TTL auth = 900 s) ---
let token = null;
let tokenExpMs = 0;
async function getToken() {
  if (token && Date.now() < tokenExpMs) return token;
  const res = await fetch(`${AUTH_URL}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const body = await res.json();
  token = body.access_token;
  tokenExpMs = Date.now() + 14 * 60 * 1000;
  return token;
}

// IP -> dernier signalement (évite de spammer ; la remédiation déduplique aussi)
const reported = new Map();

const QUERY = `
  SELECT ip,
         count(*)::int                              AS failures,
         (array_agg(DISTINCT email))[1:100]         AS targets
  FROM login_attempts
  WHERE success = false
    AND created_at > now() - make_interval(secs => $1)
  GROUP BY ip
  HAVING count(*) >= $2
`;

async function report(ip, failures, targets) {
  const body = {
    type: 'BRUTE_FORCE',
    score: SCORE,
    detected_at: new Date().toISOString(),
    source_ip: ip,
    targets: targets ?? [],
    stats: { attempts: failures, failures, window_seconds: WINDOW_SECONDS },
    dedup_key: `BRUTE_FORCE:${ip}`,
  };
  let t = await getToken();
  let res = await fetch(`${REMEDIATION_URL}/v1/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    token = null; // jeton périmé : on réessaie une fois
    t = await getToken();
    res = await fetch(`${REMEDIATION_URL}/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    });
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`incident HTTP ${res.status} ${JSON.stringify(out)}`);
  log({ event: 'incident_sent', ip, failures, status: res.status, incident_id: out.id ?? null });
}

async function tick() {
  const { rows } = await pool.query(QUERY, [WINDOW_SECONDS, MIN_FAILURES]);
  const now = Date.now();
  for (const row of rows) {
    const ip = row.ip;
    if (PROTECTED.has(ip)) continue;
    if (now - (reported.get(ip) ?? 0) < COOLDOWN_MS) continue;
    try {
      await report(ip, row.failures, row.targets);
      reported.set(ip, now);
    } catch (e) {
      log({ event: 'report_error', ip, error: String(e?.message ?? e) });
    }
  }
  for (const [ip, ms] of reported) if (now - ms > COOLDOWN_MS) reported.delete(ip);
}

log({ event: 'start', windowSeconds: WINDOW_SECONDS, minFailures: MIN_FAILURES,
      pollMs: POLL_MS, auth: AUTH_URL, remediation: REMEDIATION_URL });

async function loop() {
  try {
    await tick();
  } catch (e) {
    log({ event: 'tick_error', error: String(e?.message ?? e) });
  }
  setTimeout(loop, POLL_MS);
}
loop();

for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => { log({ event: 'shutdown', sig }); pool.end().finally(() => process.exit(0)); });
