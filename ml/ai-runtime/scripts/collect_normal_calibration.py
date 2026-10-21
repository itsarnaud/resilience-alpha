"""Collect ten normal local-auth windows for preliminary calibration."""

import json
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from resilience_alpha_ai.anomaly_detection.auth_log_adapter import parse_auth_log
from resilience_alpha_ai.anomaly_detection.features import build_features

folder = Path("data/raw")
session = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
rows = []
# Each pair is (total attempts, intentional password mistakes).
patterns = [(1,0), (3,1), (6,0), (8,1), (2,0),
            (4,2), (10,1), (5,0), (3,0), (7,1)]

with httpx.Client(timeout=10) as client:
    for number, (attempts, mistakes) in enumerate(patterns, start=1):
        start = datetime.now(timezone.utc)
        end = start + timedelta(seconds=60)
        clock = time.monotonic()

        for index in range(attempts):
            wrong = index < mistakes
            response = client.post(
                "http://127.0.0.1:3001/v1/login",
                json={
                    "email": "customer@example.test",
                    "password": "WrongPassword123" if wrong else "DemoCustomer123",
                },
            )
            expected = 401 if wrong else 200
            if response.status_code != expected:
                raise SystemExit(f"Unexpected HTTP {response.status_code}")
            time.sleep(max(
                0, clock + (index + 1) * 55 / attempts - time.monotonic()
            ))

        time.sleep(max(0, clock + 60.2 - time.monotonic()))
        result = subprocess.run(
            ["docker", "logs", "--since", start.isoformat(),
             "--until", end.isoformat(), "resilience-ai-lab-auth"],
            capture_output=True, check=True,
        )
        records = [
            json.loads(line)
            for line in (result.stdout + b"\n" + result.stderr)
            .decode("utf-8").splitlines() if line.strip()
        ]
        events = [
            event for record in records
            if (event := parse_auth_log(record)) is not None
        ]
        features = build_features(events, window_end=end)
        if len(features) != 1:
            raise SystemExit("Expected exactly one source in this lab window")
        row = features[0]
        if row["attempt_count"] != attempts or row["failure_count"] != mistakes:
            raise SystemExit("Observed logs differ from the planned window")
        row.update(label=False, session_id=session, purpose="calibration")
        rows.append(row)

        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"calibration_{session}_{number:02}.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        output = Path("data/processed") / f"normal_calibration_{session}.json"
        output.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        print(f"Window {number}/10 saved: {attempts} attempts, {mistakes} mistakes",
              flush=True)

print(f"Complete: {output}", flush=True)
