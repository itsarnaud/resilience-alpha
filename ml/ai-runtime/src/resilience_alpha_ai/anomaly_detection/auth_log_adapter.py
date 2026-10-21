"""Convert team auth JSON logs into validated authentication events."""

from ipaddress import ip_address

from resilience_alpha_ai.anomaly_detection.events import AuthenticationEvent


LOGIN_OUTCOMES = {
    "login_failed": "failure",
    "login_succeeded": "success",
}


def parse_auth_log(record: dict) -> AuthenticationEvent | None:
    """Ignore unrelated records; reject malformed authentication events."""
    if not isinstance(record, dict):
        raise ValueError("Log record must be a JSON object")

    if record.get("service") != "auth":
        return None

    outcome = LOGIN_OUTCOMES.get(record.get("event"))
    if outcome is None:
        return None

    for field in ("time", "ip", "email"):
        value = record.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Authentication log missing valid {field}")

    address = ip_address(record["ip"].strip())
    # Express may report IPv4 addresses in IPv6-mapped form.
    mapped = getattr(address, "ipv4_mapped", None)
    source_ip = str(mapped if mapped is not None else address)

    return AuthenticationEvent.from_dict({
        "timestamp": record["time"],
        "source_ip": source_ip,
        "account_id": record["email"].strip().lower(),
        "outcome": outcome,
    })


if __name__ == "__main__":
    sample = {
        "service": "auth",
        "time": "2026-10-20T07:00:00.000Z",
        "event": "login_failed",
        "email": "Demo@Example.test",
        "ip": "::ffff:192.0.2.10",
        "reason": "bad_password",
        "request_id": "synthetic-request-1",
    }

    event = parse_auth_log(sample)
    assert event is not None
    assert event.source_ip == "192.0.2.10"
    assert event.account_id == "demo@example.test"
    assert event.outcome == "failure"

    success = parse_auth_log({**sample, "event": "login_succeeded"})
    assert success is not None and success.outcome == "success"

    assert parse_auth_log({**sample, "event": "client_token_issued"}) is None
    assert parse_auth_log({**sample, "service": "another-service"}) is None

    try:
        parse_auth_log({**sample, "ip": "invalid"})
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid IP accepted")

    print(event)
    print("Checks passed: login outcomes, IP normalization, filtering, validation.")
