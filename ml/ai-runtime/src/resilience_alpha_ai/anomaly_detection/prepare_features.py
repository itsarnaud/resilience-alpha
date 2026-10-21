"""Read authentication events from JSONL and export window features."""

import argparse
import json
from datetime import datetime
from pathlib import Path

from resilience_alpha_ai.anomaly_detection.events import AuthenticationEvent
from resilience_alpha_ai.anomaly_detection.features import build_features


def load_events(path: Path) -> list[AuthenticationEvent]:
    events = []

    with path.open(encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object")
                events.append(AuthenticationEvent.from_dict(data))
            except (ValueError, TypeError) as error:
                raise ValueError(
                    f"{path.name}, line {line_number}: {error}"
                ) from error

    return events


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--window-seconds", type=int, default=60)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files")

    events = load_events(args.input)
    window_end = datetime.fromisoformat(
        args.window_end.replace("Z", "+00:00")
    )
    rows = build_features(events, window_end, args.window_seconds)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(rows, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Loaded events: {len(events)}")
    print(f"Sources active in window: {len(rows)}")
    print(f"Features saved to: {args.output}")
