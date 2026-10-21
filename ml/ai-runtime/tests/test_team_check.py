import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import Mock

from resilience_alpha_ai.anomaly_detection.team_check import request_json, run_checks


NOW = datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc)
CONFIG = dict(auth="http://auth:3000", detector="http://detector:8000",
              assistant="http://assistant:8000", remediation="http://remediation:3000",
              loki="http://loki:3100", query='{container="auth"}', secret="fake")


def snapshot(ip="::ffff:192.0.2.30"):
    record = dict(service="auth", event="login_failed", time="2026-10-21T13:59:50Z",
                  ip=ip, email="demo@example.test", request_id="test-request")
    return {"status": "success", "data": {"resultType": "streams", "result": [
        {"stream": {"container": "auth"}, "values": [["1792591190000000000", json.dumps(record)]]}
    ]}}


def service_response(base, path, **kwargs):
    if path == "/v1/token":
        return 200, {"access_token": "private-test-bearer"}
    if path.endswith("jwks.json"):
        return 200, {"keys": [{"kid": "test"}]}
    if path in {"/detector/v1/model", "/assistant/v1/chat"} and not kwargs.get("token"):
        return 401, None
    if path == "/detector/v1/model":
        return 200, {"model_status": "prototype_not_validated", "threshold_status": "provisional_not_validated"}
    if path.startswith("/detector/v1/anomalies"):
        return 200, []
    if path == "/assistant/v1/chat":
        return 200, {"answer": "Je ne trouve pas cette information dans les extraits disponibles.", "sources": []}
    return 200, {"status": "ok"}


class TeamCheckTests(unittest.TestCase):
    def run_check(self, **kwargs):
        return run_checks(CONFIG, request=service_response, collect=lambda *a: snapshot(), now=NOW, **kwargs)

    def test_checks_use_real_roles_without_sending_incidents_or_exposing_tokens(self):
        request = Mock(side_effect=service_response)
        report = run_checks(CONFIG, request=request, collect=lambda *a: snapshot(), now=NOW)
        self.assertEqual(report["failures"], 0)
        self.assertFalse(report["automatic_delivery_enabled"])
        encoded = json.dumps(report)
        self.assertNotIn("private-test-bearer", encoded)
        self.assertNotIn(CONFIG["secret"], encoded)
        self.assertTrue(any(c.args[1] == "/v1/token" for c in request.call_args_list))
        self.assertTrue(all(c.args[1] in {"/v1/token", "/assistant/v1/chat"}
                            for c in request.call_args_list if c.kwargs.get("body") is not None))

    def test_missing_secret_is_reported_pending_and_no_token_requested(self):
        request = Mock(side_effect=service_response)
        report = run_checks({**CONFIG, "secret": ""}, request=request, collect=lambda *a: snapshot(), now=NOW)
        self.assertTrue(any(c["check"] == "dashboard_token" and c["status"] == "pending" for c in report["checks"]))
        self.assertFalse(any(c.args[1] == "/v1/token" for c in request.call_args_list))

    def test_failed_token_does_not_attempt_authorized_requests(self):
        def denied(base, path, **kwargs):
            return (403, None) if path == "/v1/token" else service_response(base, path, **kwargs)
        request = Mock(side_effect=denied)
        report = run_checks(CONFIG, request=request, collect=lambda *a: snapshot(), now=NOW)
        self.assertEqual(report["failures"], 1)
        self.assertFalse(any(c.kwargs.get("token") for c in request.call_args_list))

    def test_empty_logs_do_not_claim_source_ip_verified(self):
        report = run_checks(CONFIG, request=service_response, now=NOW, expected_ip="192.0.2.30",
                            collect=lambda *a: {"status": "success", "data": {"resultType": "streams", "result": []}})
        by_name = {c["check"]: c for c in report["checks"]}
        self.assertEqual(by_name["loki_auth_logs"]["status"], "pending")
        self.assertEqual(by_name["expected_attacker_ip_observed"]["status"], "pending")

    def test_mapped_ip_matches_expected_address_and_export_preserves_payload(self):
        with TemporaryDirectory() as folder:
            report = self.run_check(expected_ip="192.0.2.30", export_dir=Path(folder))
            by_name = {c["check"]: c for c in report["checks"]}
            self.assertEqual(by_name["expected_attacker_ip_observed"]["status"], "pass")
            directory = Path(by_name["snapshot_export"]["directory"])
            self.assertEqual(json.loads((directory / "loki_snapshot.json").read_text()), snapshot())
            metadata = json.loads((directory / "capture.json").read_text())
            self.assertEqual(metadata["window_end"], NOW.isoformat())
            # A second run cannot overwrite evidence from the same timestamp.
            repeated = self.run_check(export_dir=Path(folder))
            self.assertEqual(repeated["failures"], 1)

    def test_collection_failure_is_visible_without_exception_message_leak(self):
        collect = Mock(side_effect=ValueError("sensitive-content"))
        report = run_checks(CONFIG, request=service_response, collect=collect, now=NOW)
        self.assertEqual(report["failures"], 1)
        self.assertNotIn("sensitive-content", json.dumps(report))

    def test_rag_refusal_is_available_for_manual_review_not_accuracy_claim(self):
        report = self.run_check(question="Question de test")
        review = next(c for c in report["checks"] if c["check"] == "rag_manual_review")
        self.assertEqual(review["status"], "info")
        self.assertEqual(review["sources"], [])

    def test_wrong_unauthenticated_status_is_a_failure(self):
        def broken_auth(base, path, **kwargs):
            if path == "/detector/v1/model" and not kwargs.get("token"):
                return 200, {"model_status": "prototype_not_validated"}
            return service_response(base, path, **kwargs)
        report = run_checks(CONFIG, request=broken_auth, collect=lambda *a: snapshot(), now=NOW)
        self.assertEqual(report["failures"], 1)

    def test_http_transport_uses_json_and_does_not_follow_token_redirect(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append((self.path, body, self.headers.get("Content-Type")))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"access_token":"local-only"}')

            def do_GET(self):
                received.append((self.path, self.headers.get("Authorization")))
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/must-not-receive-token")
                else:
                    self.send_response(401)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            self.assertEqual(request_json(base, "/v1/token", body={"client_id": "svc-dashboard"}),
                             (200, {"access_token": "local-only"}))
            self.assertEqual(request_json(base, "/private"), (401, None))
            self.assertEqual(request_json(base, "/redirect", token="local-only"), (302, None))
            self.assertEqual(len(received), 3)
            self.assertEqual(received[0][2], "application/json")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
