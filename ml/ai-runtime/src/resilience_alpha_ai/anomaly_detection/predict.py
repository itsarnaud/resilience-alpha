"""Score authentication windows using a saved local model."""

import argparse
import json
import math
from datetime import datetime
from pathlib import Path

import joblib
import sklearn

from resilience_alpha_ai.anomaly_detection.features import FEATURE_NAMES
from resilience_alpha_ai.anomaly_detection.train import feature_matrix


def predict_windows(artifact: dict, rows: list[dict]) -> list[dict]:
    if artifact["feature_names"] != list(FEATURE_NAMES):
        raise ValueError("Model and input feature order do not match")
    if artifact["sklearn_version"] != sklearn.__version__:
        raise ValueError("Use the scikit-learn version used for training")

    if not rows:
        return []

    for row in rows:
        start = datetime.fromisoformat(row["window_start"])
        end = datetime.fromisoformat(row["window_end"])
        if start.utcoffset() is None or end.utcoffset() is None:
            raise ValueError("Window timestamps must include timezones")
        if (end - start).total_seconds() != artifact["window_seconds"]:
            raise ValueError("Input window length differs from training")

    threshold = artifact.get("decision_threshold", float(-artifact["model"].offset_))
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError("Invalid decision threshold")

    matrix = feature_matrix(rows)
    decisions = artifact["model"].decision_function(matrix)
    predictions = artifact["model"].predict(matrix)

    results = []
    for row, decision, prediction in zip(rows, decisions, predictions):
        score = float(-decision - artifact["model"].offset_)
        if not 0 <= score <= 1:
            raise ValueError("Model score outside expected 0-1 range")
        results.append({
            "source_ip": row["source_ip"],
            "window_end": row["window_end"],
            "is_anomaly": bool(score > threshold),
            "threshold_status": artifact.get("threshold_status", "model_default"),
            "anomaly_score": float(-decision),
            "score": score,
            "threshold": threshold,
            "score_method": "negative_score_samples",
            "features": {
                name: row[name] for name in FEATURE_NAMES
            },
            "training_data_origin": artifact["data_origin"],
            "model_status": artifact["status"],
        })

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--threshold-config", type=Path)
    args = parser.parse_args()

    # Load only model artifacts created by this project or a trusted source.
    from resilience_alpha_ai.anomaly_detection.model_loader import load_model
    artifact = load_model(args.model, args.threshold_config)
    rows = json.loads(args.input.read_text(encoding="utf-8-sig"))
    if not isinstance(rows, list):
        parser.error("Input must contain a JSON list of feature rows")

    results = predict_windows(artifact, rows)
    print(json.dumps(results, indent=2))
