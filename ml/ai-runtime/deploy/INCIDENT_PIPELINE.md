# Incident pipeline

`incident_worker` combines Loki retrieval, parsing, the existing ML predictor, incident classification, a persistent episode tracker and the delivery outbox. It defaults to preview. The existing observation worker and host Docker-log bridge are unchanged.

## Classification and evidence

Only ML-flagged windows can create incidents. At least five failures and a failure ratio of at least 0.8 classify a flagged auth window as BRUTE_FORCE; other flagged windows remain UNKNOWN_ANOMALY. These are configurable-in-code classification policy choices to review with the team, not a substitute for ML or proof of malicious intent. The model remains trained on synthetic observations.

Counts are built from the parsed, deduplicated events in (window_start, window_end]. Payload contains attempts, failures, window_seconds and observed failed-account targets. BRUTE_FORCE evidence includes the source LogQL query with failed-event and raw IP filters and the observed failure count. The output also records evidence window bounds. Applying that query over different time bounds can produce different results.

A stable episode ID persists across polls and process restarts. The FIRST incident payload is immutable; overlapping windows do not update or retransmit a delivered episode. Episodes do not auto-close when traffic stops. Following confirmed recovery, a controller must call EpisodeTracker.close_episode(source_ip, expected_episode_id, incident_type). That recovery feedback integration remains pending. UNKNOWN_ANOMALY and BRUTE_FORCE are separate episode types; a source can have an informational incident before the brute-force classification has enough evidence.

## Preview

Install/rebuild the current Python image first. From the project root:

```powershell
docker compose --env-file deploy/ai.env -f deploy/compose.ai.yaml -f deploy/compose.incident-preview.yaml --profile incident-preview up -d --no-build incident-preview
```

Preview data is stored in .storage/incident_preview.sqlite. A database is stamped preview/deliver at creation; preview incidents cannot later be sent by opening that database in delivery mode. The installer offline example uses its own uniquely named preview database. This worker consumes Loki; the log collector still needs to run. It does not receive incident status callbacks, block IPs or recover services.

## Future controlled delivery

Mode deliver exists and is tested with mocked auth/remediation endpoints. It requires BOTH a model artifact marked validated through a reviewed evaluation process AND a non-provisional threshold; the current artifact is blocked. No bypass flag is provided. Keep separate live state. Environment variables are DETECTOR_AUTH_URL (base URL, client appends /v1/token), REMEDIATION_URL (base URL, appends /v1/incidents), DETECTOR_CLIENT_ID and DETECTOR_CLIENT_SECRET. Supply secrets outside Git. Do not treat a metadata edit as validation.

The worker flushes persisted pending incidents on each polling cycle, including collection-error cycles. Network errors, HTTP 429 and 5xx defer with the existing persisted backoff. Contract/permission errors such as 403 stop delivery with the incident pending. Acknowledgement means API acceptance; recovery is only confirmed by the remediation engine and its successful canary transaction.

## Remaining gates

- Validate on representative team-platform normal/attack sessions and agree thresholds/classification policy.
- Configure and test the actual auth token endpoint and service role.
- Verify genuine attacker source IP behind the WAF; Docker gateway IP must not be used as attack attribution.
- Run one delivery worker per state database. Stop duplicate observers if writing to shared history.
- Test real incident acceptance, target account context, WAF response, legitimate access and canary recovery.
- Connect incident resolution feedback to close episodes explicitly.

The mocked tests establish software behavior only, not a successfully deployed remediation chain.
