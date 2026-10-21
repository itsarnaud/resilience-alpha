"""Evaluate a trusted model on separately labelled feature windows."""

import argparse
import hashlib
import json
from pathlib import Path

from resilience_alpha_ai.anomaly_detection.model_loader import load_model

from resilience_alpha_ai.anomaly_detection.predict import predict_windows


def evaluate(artifact, rows):
    if not rows:
        raise ValueError("Evaluation dataset is empty")

    for index, row in enumerate(rows):
        if type(row.get("label")) is not bool:
            raise ValueError(f"Row {index}: label must be true or false")

    if {row["label"] for row in rows} != {True, False}:
        raise ValueError("Include both normal and attack windows")

    predictions = predict_windows(artifact, rows)
    tp = fp = tn = fn = 0

    for row, prediction in zip(rows, predictions):
        actual = row["label"]
        detected = prediction["is_anomaly"]
        tp += int(actual and detected)
        fp += int(not actual and detected)
        tn += int(not actual and not detected)
        fn += int(actual and not detected)

    def ratio(numerator, denominator):
        return numerator / denominator if denominator else None

    return {
        "windows": len(rows),
        "true_positives": tp,
        "false_positives": fp,
        "true_negatives": tn,
        "false_negatives": fn,
        "precision": ratio(tp, tp + fp),
        "recall": ratio(tp, tp + fn),
        "false_positive_rate": ratio(fp, fp + tn),
        "training_data_origin": artifact["data_origin"],
        "model_status": artifact["status"],
        "predictions": predictions,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--threshold-config", type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--data-origin", required=True, choices=["synthetic", "platform"]
    )
    args = parser.parse_args()

    if args.output.resolve() in {
        args.input.resolve(), args.model.resolve()
    }:
        parser.error("Output must differ from input and model")
    if args.output.exists():
        parser.error("Output already exists; choose a new filename")

    rows = json.loads(args.input.read_text(encoding="utf-8-sig"))
    if not isinstance(rows, list):
        parser.error("Input must be a JSON list")

    # Load only a model created locally or obtained from a trusted source.
    artifact = load_model(args.model, args.threshold_config)
    report = evaluate(artifact, rows)
    report["evaluation_data_origin"] = args.data_origin
    report["threshold_status"] = artifact.get("threshold_status", "model_default")
    if args.threshold_config:
        report["threshold_config_sha256"] = hashlib.sha256(args.threshold_config.read_bytes()).hexdigest()
    report["model_sha256"] = hashlib.sha256(
        args.model.read_bytes()
    ).hexdigest()
    report["evaluation_sha256"] = hashlib.sha256(
        args.input.read_bytes()
    ).hexdigest()
    report["limitations"] = [
        "Labels must come from the recorded test scenario.",
        "Use evaluation sessions separate from training and tuning.",
        "This report does not validate automatic remediation.",
        "Detection delay is not measured by this evaluator.",
    ]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)

    print(json.dumps(
        {key: value for key, value in report.items() if key != "predictions"},
        indent=2,
    ))
    print(f"Report saved: {args.output}")


if __name__ == "__main__":
    main()
