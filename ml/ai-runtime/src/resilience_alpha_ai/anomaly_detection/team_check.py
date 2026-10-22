"""Check team connectivity and export logs without submitting incidents."""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from resilience_alpha_ai.anomaly_detection.loki_client import fetch_logs
from resilience_alpha_ai.anomaly_detection.loki_parser import parse_loki_response


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(base, path, *, body=None, token=None, timeout=15):
    url = urlsplit(base)
    if (url.scheme not in {"http", "https"} or not url.hostname
            or url.username or url.password or url.query or url.fragment):
        raise ValueError("Use an HTTP(S) service URL without credentials")
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = Request(base.rstrip("/") + path, data=data, headers=headers)
    # Do not leak tokens through redirects or inherit the host's HTTP proxy.
    opener = build_opener(ProxyHandler({}), NoRedirects())
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError("Service response too large")
            return response.status, json.loads(raw)
    except HTTPError as error:
        # Never print error bodies, credentials or bearer tokens.
        status = error.code
        error.close()
        return status, None


def run_checks(config, *, request=request_json, collect=fetch_logs, now=None,
               lookback=300, expected_ip=None, question=None, export_dir=None):
    if not 1 <= lookback <= 3600:
        raise ValueError("Lookback must be between 1 and 3600 seconds")
    end = now or datetime.now(timezone.utc)
    start = end - timedelta(seconds=lookback)
    checks = []

    def add(name, status, **details):
        checks.append({"check": name, "status": status, **details})

    def call(name, base, path, *, expected=200, validate=None, **kwargs):
        try:
            status, body = request(base, path, **kwargs)
            ok = status == expected and (validate is None or validate(body))
            add(name, "pass" if ok else "fail", http_status=status)
            return body if ok else None
        except Exception as error:
            add(name, "fail", error_type=type(error).__name__)
            return None

    call("auth_ready", config["auth"], "/readyz")
    call("auth_jwks", config["auth"], "/.well-known/jwks.json",
         validate=lambda b: isinstance(b, dict) and bool(b.get("keys")))
    call("remediation_ready", config["remediation"], "/readyz")
    call("detector_alive", config["detector"], "/detector/healthz")
    call("assistant_alive", config["assistant"], "/assistant/healthz")
    call("detector_requires_token", config["detector"], "/detector/v1/model", expected=401)
    call("assistant_requires_token", config["assistant"], "/assistant/v1/chat",
         body={"question": "test"}, expected=401)

    if config.get("secret"):
        credentials = call("dashboard_token", config["auth"], "/v1/token",
                           body={"client_id": "svc-dashboard", "client_secret": config["secret"]},
                           validate=lambda b: isinstance(b, dict) and isinstance(b.get("access_token"), str)
                           and bool(b["access_token"]))
        if credentials:
            token = credentials["access_token"]
            model = call("authorized_model", config["detector"], "/detector/v1/model", token=token,
                         validate=lambda b: isinstance(b, dict) and "model_status" in b)
            if model:
                add("model_validation", "info", model_status=model.get("model_status"),
                    threshold_status=model.get("threshold_status"), threshold=model.get("threshold"))
            rows = call("authorized_observations", config["detector"], "/detector/v1/anomalies?limit=20",
                        token=token, validate=lambda b: isinstance(b, list))
            if rows is not None:
                add("observation_count", "info", count=len(rows))
            if question:
                answer = call("rag_generation", config["assistant"], "/assistant/v1/chat", token=token,
                              body={"question": question}, timeout=240,
                              validate=lambda b: isinstance(b, dict) and isinstance(b.get("answer"), str)
                              and isinstance(b.get("sources"), list))
                if answer:
                    add("rag_manual_review", "info", answer=answer["answer"],
                        sources=[{"file": s.get("file"), "page": s.get("page")} for s in answer["sources"]])
    else:
        add("dashboard_token", "pending", reason="Set SVC_DASHBOARD_SECRET in the team env file")

    try:
        payload = collect(config["loki"], config["query"], start, end)
        parsed = parse_loki_response(payload)
        events = parsed["events"]
        counts = Counter(event.source_ip for event in events)
        add("loki_auth_logs", "pass" if events and not parsed["rejected"] else "pending",
            events=len(events), malformed=len(parsed["rejected"]), duplicates=parsed["duplicates"],
            source_ips=dict(counts.most_common(20)))
        if expected_ip:
            address = ip_address(expected_ip)
            expected_ip = str(getattr(address, "ipv4_mapped", None) or address)
            add("expected_attacker_ip_observed", "pass" if expected_ip in counts else "pending",
                expected_ip=expected_ip, events=counts.get(expected_ip, 0))
        else:
            add("attacker_ip_verification", "pending", reason="Compare logs with the known attacker PC IP")
        if export_dir is not None:
            target = Path(export_dir) / end.strftime("team-auth-%Y%m%dT%H%M%S%fZ")
            target.mkdir(parents=True, exist_ok=False)
            (target / "loki_snapshot.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
            metadata = {"window_start": start.isoformat(), "window_end": end.isoformat(),
                        "query": config["query"], "expected_attacker_ip": expected_ip,
                        "labels": "Not supplied: record normal/attack intervals separately"}
            (target / "capture.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            add("snapshot_export", "pass", directory=str(target))
    except Exception as error:
        add("loki_collection_or_export", "fail", error_type=type(error).__name__)

    failures = sum(item["status"] == "fail" for item in checks)
    report = {"checked_at": end.isoformat(), "checks": checks, "failures": failures,
              "pending": sum(item["status"] == "pending" for item in checks),
              "automatic_delivery_enabled": False,
              "note": "Connection checks do not validate ML accuracy, source-IP trust or WAF enforcement."}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-seconds", type=int, default=300)
    parser.add_argument("--expected-attacker-ip", type=ip_address)
    parser.add_argument("--question", help="Optional real RAG request; may take several minutes")
    parser.add_argument("--export-dir", type=Path)
    args = parser.parse_args()
    if not 1 <= args.lookback_seconds <= 3600:
        parser.error("Lookback must be between 1 and 3600 seconds")
    defaults = {"auth": "http://auth:3000", "detector": "http://detector:8000",
                "assistant": "http://assistant:8000", "remediation": "http://remediation:3000",
                "loki": "http://loki:3100"}
    config = {name: os.getenv("AI_CHECK_" + name.upper() + "_URL", value) for name, value in defaults.items()}
    config["query"] = os.getenv("AI_CHECK_LOKI_QUERY", '{container=~"auth(-2)?"}')
    config["secret"] = os.getenv("AI_CHECK_CLIENT_SECRET", "")
    report = run_checks(config, lookback=args.lookback_seconds,
                        expected_ip=args.expected_attacker_ip, question=args.question, export_dir=args.export_dir)
    print(json.dumps(report, indent=2))
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
