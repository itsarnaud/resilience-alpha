# AI deployment handoff

This package contains the detector API, RAG API and an optional observation worker. It does not deploy the team's face service or enable incident delivery.

## Verified scope before packaging

- RAG: local Ollama qwen2.5:3b, embeddinggemma:300m, LangChain, mixed PDF/Markdown corpus; 148 passages observed.
- RAG operator login: actual team auth lab JWT accepted (HTTP 200); missing token rejected (401). Unknown-information refusal tested. Dashboard integration pending.
- ML: synthetic training baseline (300 windows); threshold candidate 0.6235500624027918. Separate five-window local service evaluation: TP 1, FP 0, TN 4, FN 0. Preliminary sample only; original model remains prototype_not_validated.
- Real auth logs queried from local Loki and scored successfully; continuous host lab bridge tested with 15 failed logins. IP attribution remains Docker gateway, not an independent attacker.
- Face: team reports deployed integration. Local isolated Docker checks passed for health, missing fields, unknown account and no-face input. Observed invalid-image HTTP 500 and unauthenticated /users; matching face, different-person and full back-office chain not verified here.

## Start APIs

From this AI project root in PowerShell:

```powershell
Copy-Item deploy/ai.env.example deploy/ai.env
New-Item -ItemType Directory -Force .storage | Out-Null
docker compose --env-file deploy/ai.env -f deploy/compose.ai.yaml config --quiet
docker compose --env-file deploy/ai.env -f deploy/compose.ai.yaml build detector
docker run --rm --network none resilience-alpha-ai:package python -m unittest discover -s tests -v
docker compose --env-file deploy/ai.env -f deploy/compose.ai.yaml up -d --no-build detector assistant
```

Copy the example only if ai.env does not exist. Keep local environment files out of Git. Use ports 8011 (detector) and 8012 (assistant); older dev services on 8001/8002 and the host RAG on 8003 are separate.

The detector uses the model-bound threshold file. Health checks prove API liveness only: they do not verify Ollama, JWKS, retrieval quality, collector freshness or remediation.

Models and corpus mount read-only; observation SQLite is shared with the observer. On a Linux host, provision .storage writable by UID/GID 10001 before starting; restrict model and corpus writes to operators. Existing model and candidate files must be supplied through the project artifact process and verified; load only trusted joblib files. Knowledge documents must be supplied separately if data/ is ignored by Git. No model or biometric reference is embedded in the image.

## Deployment addresses

Replace host.docker.internal lab addresses with service DNS names on shared Docker networks when joining the team's stack. Confirm the actual network names and which services/* deployment is active. Never use localhost to refer to another container. Ollama stays local on the agreed host with both models available. Test access from the assistant container; API liveness is insufficient.

## Optional observer

```powershell
docker compose --env-file deploy/ai.env -f deploy/compose.ai.yaml --profile observe up -d --no-build observer
```

The worker reads Loki every 5 seconds, uses 60-second windows and a 5-second ingestion delay, and persists predictions. It does not collect Docker logs itself: a configured log collector must forward auth events into Loki. In the local lab the host observe_live_auth.py bridge supplies them. Stop that host bridge before enabling a second scoring writer, or accept duplicated observation history. Production should run one collector and one observer with agreed labels. Parser errors and truncated snapshots must be resolved, not interpreted as normal activity.

## API contracts

- GET /detector/v1/model, GET /detector/v1/anomalies?limit=200: operator or svc:dashboard JWT.
- POST /assistant/v1/chat JSON {"question":"..."}: operator or svc:dashboard JWT; returns answer and sources (file, excerpt, optional page). incident_id is rejected until incident context integration is implemented.
- GET /detector/healthz and GET /assistant/healthz: public liveness only.
- JWT: RS256, issuer resilience-auth, audience resilience-platform. Admin-only tokens currently do not grant AI API access.

## Remaining integration gates

1. Auth/JWKS and Ollama reachable from packaged containers; authenticated answer and customer-token rejection verified there.
2. Dashboard uses the documented API and shows sources; first request indexes the corpus in memory, later requests reuse it. Restart assistant after corpus updates.
3. Live team Loki labels and real source IP verified; normal and attack scenarios evaluated separately; model remains provisional until reviewed.
4. Detector event classification must be wired to persistent incident queue/delivery; current continuous observer is observation-only. The BRUTE_FORCE preview has stats but does not enable delivery. Persist stable episode keys and include traceable evidence/targets from actual logs. Record delivery acknowledgement separately from successful recovery.
5. Before enabling controlled lab remediation: supply auth token endpoint, remediation API endpoint and svc:detector credentials privately. Validate permission, incident receipt, WAF block of attacker IP, unchanged legitimate access and successful canary transaction before RESOLVED.
6. Save test results and limitations with the technical report. Do not describe five examples as general accuracy or score as attack probability.

## Stop only this package

```powershell
docker compose --env-file deploy/ai.env -f deploy/compose.ai.yaml down
```

Do not add --volumes; other projects are unaffected. Team import should place this standalone Python project under an agreed subtree (for example ml/ai-runtime), preserve the team's root package files and avoid merging unrelated Git roots.
