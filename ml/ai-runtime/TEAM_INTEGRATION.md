# AI integration review

Standalone Python project imported into ml/ai-runtime. The team's root package files, services and existing ml/face are unchanged. The separate SFace prototype is omitted; use the team's existing face service.

## Verified locally

34 automated tests passed in the AI Docker image before import. Local real auth logs passed through Loki, ML, persistence and authenticated API access. The integrated Docker worker generated deduplicated preview incidents. Delivery retry/permission behavior was tested with mocks, not a live remediation engine.

The fixed-threshold evaluation of eight fresh local auth-service windows has TP=3, FP=0, TN=5, FN=0. See reports/validation for actual recorded results and limitations. Training remains synthetic; model and threshold stay provisional. These results do not establish general reliability.

RAG: local Ollama + LangChain, qwen2.5:3b; PDF and Markdown documents; authenticated Docker API tested with sources and unknown-information refusal. One broad question returned a vague answer, so answer quality still needs review across operator use cases.

## Deploy

Run commands from ml/ai-runtime, not repository root. Follow deploy/AI_HANDOFF.md and deploy/INCIDENT_PIPELINE.md. Copy deploy/ai.env.example to deploy/ai.env only if it does not exist, then adapt service URLs and networks to the team's deployment. Never commit secrets. Host lab addresses are examples, not deployment confirmation.

Models and corpus were copied into this local checkout for preparation but are Git-ignored. A teammate cloning the branch must receive the files listed in ARTIFACT_MANIFEST.json through the agreed artifact transfer and verify SHA-256 checksums. No virtual environments, SQLite state, raw logs or biometric references are imported. Evaluation JSON uses only the controlled local demo account and Docker gateway IP.

The source corpus is a snapshot copied from Jamal's tested environment; it is not automatically refreshed from team main. Check SOURCE_VERSION.txt and refresh docs after architecture changes. Rebuild/restart the assistant after corpus updates.

## Still pending

- Review representative model evaluation and approve deployment scope; no metadata-only validation.
- Team service/network addresses and protected-endpoint smoke tests on the final host.
- Dashboard calls and source rendering.
- Real svc:detector credentials, incident acceptance, attacker IP attribution, WAF action and successful canary recovery.
- Recovery feedback to close active detector episodes.
- Team face-service final tests and previously reported invalid-image/authentication issues.

This branch is prepared locally only. Nothing has been pushed or merged.
