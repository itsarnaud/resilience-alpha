// application — sert le back-office (page de login MFA) et relaie /api/auth/* vers le service auth.
const express = require('express');
const client = require('prom-client');

const SERVICE = 'application';
const AUTH_URL = process.env.AUTH_URL || 'http://auth:3000';

const app = express();
app.use(express.json({ limit: '6mb' }));

const register = client.register;
client.collectDefaultMetrics();
register.setDefaultLabels({ service: SERVICE });
const httpRequests = new client.Counter({ name: 'http_requests_total', help: 'Requetes HTTP', labelNames: ['method', 'route', 'status'] });
app.use((req, res, next) => { res.on('finish', () => httpRequests.inc({ method: req.method, route: req.path.startsWith('/api') ? '/api' : req.path, status: res.statusCode })); next(); });

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));
app.get('/metrics', async (req, res) => { res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

// Proxy vers le service auth (le navigateur ne peut pas joindre auth:3000 directement)
app.post('/api/auth/:action', async (req, res) => {
  try {
    const r = await fetch(`${AUTH_URL}/${req.params.action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    res.status(r.status).json(j);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'auth indisponible' });
  }
});

app.get(['/', '/login'], (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.end(PAGE); });
app.get('/enroll', (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.end(ENROLL); });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`${SERVICE} (back-office) up on :${port}`));

// ================= PAGE DE LOGIN =================
const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Back-office — RESILIENCE-ALPHA</title>
<style>
  :root{--bg:#0f1420;--card:#192234;--line:#2a3550;--fg:#e8ecf5;--muted:#93a0b8;--accent:#3a6ff7;--green:#2fbf6b;--red:#e5484d}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,Segoe UI,Roboto,sans-serif;min-height:100vh;display:grid;place-items:center}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;width:380px;max-width:92vw}
  h1{font-size:1.15rem;margin:0 0 4px} .sub{color:var(--muted);font-size:.85rem;margin:0 0 20px}
  label{display:block;font-size:.8rem;color:var(--muted);margin:14px 0 6px}
  input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#0e1626;color:var(--fg);font-size:1rem}
  button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  video{width:100%;border-radius:10px;background:#000;margin-top:8px;transform:scaleX(-1)}
  .led{width:16px;height:16px;border-radius:50%;background:#333;display:inline-block;vertical-align:middle;margin-right:8px}
  .ledwrap{display:flex;align-items:center;gap:8px;font-size:.8rem;color:var(--muted);margin-top:16px;border-top:1px solid var(--line);padding-top:14px}
  .msg{margin-top:14px;font-size:.85rem;min-height:18px} .err{color:var(--red)} .ok{color:var(--green)}
  .green-blink{background:var(--green);animation:bl .6s infinite} .green-solid{background:var(--green)}
  .red-blink{background:var(--red);animation:bl .25s infinite} .red-solid{background:var(--red)}
  @keyframes bl{50%{opacity:.2}}
  .step{display:none} .step.active{display:block}
  a{color:var(--accent);font-size:.8rem}
</style></head><body>
<div class="card">
  <h1>Back-office RESILIENCE-ALPHA</h1>
  <p class="sub">Authentification renforcée (identifiant · visage · mot de passe)</p>

  <div id="s-id" class="step active">
    <label>Identifiant</label>
    <input id="username" autocomplete="username" autofocus>
    <button id="btn-id">Continuer</button>
  </div>

  <div id="s-face" class="step">
    <label>Reconnaissance faciale — regardez la caméra</label>
    <video id="video" autoplay playsinline muted></video>
    <button id="btn-face">Scanner mon visage</button>
  </div>

  <div id="s-pwd" class="step">
    <label>Mot de passe</label>
    <input id="password" type="password" autocomplete="current-password">
    <button id="btn-pwd">Se connecter</button>
  </div>

  <div id="s-done" class="step">
    <p class="ok" style="font-size:1.1rem">✓ Connecté au back-office</p>
    <p class="sub" id="done-info"></p>
    <button onclick="location.reload()">Se déconnecter</button>
  </div>

  <div class="msg" id="msg"></div>
  <div class="ledwrap"><span class="led" id="led"></span><span id="ledtxt">LED : éteinte</span></div>
  <div style="margin-top:12px"><a href="/enroll">Enrôler un visage (admin)</a></div>
</div>
<canvas id="canvas" style="display:none"></canvas>
<script>
const $=s=>document.querySelector(s);
let sessionId=null, stream=null, ledTimer=null;
function show(id){document.querySelectorAll('.step').forEach(e=>e.classList.remove('active'));$('#'+id).classList.add('active');}
function msg(t,cls){const m=$('#msg');m.textContent=t||'';m.className='msg '+(cls||'');}
function setLed(state){clearTimeout(ledTimer);const L=$('#led');L.className='led '+(state&&state!=='off'?state:'');
  const names={'green-blink':'vert clignotant','green-solid':'vert fixe','red-blink':'rouge clignotant','red-solid':'rouge fixe'};
  $('#ledtxt').textContent='LED : '+(names[state]||'éteinte');}
async function post(action,body){const r=await fetch('/api/auth/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const t=await r.text();try{return JSON.parse(t);}catch(e){return {ok:false,error:'reponse bloquee (WAF ?) - '+r.status};}}
function stopCam(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}}

$('#btn-id').onclick=async()=>{
  const username=$('#username').value.trim(); if(!username)return;
  msg('');const j=await post('identify',{username});
  if(j.blocked){msg('Trop d\\'échecs. Réessayez dans '+j.retryInSec+' s.','err');return;}
  if(!j.ok){msg('Identifiant invalide.','err');return;}
  sessionId=j.sessionId; show('s-face');
  try{stream=await navigator.mediaDevices.getUserMedia({video:true});$('#video').srcObject=stream;}
  catch(e){msg('Caméra inaccessible (ouvrez la page sur http://localhost du PC Hôte).','err');}
};

$('#btn-face').onclick=async()=>{
  if(!stream){msg('Caméra non active.','err');return;}
  const v=$('#video'),c=$('#canvas');const sc=Math.min(1,480/(v.videoWidth||480));c.width=(v.videoWidth||480)*sc;c.height=(v.videoHeight||360)*sc;
  c.getContext('2d').drawImage(v,0,0,c.width,c.height);const image=c.toDataURL('image/jpeg',0.75).split(',')[1];
  msg('Analyse…');const j=await post('face',{sessionId,image});setLed(j.led);
  if(j.recognized){stopCam();msg('Visage reconnu.','ok');show('s-pwd');$('#password').focus();return;}
  if(j.blocked){stopCam();msg('Non reconnu 2 fois — bloqué '+j.retryInSec+' s.','err');let t=j.retryInSec;ledTimer=setInterval(()=>{},0);
    const iv=setInterval(()=>{t--;if(t<=0){clearInterval(iv);location.reload();}},1000);return;}
  // non reconnu : rouge fixe 30 s puis retour identification
  stopCam();let t=30;msg('Visage non reconnu. Nouvelle tentative dans '+t+' s… (essais restants : '+(j.triesLeft)+')','err');
  const iv=setInterval(()=>{t--;if(t<=0){clearInterval(iv);setLed('off');show('s-id');msg('');$('#username').value='';$('#username').focus();}
    else msg('Visage non reconnu. Nouvelle tentative dans '+t+' s…','err');},1000);
};

$('#btn-pwd').onclick=async()=>{
  const password=$('#password').value;const j=await post('password',{sessionId,password});setLed(j.led);
  if(j.ok){$('#done-info').textContent='Rôle : '+j.role;show('s-done');
    setTimeout(()=>setLed('off'),30000);return;}
  // mot de passe faux : rouge clignote puis on recommence tout
  msg('Mot de passe incorrect. On recommence l\\'identification.','err');
  setTimeout(()=>{setLed('off');sessionId=null;$('#password').value='';$('#username').value='';show('s-id');msg('');$('#username').focus();},2500);
};
</script></body></html>`;

// ================= PAGE D'ENRÔLEMENT (admin) =================
const ENROLL = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Enrôlement visage</title>
<style>body{margin:0;background:#0f1420;color:#e8ecf5;font-family:system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}
.card{background:#192234;border:1px solid #2a3550;border-radius:16px;padding:28px;width:380px;max-width:92vw}
input{width:100%;padding:11px;border-radius:9px;border:1px solid #2a3550;background:#0e1626;color:#e8ecf5;margin:6px 0}
video{width:100%;border-radius:10px;background:#000;transform:scaleX(-1)}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:9px;background:#3a6ff7;color:#fff;font-weight:600;cursor:pointer}
.msg{margin-top:12px;font-size:.85rem}a{color:#3a6ff7;font-size:.8rem}</style></head><body>
<div class="card"><h1 style="font-size:1.1rem">Enrôler un visage</h1>
<input id="u" placeholder="identifiant"><input id="p" placeholder="mot de passe (si nouvel utilisateur)">
<video id="v" autoplay playsinline muted></video>
<button id="b">Capturer et enrôler</button><div class="msg" id="m"></div>
<div style="margin-top:12px"><a href="/login">← Retour au login</a></div></div>
<canvas id="c" style="display:none"></canvas>
<script>
let st;navigator.mediaDevices.getUserMedia({video:true}).then(s=>{st=s;document.getElementById('v').srcObject=s;})
  .catch(()=>document.getElementById('m').textContent='Caméra inaccessible (ouvrez sur http://localhost).');
document.getElementById('b').onclick=async()=>{
  const v=document.getElementById('v'),c=document.getElementById('c');const sc=Math.min(1,480/(v.videoWidth||480));c.width=(v.videoWidth||480)*sc;c.height=(v.videoHeight||360)*sc;
  c.getContext('2d').drawImage(v,0,0,c.width,c.height);const image=c.toDataURL('image/jpeg',0.8).split(',')[1];
  const username=document.getElementById('u').value.trim();const password=document.getElementById('p').value;
  if(!username){document.getElementById('m').textContent='Identifiant requis';return;}
  document.getElementById('m').textContent='Enrôlement…';
  try{const r=await fetch('/api/auth/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,image})});
  const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j={ok:false,error:'reponse bloquee (WAF ?) - '+r.status};}
  document.getElementById('m').textContent=j.ok?('✓ Enrôlé ('+j.samples+' échantillon(s))'):('Échec : '+(j.error||''));}
  catch(e){document.getElementById('m').textContent='Erreur réseau : '+e.message;} };
</script></body></html>`;
