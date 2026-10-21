"""API authentication tests using temporary RSA keys and mocked JWKS."""

import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jwt.exceptions import PyJWKClientConnectionError

from resilience_alpha_ai.api.security import operator_dependency


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )
        cls.public_key = cls.private_key.public_key()

        app = FastAPI()
        require_operator = operator_dependency(
            "http://auth.test/.well-known/jwks.json",
            "resilience-auth",
            "resilience-platform",
        )

        @app.get("/protected")
        def protected(identity=Depends(require_operator)):
            return {"sub": identity["sub"]}

        cls.app = app

    def setUp(self):
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

        patcher = patch(
            "resilience_alpha_ai.api.security.jwt.PyJWKClient"
            ".get_signing_key_from_jwt",
            return_value=SimpleNamespace(key=self.public_key),
        )
        self.mock_keys = patcher.start()
        self.addCleanup(patcher.stop)

    def token(self, **changes):
        now = int(time.time())
        claims = {
            "sub": "test-operator",
            "iss": "resilience-auth",
            "aud": "resilience-platform",
            "iat": now,
            "exp": now + 300,
            "roles": ["operator"],
        }
        claims.update(changes)
        return jwt.encode(
            claims, self.private_key,
            algorithm="RS256", headers={"kid": "temporary-test-key"},
        )

    def request(self, token):
        return self.client.get(
            "/protected",
            headers={"Authorization": f"Bearer {token}"},
        )

    def test_allowed_roles(self):
        for role in ("operator", "svc:dashboard"):
            with self.subTest(role=role):
                response = self.request(self.token(roles=[role]))
                self.assertEqual(response.status_code, 200)

    def test_missing_token(self):
        response = self.client.get("/protected")
        self.assertEqual(response.status_code, 401)
        self.mock_keys.assert_not_called()

    def test_expired_token(self):
        self.assertEqual(
            self.request(self.token(exp=int(time.time()) - 60)).status_code,
            401,
        )

    def test_wrong_audience(self):
        self.assertEqual(
            self.request(self.token(aud="another-platform")).status_code, 401
        )

    def test_wrong_issuer(self):
        self.assertEqual(
            self.request(self.token(iss="another-issuer")).status_code, 401
        )

    def test_customer_forbidden(self):
        self.assertEqual(
            self.request(self.token(roles=["customer"])).status_code, 403
        )

    def test_invalid_signature(self):
        header, payload, signature = self.token().split(".")
        first = "A" if signature[0] != "A" else "B"
        altered = f"{header}.{payload}.{first}{signature[1:]}"
        self.assertEqual(self.request(altered).status_code, 401)

    def test_key_service_unavailable(self):
        self.mock_keys.side_effect = PyJWKClientConnectionError(
            "Simulated unavailable auth"
        )
        self.assertEqual(self.request(self.token()).status_code, 503)


if __name__ == "__main__":
    unittest.main()
