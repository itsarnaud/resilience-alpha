"""Generate synthetic baseline windows for pipeline development only."""

import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

from resilience_alpha_ai.anomaly_detection.events import AuthenticationEvent
from resilience_alpha_ai.anomaly_detection.features import build_features


def generate_baseline(count: int = 300, seed: int = 42) -> list[dict]:
    rng = random.Random(seed)
    start = datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)
    rows = []

    for index in range(count):
        end = start + timedelta(minutes=index + 1)
        attempts = rng.randint(1, 12)
        account_pool = [
            f"demo-user-{number}"
            for number in range(rng.randint(1, 3))
        ]
        events = []

        for _ in range(attempts):
            event = AuthenticationEvent.from_dict({
                "timestamp": (
                    end - timedelta(seconds=rng.randint(0, 59))
                ).isoformat(),
                "source_ip": "192.0.2.10",
                "account_id": rng.choice(account_pool),
                "outcome": (
                    "failure" if rng.random() < 0.10 else "success"
                ),
            })
            events.append(event)

        row = build_features(events, window_end=end)[0]
        row["data_origin"] = "synthetic"
        rows.append(row)

    return rows


if __name__ == "__main__":
    output = Path("data/processed/synthetic_baseline_features.json")
    if output.exists():
        raise SystemExit(f"File already exists; unchanged: {output}")

    rows = generate_baseline()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")

    print(f"Synthetic baseline windows: {len(rows)}")
    print("Seed: 42 | Window: 60 seconds")
    print(f"Saved to: {output}")
    print("Development data only; not representative of the platform.")
