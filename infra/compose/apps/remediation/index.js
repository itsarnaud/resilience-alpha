// moteur de remédiation — détection d'incident, choix de playbook,
// action via socket-proxy (droits limités), puis preuve de reprise (/tx-test).
// Fonctionne SANS intervention humaine.
const express = require('express');
const client = require('prom-client');
const Docker = require('dockerode');

const SERVICE = 'remediation';
const PROM = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'api-paiement';
const TARGET_URL = process.env.TARGET_URL || 'http://api-paiement:3000';
const POLL_MS = Number(process.env.POLL_MS || 5000);
const SEUIL_SURCHARGE = Number(process.env.SEUIL_SURCHARGE || 5); // req/s
const MODE = process.env.REMEDIATION_MODE || 'docker';           // 'ansible' | 'docker'
const ANSIBLE_CONTAINER = process.env.ANSIBLE_CONTAINER || 'ansible';
const ANSIBLE_PLAYBOOK = process.env.ANSIBLE_PLAYBOOK || 'playbooks/remediation.yml';

// Accès Docker UNIQUEMENT via le socket-proxy (jamais le démon en direct)
const docker = new Docker({
  host: process.env.SOCKET_PROXY_HOST || 'docker-socket-proxy',
  port: Number(process.env.SOCKET_PROXY_PORT || 2375),
});

// ---------- métriques Prometheus ----------
const register = client.register;
client.collectDefaultMetrics();
register.setDefaultLabels({ service: SERVICE });

const mState = new client.Gauge({
  name: 'remediation_state',
  help: '0=nominal 1=incident 2=remediation 3=verification 4=escalade',
});
const mTargetUp = new client.Gauge({
  name: 'remediation_target_up',
  help: 'Cible joignable (1) ou non (0)',
});
const mIncidents = new client.Counter({
  name: 'remediation_incidents_total', help: 'Incidents détectés', labelNames: ['type'],
});
const mActions = new client.Counter({
  name: 'remediation_actions_total', help: 'Actions correctives', labelNames: ['action', 'playbook'],
});
const mRecovery = new client.Histogram({
  name: 'remediation_recovery_seconds', help: 'Durée de reprise (MTTR)',
  buckets: [1, 2, 5, 10, 20, 30, 60],
});
const mLastMttr = new client.Gauge({
  name: 'remediation_last_recovery_seconds', help: 'MTTR du dernier incident',
});

// ---------- état interne ----------
let state = 'NOMINAL';
let failCount = 0;
let cooldownUntil = 0;
const events = [];
function logEvent(msg, level = 'info') {
  const e = { ts: new Date().toISOString(), level, msg };
  events.unshift(e);
  if (events.length > 100) events.pop();
  console.log(`[${level}] ${msg}`);
}
const STATE_CODE = { NOMINAL: 0, INCIDENT: 1, REMEDIATION: 2, VERIFICATION: 3, ESCALADE: 4 };
function setState(s) { state = s; mState.set(STATE_CODE[s]); }
setState('NOMINAL');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function promScalar(query) {
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const res = j.data && j.data.result;
    if (res && res.length) return Number(res[0].value[1]);
  } catch (_) {}
  return null;
}

