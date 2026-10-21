"""Train an Isolation Forest on authentication-window features."""

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import joblib
import sklearn
from sklearn.ensemble import IsolationForest

from resilience_alpha_ai.anomaly_detection.features import FEATURE_NAMES


def feature_matrix(rows: list[dict]) -> list[list[float]]:
    """Build a numerical matrix in a fixed feature order."""
    if not rows:
        raise ValueError("No feature rows provided")

    matrix = []
    for index, row in enumerate(rows):
        values = []
        for name in FEATURE_NAMES:
            value = row.get(name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"Row {index}: {name} must be numerical")
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"Row {index}: invalid {name}")
            values.append(float(value))

        attempts = row["attempt_count"]
        failures = row["failure_count"]
        successes = row["success_count"]

        if attempts < 1 or failures + successes != attempts:
            raise ValueError(f"Row {index}: inconsistent attempt counts")
        if not math.isclose(row["failure_ratio"], failures / attempts):
            raise ValueError(f"Row {index}: inconsistent failure ratio")
        if not 1 <= row["unique_accounts"] <= attempts:
            raise ValueError(f"Row {index}: inconsistent account count")

        matrix.append(values)

    return matrix


def train_model(rows: list[dict], data_origin: str) -> dict:
    matrix = feature_matrix(rows)

    model = IsolationForest(
        n_estimators=100,
        contamination="auto",
        random_state=42,
        n_jobs=1,
    )
    model.fit(matrix)

    return {
        "model": model,
        "feature_names": list(FEATURE_NAMES),
        "training_rows": len(rows),
        "data_origin": data_origin,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "sklearn_version": sklearn.__version__,
        "window_seconds": 60,
        "status": "prototype_not_validated",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--data-origin",
        required=True,
        choices=["synthetic", "platform"],
    )
    args = parser.parse_args()

    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files")

    rows = json.loads(args.input.read_text(encoding="utf-8-sig"))
    if not isinstance(rows, list):
        parser.error("Input must contain a JSON list of feature rows")
    if len(rows) < 100:
        parser.error(
            "Use at least 100 baseline windows for this prototype. "
            "This development guard does not guarantee sufficient data."
        )

    artifact = train_model(rows, args.data_origin)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, args.output)

    print(f"Training rows: {artifact['training_rows']}")
    print(f"Data origin: {artifact['data_origin']}")
    print(f"Model saved to: {args.output}")
    print("Status: prototype, not validated for automatic remediation")
