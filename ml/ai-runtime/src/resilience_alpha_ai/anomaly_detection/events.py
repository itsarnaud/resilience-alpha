"""Provisional authentication-event schema for anomaly detection."""

from dataclasses import dataclass
from datetime import datetime, timezone
from ipaddress import ip_address


@dataclass(frozen=True)
class AuthenticationEvent:
    timestamp: datetime
    source_ip: str
    account_id: str
    outcome: str

    @classmethod
    def from_dict(cls, data: dict) -> "AuthenticationEvent":
        required = {"timestamp", "source_ip", "account_id", "outcome"}
        missing = required - data.keys()
        if missing:
            raise ValueError(f"Missing fields: {sorted(missing)}")

        for field in required:
            if not isinstance(data[field], str) or not data[field].strip():
                raise ValueError(f"{field} must be a non-empty string")

        timestamp = datetime.fromisoformat(
            data["timestamp"].strip().replace("Z", "+00:00")
        )
        if timestamp.tzinfo is None or timestamp.utcoffset() is None:
            raise ValueError("timestamp must include a timezone")

        source_ip = str(ip_address(data["source_ip"].strip()))
        outcome = data["outcome"].strip().lower()
        if outcome not in {"success", "failure"}:
            raise ValueError("outcome must be success or failure")

        return cls(
            timestamp=timestamp.astimezone(timezone.utc),
            source_ip=source_ip,
            account_id=data["account_id"].strip(),
            outcome=outcome,
        )


if __name__ == "__main__":
    example = {
        "timestamp": "2026-10-20T07:00:00Z",
        "source_ip": "192.0.2.10",
        "account_id": "demo-user",
        "outcome": "failure",
    }
    event = AuthenticationEvent.from_dict(example)
    print("Valid event:")
    print(event)

    try:
        AuthenticationEvent.from_dict({**example, "outcome": "unknown"})
    except ValueError as error:
        print(f"\nInvalid event correctly rejected: {error}")
    else:
        raise SystemExit("Validation failed: invalid outcome accepted")