async function cibleJoignable() {
  try {
    const r = await fetch(`${TARGET_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (_) { return false; }
}

// ---------- détection + classification (2 réponses distinctes) ----------
async function detecter() {
  const up = await cibleJoignable();
  mTargetUp.set(up ? 1 : 0);

  if (!up) {
    failCount++;
    if (failCount >= 2) return { type: 'service-indisponible', playbook: 'redemarrage' };
    return null;
  }
  failCount = 0;

  // Service debout mais sous charge anormale -> réponse différente
  const reqRate = await promScalar(`sum(rate(http_requests_total{service="${TARGET_CONTAINER}"}[1m]))`);
  if (reqRate !== null && reqRate > SEUIL_SURCHARGE) {
    return { type: 'surcharge', playbook: 'mitigation-surcharge' };
  }
  return null;
}

// ---------- vérification de reprise : la transaction de contrôle ----------
async function verifierReprise() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${TARGET_URL}/tx-test`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

// ---------- action Ansible : lancer un playbook dans le conteneur de contrôle ----------
async function lancerPlaybook(target) {
  const container = docker.getContainer(ANSIBLE_CONTAINER);
  const exec = await container.exec({
    Cmd: ['ansible-playbook', ANSIBLE_PLAYBOOK, '-e', `target=${target}`],
    AttachStdout: true, AttachStderr: true, Tty: true,
  });
  const stream = await exec.start({ Tty: true });
  let out = '';
  await new Promise((resolve) => {
    stream.on('data', (c) => { out += c.toString(); });
    stream.on('end', resolve);
  });
  const info = await exec.inspect();
  const recap = out.split('\n').filter((l) => /PLAY RECAP|ok=|changed=|failed=|fatal/.test(l))
    .map((l) => l.trim()).join(' | ');
  if (recap) logEvent(`Ansible > ${recap}`);
  return info.ExitCode === 0;
}

// ---------- boucle de remédiation ----------
async function remedier(incident) {
  const t0 = Date.now();
  setState('REMEDIATION');
  mIncidents.inc({ type: incident.type });
  logEvent(`Incident détecté : ${incident.type} -> playbook « ${incident.playbook} »`, 'warn');

  // Action corrective
  mActions.inc({ action: MODE === 'ansible' ? 'ansible-playbook' : 'restart', playbook: incident.playbook });
  if (MODE === 'ansible') {
    logEvent(`Action : exécution du playbook Ansible « ${ANSIBLE_PLAYBOOK} » (cible ${TARGET_CONTAINER})`);
    try {
      const ok = await lancerPlaybook(TARGET_CONTAINER);
      if (!ok) logEvent('Le playbook Ansible a renvoyé une erreur', 'error');
    } catch (e) {
      logEvent(`Erreur Ansible : ${e.message}`, 'error');
    }
  } else {
    logEvent(`Action : redémarrage du conteneur ${TARGET_CONTAINER} (socket-proxy)`);
    try {
      await docker.getContainer(TARGET_CONTAINER).restart({ t: 2 });
    } catch (e) {
      logEvent(`Erreur lors du redémarrage : ${e.message}`, 'error');
    }
  }

  // Preuve de reprise : nouvelle transaction réussie
  setState('VERIFICATION');
  logEvent('Vérification : exécution d\'une transaction de contrôle (/tx-test)…');
  const ok = await verifierReprise();

  if (ok) {
    const mttr = (Date.now() - t0) / 1000;
    mRecovery.observe(mttr);
    mLastMttr.set(mttr);
    logEvent(`Service rétabli en ${mttr.toFixed(1)} s — transaction test OK ✓`, 'success');
    setState('NOMINAL');
  } else {
    logEvent('Échec de la vérification — escalade (intervention humaine requise)', 'error');
    setState('ESCALADE');
  }
  cooldownUntil = Date.now() + 20000; // anti-rebond
}

async function boucle() {
  if (Date.now() < cooldownUntil) return;
  if (state === 'REMEDIATION' || state === 'VERIFICATION') return;
  if (state === 'ESCALADE') {
    // en escalade, on re-teste la cible : si elle revient, on repasse nominal
    if (await cibleJoignable()) { logEvent('Cible de nouveau joignable, retour en nominal.'); setState('NOMINAL'); }
    return;
  }
  const incident = await detecter();
  if (incident) await remedier(incident);
}

// ---------- API HTTP ----------
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE, state }));
app.get('/status', (req, res) => res.json({
  state, target: TARGET_CONTAINER,
  lastEvents: events.slice(0, 20),
}));
app.get('/events', (req, res) => res.json(events));
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logEvent(`Moteur de remédiation démarré — cible ${TARGET_CONTAINER}, surveillance toutes les ${POLL_MS / 1000}s`);
  setInterval(() => boucle().catch((e) => logEvent('Erreur boucle : ' + e.message, 'error')), POLL_MS);
});
