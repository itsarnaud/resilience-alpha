"""Calculate authentication features over a trailing time window."""

from datetime import datetime, timedelta, timezone

from resilience_alpha_ai.anomaly_detection.events import AuthenticationEvent


FEATURE_NAMES = (
    "attempt_count",
    "failure_count",
    "success_count",
    "failure_ratio",
    "unique_accounts",
)


def build_features(
    events: list[AuthenticationEvent],
    window_end: datetime,
    window_seconds: int = 60,
) -> list[dict]:
    """Group events by source IP within (window_start, window_end]."""
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")
    if window_end.tzinfo is None or window_end.utcoffset() is None:
        raise ValueError("window_end must include a timezone")

    window_end = window_end.astimezone(timezone.utc)
    window_start = window_end - timedelta(seconds=window_seconds)
    groups: dict[str, list[AuthenticationEvent]] = {}

    for event in events:
        if window_start < event.timestamp <= window_end:
            groups.setdefault(event.source_ip, []).append(event)

    rows = []
    for source_ip, group in sorted(groups.items()):
        failures = sum(event.outcome == "failure" for event in group)
        attempts = len(group)

        rows.append({
            "source_ip": source_ip,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "attempt_count": attempts,
            "failure_count": failures,
            "success_count": attempts - failures,
            "failure_ratio": failures / attempts,
            "unique_accounts": len({event.account_id for event in group}),
        })

    return rows


if __name__ == "__main__":
    import json

    end = datetime(2026, 10, 20, 7, 1, tzinfo=timezone.utc)

    def example(seconds_ago, account, outcome):
        return AuthenticationEvent.from_dict({
            "timestamp": (end - timedelta(seconds=seconds_ago)).isoformat(),
            "source_ip": "192.0.2.10",
            "account_id": account,
            "outcome": outcome,
        })

    events = [
        example(40, "demo-user", "failure"),
        example(20, "demo-user", "failure"),
        example(5, "another-user", "success"),
        example(60, "excluded-old", "failure"),
        example(-1, "excluded-future", "failure"),
    ]

    rows = build_features(events, window_end=end)
    row = rows[0]

    assert row["attempt_count"] == 3
    assert row["failure_count"] == 2
    assert row["success_count"] == 1
    assert row["unique_accounts"] == 2
    assert abs(row["failure_ratio"] - 2 / 3) < 1e-9
    assert build_features([], window_end=end) == []

    print(json.dumps(rows, indent=2))
    print("\nChecks passed: counts, time boundaries and empty input.")
