"""Detector API integration tests with local signed tokens."""

import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import joblib
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from resilience_alpha_ai.api.detector import create_app
from resilience_alpha_ai.anomaly_detection.observation_store import ObservationStore
from resilience_alpha_ai.anomaly_detection.predict import predict_windows
from resilience_alpha_ai.anomaly_detection.synthetic_data import generate_baseline
from resilience_alpha_ai.anomaly_detection.train import train_model


class DetectorApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name)
        cls.model_path = root / "model.joblib"
        cls.state_path = root / "observations.sqlite"

        baseline = generate_baseline(count=100)
        artifact = train_model(baseline, "synthetic")
        joblib.dump(artifact, cls.model_path)

        rows = [
            {**baseline[0], "source_ip": "192.0.2.10"},
            {**baseline[0], "source_ip": "192.0.2.20"},
        ]
        ObservationStore(cls.state_path).save({
            "window_end": baseline[0]["window_end"],
            "predictions": predict_windows(artifact, rows),
        })

        cls.private_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )

    def setUp(self):
        environment = patch.dict(os.environ, {
            "DETECTOR_MODEL_PATH": str(self.model_path),
            "DETECTOR_STATE_DB": str(self.state_path),
            "AUTH_JWKS_URL": "http://auth.test/.well-known/jwks.json",
            "JWT_ISSUER": "resilience-auth",
            "JWT_AUDIENCE": "resilience-platform",
        })
        environment.start()
        self.addCleanup(environment.stop)

        keys = patch(
            "resilience_alpha_ai.api.security.jwt.PyJWKClient"
            ".get_signing_key_from_jwt",
            return_value=SimpleNamespace(key=self.private_key.public_key()),
        )
        keys.start()
        self.addCleanup(keys.stop)

        self.client = TestClient(create_app())
        self.addCleanup(self.client.close)

        now = int(time.time())
        token = jwt.encode({
            "sub": "test-dashboard",
            "iss": "resilience-auth",
            "aud": "resilience-platform",
            "iat": now,
            "exp": now + 300,
            "roles": ["svc:dashboard"],
        }, self.private_key, algorithm="RS256", headers={"kid": "test-key"})
        self.headers = {"Authorization": f"Bearer {token}"}

    def test_authorized_model_and_predictions(self):
        response = self.client.get(
            "/detector/v1/model", headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "isolation-forest")
        self.assertEqual(response.json()["training_data_origin"], "synthetic")

        response = self.client.get(
            "/detector/v1/anomalies", headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        results = response.json()
        self.assertEqual(len(results), 2)
        self.assertEqual(
            {item["source_ip"] for item in results},
            {"192.0.2.10", "192.0.2.20"},
        )
        self.assertTrue(all(0 <= item["score"] <= 1 for item in results))

    def test_missing_token(self):
        for endpoint in ("model", "anomalies"):
            with self.subTest(endpoint=endpoint):
                response = self.client.get(f"/detector/v1/{endpoint}")
                self.assertEqual(response.status_code, 401)

    def test_invalid_filters(self):
        for params in (
            {"limit": 0},
            {"since": "2026-10-20T08:00:00"},
        ):
            with self.subTest(params=params):
                response = self.client.get(
                    "/detector/v1/anomalies",
                    headers=self.headers,
                    params=params,
                )
                self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
