"""Analyze a saved Loki snapshot without sending remediation requests."""

import argparse
import json
from datetime import datetime
from pathlib import Path

import joblib

from resilience_alpha_ai.anomaly_detection.features import build_features
from resilience_alpha_ai.anomaly_detection.loki_parser import parse_loki_response
from resilience_alpha_ai.anomaly_detection.predict import predict_windows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if args.output.exists():
        parser.error("Output exists; choose another filename")

    payload = json.loads(args.input.read_text(encoding="utf-8-sig"))
    parsed = parse_loki_response(payload)

    if parsed["rejected"]:
        parser.error(
            f"{len(parsed['rejected'])} malformed logs: analysis stopped"
        )

    # Load a model artifact created by this project.
    artifact = joblib.load(args.model)
    end = datetime.fromisoformat(args.window_end.replace("Z", "+00:00"))
    features = build_features(
        parsed["events"],
        window_end=end,
        window_seconds=artifact["window_seconds"],
    )
    predictions = predict_windows(artifact, features)

    report = {
        "input_file": args.input.name,
        "window_end": end.isoformat(),
        "window_seconds": artifact["window_seconds"],
        "parsed_events": len(parsed["events"]),
        "duplicates_removed": parsed["duplicates"],
        "unrelated_logs": parsed["ignored"],
        "predictions": predictions,
        "remediation_sent": False,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)

    print(f"Parsed events: {len(parsed['events'])}")
    print(f"Sources in window: {len(predictions)}")
    print(f"Flagged sources: {sum(p['is_anomaly'] for p in predictions)}")
    print(f"Report: {args.output}")
    print("No remediation requests sent.")
