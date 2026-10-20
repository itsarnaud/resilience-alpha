// api-paiement — paiements fictifs + métriques Prometheus + impact métier
const express = require('express');
const client = require('prom-client');

const SERVICE = 'api-paiement';
const app = express();
const register = client.register;

client.collectDefaultMetrics();
register.setDefaultLabels({ service: SERVICE });

// --- métriques HTTP génériques ---
const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requetes HTTP',
  labelNames: ['method', 'route', 'status'],
});
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree des requetes HTTP',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
});

// --- métriques métier : paiements ---
const paiementsTotal = new client.Counter({
  name: 'paiements_total',
  help: 'Nombre de paiements traites',
});
const paiementsMontant = new client.Counter({
  name: 'paiements_montant_euros_total',
  help: 'Montant total encaisse (euros)',
});

// Hypothèse de charge : 1 paiement de 30 € par minute (surchargeable par variables d'env)
const MONTANT = Number(process.env.PAIEMENT_MONTANT || 30);
const INTERVAL_MS = Number(process.env.PAIEMENT_INTERVAL_MS || 60000);

function traiterPaiement(montant = MONTANT) {
  paiementsTotal.inc();
  paiementsMontant.inc(montant);
  return { ok: true, montant, devise: 'EUR' };
}

app.use(express.json());
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route && req.route.path) || req.path || 'unknown';
    const labels = { method: req.method, route, status: res.statusCode };
    httpRequests.inc(labels);
    end(labels);
  });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));
app.get('/', (req, res) => res.json({ service: SERVICE, ok: true }));

// Traiter un paiement à la demande
app.post('/paiement', (req, res) => {
  const montant = Number((req.body && req.body.montant) || MONTANT);
  res.json(traiterPaiement(montant));
});

// Transaction de contrôle : utilisée par le moteur de remédiation pour prouver la reprise
app.get('/tx-test', (req, res) => {
  const r = traiterPaiement(MONTANT);
  res.status(200).json({ txTest: 'ok', ...r });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(SERVICE + ' up on :' + port);
  // Un premier paiement immédiat pour que les compteurs démarrent sans attendre
  traiterPaiement();
  // Simulateur : 1 paiement de MONTANT € toutes les INTERVAL_MS
  setInterval(() => traiterPaiement(), INTERVAL_MS);
  console.log(`Simulateur paiements : ${MONTANT} EUR toutes les ${INTERVAL_MS / 1000}s`);
});
