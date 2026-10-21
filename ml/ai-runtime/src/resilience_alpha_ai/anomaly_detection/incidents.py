"""Build incident payloads matching the team's remediation contract."""

import math
from datetime import datetime, timezone
from ipaddress import ip_address
from uuid import UUID


def build_incident(
    *,
    episode_id: str,
    source_ip: str,
    normalized_score: float,
    detected_at: datetime,
    evidence: list[dict],
    incident_type: str = "UNKNOWN_ANOMALY",
) -> dict:
    """Reuse episode_id for retries of the same incident."""
    episode_id = str(UUID(episode_id))
    source_ip = str(ip_address(source_ip))

    if incident_type not in {"BRUTE_FORCE", "UNKNOWN_ANOMALY"}:
        raise ValueError("Unsupported authentication incident type")

    if (
        isinstance(normalized_score, bool)
        or not isinstance(normalized_score, (int, float))
        or not math.isfinite(normalized_score)
        or not 0 <= normalized_score <= 1
    ):
        raise ValueError("normalized_score must be between 0 and 1")

    if detected_at.utcoffset() is None:
        raise ValueError("detected_at must include a timezone")

    validated_evidence = []
    for item in evidence:
        if item.get("kind") not in {"logql", "promql"}:
            raise ValueError("Evidence kind must be logql or promql")
        if not isinstance(item.get("query"), str) or not item["query"].strip():
            raise ValueError("Evidence must include its actual query")
        value = item.get("value")
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise ValueError("Evidence value must be finite and numerical")
        validated_evidence.append({
            "kind": item["kind"],
            "query": item["query"],
            "value": value,
        })

    return {
        "dedup_key": f"{incident_type}:auth:{episode_id}",
        "type": incident_type,
        "score": float(normalized_score),
        "detected_at": detected_at.astimezone(timezone.utc)
            .isoformat().replace("+00:00", "Z"),
        "target_service": "auth",
        "source_ip": source_ip,
        "evidence": validated_evidence,
    }


if __name__ == "__main__":
    import json

    arguments = {
        "episode_id": "00000000-0000-4000-8000-000000000001",
        "source_ip": "192.0.2.30",
        "normalized_score": 0.8,
        "detected_at": datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc),
        "evidence": [],
    }

    payload = build_incident(**arguments)
    assert payload == build_incident(**arguments)

    try:
        build_incident(**{**arguments, "normalized_score": 1.5})
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid score accepted")

    print(json.dumps(payload, indent=2))
    print("\nChecks passed. Example score only; nothing transmitted.")
