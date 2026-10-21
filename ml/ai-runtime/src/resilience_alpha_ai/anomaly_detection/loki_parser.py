"""Parse authentication events from a Loki query_range response."""

import json

from resilience_alpha_ai.anomaly_detection.auth_log_adapter import parse_auth_log


def decode_log_line(line: str) -> dict:
    """Accept application JSON directly or inside a Docker log wrapper."""
    record = json.loads(line)

    if isinstance(record, dict) and isinstance(record.get("log"), str):
        record = json.loads(record["log"])

    if not isinstance(record, dict):
        raise ValueError("Expected a JSON log object")

    return record


def parse_loki_response(payload: dict) -> dict:
    """Parse streams and report rejected lines rather than hiding them."""
    if payload.get("status") != "success":
        raise ValueError("Loki query did not succeed")

    data = payload.get("data", {})
    if data.get("resultType") != "streams":
        raise ValueError("Expected a Loki streams response")

    events = []
    rejected = []
    ignored = 0
    duplicates = 0
    seen = {}

    for stream in data.get("result", []):
        for timestamp_ns, line in stream["values"]:
            try:
                record = decode_log_line(line)
                event = parse_auth_log(record)
            except (ValueError, TypeError) as error:
                rejected.append({
                    "timestamp_ns": timestamp_ns,
                    "error": str(error),
                })
                continue

            if event is None:
                ignored += 1
                continue

            request_id = record.get("request_id")
            if isinstance(request_id, str) and request_id.strip():
                key = ("request", record["event"], request_id.strip())
            else:
                key = (
                    "log",
                    timestamp_ns,
                    json.dumps(record, sort_keys=True),
                )

            if key in seen:
                if seen[key] != event:
                    raise ValueError(
                        "Conflicting authentication events share an identity"
                    )
                duplicates += 1
                continue

            seen[key] = event
            events.append(event)

    events.sort(key=lambda event: event.timestamp)

    return {
        "events": events,
        "ignored": ignored,
        "duplicates": duplicates,
        "rejected": rejected,
    }


if __name__ == "__main__":
    sample = {
        "service": "auth",
        "time": "2026-10-20T07:00:00.000Z",
        "event": "login_failed",
        "email": "demo@example.test",
        "ip": "192.0.2.10",
        "request_id": "synthetic-request-1",
    }

    wrapped_success = {
        **sample,
        "event": "login_succeeded",
        "request_id": "synthetic-request-2",
    }

    payload = {
        "status": "success",
        "data": {
            "resultType": "streams",
            "result": [{
                "stream": {"container": "auth"},
                "values": [
                    ["1792479600000000000", json.dumps(sample)],
                    ["1792479600000000001",
                     json.dumps({"log": json.dumps(wrapped_success)})],
                    ["1792479600000000002", "invalid-json"],
                    ["1792479600000000003",
                     json.dumps({"service": "auth", "event": "started"})],
                ],
            }],
        },
    }

    values = payload["data"]["result"][0]["values"]
    values.append(values[0])

    result = parse_loki_response(payload)
    assert result["duplicates"] == 1
    assert len(result["events"]) == 2
    assert result["events"][0].outcome == "failure"
    assert result["events"][1].outcome == "success"
    assert result["ignored"] == 1
    assert len(result["rejected"]) == 1

    print(f"Authentication events: {len(result['events'])}")
    print(f"Unrelated logs ignored: {result['ignored']}")
    print(f"Malformed logs reported: {len(result['rejected'])}")
    print(f"Duplicates removed: {result['duplicates']}")
    print("Parser checks passed.")
