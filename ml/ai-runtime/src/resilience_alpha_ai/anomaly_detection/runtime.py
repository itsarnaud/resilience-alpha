"""Run authentication anomaly detection in observation mode."""

import argparse
import json
import signal
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from resilience_alpha_ai.anomaly_detection.model_loader import load_model

from resilience_alpha_ai.anomaly_detection.observation_store import ObservationStore

from resilience_alpha_ai.anomaly_detection.features import build_features
from resilience_alpha_ai.anomaly_detection.loki_client import fetch_logs
from resilience_alpha_ai.anomaly_detection.loki_parser import parse_loki_response
from resilience_alpha_ai.anomaly_detection.predict import predict_windows


def analyze_payload(payload: dict, artifact: dict, end: datetime) -> dict:
    parsed = parse_loki_response(payload)
    if parsed["rejected"]:
        raise ValueError("Malformed logs: scoring skipped")

    features = build_features(
        parsed["events"],
        window_end=end,
        window_seconds=artifact["window_seconds"],
    )
    predictions = predict_windows(artifact, features)

    return {
        "mode": "observe",
        "status": "scored" if predictions else "no_auth_events_in_window",
        "window_end": end.isoformat(),
        "window_seconds": artifact["window_seconds"],
        "duplicates_removed": parsed["duplicates"],
        "unrelated_logs": parsed["ignored"],
        "events_in_window": sum(row["attempt_count"] for row in features),
        "predictions": predictions,
        "remediation_sent": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path)
    source.add_argument("--loki-url")
    parser.add_argument("--query")
    parser.add_argument("--window-end")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--threshold-config", type=Path)
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--ingestion-delay-seconds", type=float, default=5)
    parser.add_argument("--query-margin-seconds", type=float, default=15)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--state-db", type=Path)
    args = parser.parse_args()

    if args.poll_seconds <= 0:
        parser.error("Polling interval must be positive")
    if args.ingestion_delay_seconds < 0 or args.query_margin_seconds < 0:
        parser.error("Delay and query margin cannot be negative")
    if args.snapshot and not args.window_end:
        parser.error("Snapshot mode requires --window-end")
    if args.loki_url and (not args.query or args.window_end):
        parser.error("Live mode requires --query and uses the current time")

    # Only load trusted model artifacts.
    artifact = load_model(args.model, args.threshold_config)
    stop = threading.Event()

    def request_stop(*_):
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    while not stop.is_set():
        try:
            if args.snapshot:
                end = datetime.fromisoformat(
                    args.window_end.replace("Z", "+00:00")
                )
                payload = json.loads(
                    args.snapshot.read_text(encoding="utf-8-sig")
                )
            else:
                end = datetime.now(timezone.utc) - timedelta(
                    seconds=args.ingestion_delay_seconds
                )
                start = end - timedelta(
                    seconds=artifact["window_seconds"]
                    + args.query_margin_seconds
                )
                payload = fetch_logs(args.loki_url, args.query, start, end)

            report = analyze_payload(payload, artifact, end)
            if args.state_db:
                ObservationStore(args.state_db).save(report)
            print(json.dumps(report, allow_nan=False), flush=True)

        except Exception as error:
            # Errors are never represented as a normal/healthy prediction.
            print(json.dumps({
                "mode": "observe",
                "status": "error",
                "error_type": type(error).__name__,
                "remediation_sent": False,
            }), flush=True)
            if args.snapshot or args.once:
                raise SystemExit(1) from None

        if args.snapshot or args.once:
            break

        stop.wait(args.poll_seconds)


if __name__ == "__main__":
    main()
