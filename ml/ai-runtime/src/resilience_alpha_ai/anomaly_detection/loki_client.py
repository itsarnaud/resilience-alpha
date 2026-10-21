"""Fetch a bounded Loki log snapshot for inspection and evaluation."""

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from resilience_alpha_ai.anomaly_detection.loki_parser import parse_loki_response


def fetch_logs(
    base_url: str,
    query: str,
    start: datetime,
    end: datetime,
    limit: int = 5000,
) -> dict:
    url = urlsplit(base_url)
    if url.scheme not in {"http", "https"} or not url.netloc:
        raise ValueError("Provide an HTTP(S) Loki URL")
    if url.query or url.fragment or url.username or url.password:
        raise ValueError("URL must not contain credentials, query or fragment")
    if any(value.utcoffset() is None for value in (start, end)):
        raise ValueError("Query timestamps must include timezones")
    if start >= end or limit <= 0:
        raise ValueError("Invalid query range or limit")

    parameters = urlencode({
        "query": query,
        "start": start.astimezone(timezone.utc).isoformat(),
        "end": end.astimezone(timezone.utc).isoformat(),
        "direction": "forward",
        "limit": limit,
    })
    endpoint = base_url.rstrip("/") + "/loki/api/v1/query_range"
    request = Request(
        endpoint + "?" + parameters,
        headers={"Accept": "application/json"},
    )

    maximum_bytes = 16 * 1024 * 1024
    with urlopen(request, timeout=15) as response:
        content = response.read(maximum_bytes + 1)

    if len(content) > maximum_bytes:
        raise ValueError("Response exceeds 16 MB; use a shorter time range")

    payload = json.loads(content)
    if not isinstance(payload, dict):
        raise ValueError("Invalid Loki response")

    parsed = parse_loki_response(payload)
    count = sum(
        len(stream["values"])
        for stream in payload["data"]["result"]
    )
    if count >= limit:
        raise ValueError(
            "Result limit reached: snapshot may be incomplete. "
            "Use a shorter time range."
        )
    if parsed["rejected"]:
        raise ValueError(
            f"{len(parsed['rejected'])} malformed log lines; "
            "inspect the log format before using this collector."
        )

    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--lookback-seconds", type=int, default=300)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if args.lookback_seconds <= 0:
        parser.error("Lookback must be positive")
    if args.output.exists():
        parser.error("Output already exists; choose another filename")

    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=args.lookback_seconds)
    payload = fetch_logs(args.url, args.query, start, end)
    parsed = parse_loki_response(payload)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(payload, stream, indent=2)

    print(f"Authentication events: {len(parsed['events'])}")
    print(f"Unrelated logs: {parsed['ignored']}")
    print(f"Snapshot saved to: {args.output}")
