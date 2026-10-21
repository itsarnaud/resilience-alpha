"""Delivery integration tests: local mocks and temporary databases only."""

import json
import tempfile
import unittest
from pathlib import Path

import httpx

from resilience_alpha_ai.anomaly_detection.delivery import deliver_pending
from resilience_alpha_ai.anomaly_detection.outbox import IncidentOutbox
from resilience_alpha_ai.anomaly_detection.remediation_client import RemediationClient


class DeliveryTests(unittest.TestCase):
    def test_outage_restart_and_delivery(self):
        delivered = []

        def offline(request):
            raise httpx.ConnectError("Simulated outage", request=request)

        def online(request):
            if request.url.path == "/v1/token":
                return httpx.Response(200, json={
                    "access_token": "mock-token",
                    "token_type": "Bearer",
                    "expires_in": 900,
                })
            self.assertEqual(request.url.path, "/v1/incidents")
            self.assertEqual(
                request.headers["Authorization"], "Bearer mock-token"
            )
            delivered.append(json.loads(request.content))
            return httpx.Response(202, json={"id": "mock-incident"})

        payload = {"dedup_key": "test-episode", "score": 0.8}

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.sqlite"
            queue = IncidentOutbox(path)
            try:
                self.assertTrue(queue.enqueue(payload))
                self.assertFalse(queue.enqueue(payload))

                with httpx.Client(transport=httpx.MockTransport(offline)) as http:
                    client = RemediationClient(
                        http, "http://auth.test", "http://remediation.test",
                        "svc-detector", "mock-secret",
                    )
                    self.assertEqual(
                        deliver_pending(queue, client, now=100),
                        {"accepted": 0, "deferred": 1},
                    )
            finally:
                queue.close()

            queue = IncidentOutbox(path)
            try:
                with httpx.Client(transport=httpx.MockTransport(online)) as http:
                    client = RemediationClient(
                        http, "http://auth.test", "http://remediation.test",
                        "svc-detector", "mock-secret",
                    )
                    self.assertEqual(
                        deliver_pending(queue, client, now=104),
                        {"accepted": 0, "deferred": 0},
                    )
                    self.assertEqual(
                        deliver_pending(queue, client, now=105),
                        {"accepted": 1, "deferred": 0},
                    )
                self.assertEqual(delivered, [payload])
            finally:
                queue.close()

            queue = IncidentOutbox(path)
            try:
                self.assertEqual(queue.ready(now=1000), [])
                self.assertFalse(queue.enqueue(payload))
            finally:
                queue.close()

    def test_forbidden_keeps_incident_pending(self):
        def forbidden(request):
            if request.url.path == "/v1/token":
                return httpx.Response(200, json={
                    "access_token": "mock-token",
                    "token_type": "Bearer",
                    "expires_in": 900,
                })
            return httpx.Response(403)

        with tempfile.TemporaryDirectory() as directory:
            queue = IncidentOutbox(Path(directory) / "outbox.sqlite")
            try:
                queue.enqueue({"dedup_key": "forbidden-episode"})
                with httpx.Client(
                    transport=httpx.MockTransport(forbidden)
                ) as http:
                    client = RemediationClient(
                        http, "http://auth.test", "http://remediation.test",
                        "svc-detector", "mock-secret",
                    )
                    with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                        deliver_pending(queue, client, now=100)

                pending = queue.ready(now=100)
                self.assertEqual(len(pending), 1)
                self.assertEqual(pending[0]["attempts"], 0)
            finally:
                queue.close()


if __name__ == "__main__":
    unittest.main()
