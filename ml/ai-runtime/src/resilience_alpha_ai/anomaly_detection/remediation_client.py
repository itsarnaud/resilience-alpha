"""Authenticated client for the team's remediation API."""

import math
import time

import httpx


class RemediationClient:
    def __init__(
        self,
        http: httpx.Client,
        auth_url: str,
        remediation_url: str,
        client_id: str,
        client_secret: str,
    ):
        self.http = http
        self.auth_url = auth_url.rstrip("/")
        self.remediation_url = remediation_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self._access_token = None
        self._expires_at = 0.0

    def get_token(self, force_refresh: bool = False) -> str:
        if (
            not force_refresh
            and self._access_token
            and time.monotonic() < self._expires_at
        ):
            return self._access_token

        response = self.http.post(
            self.auth_url + "/v1/token",
            json={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()

        token = data.get("access_token")
        ttl = data.get("expires_in")
        if (
            not isinstance(token, str)
            or not token.strip()
            or data.get("token_type") != "Bearer"
            or isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            raise ValueError("Invalid service-token response")

        self._access_token = token
        self._expires_at = time.monotonic() + ttl - min(30, ttl / 10)
        return token

    def submit_incident(self, payload: dict) -> dict:
        """Submit an incident; refresh once if the token is rejected."""
        if not isinstance(payload.get("dedup_key"), str):
            raise ValueError("Incident requires a stable dedup_key")
        if not payload["dedup_key"].strip():
            raise ValueError("dedup_key must not be empty")

        for attempt in range(2):
            token = self.get_token(force_refresh=attempt == 1)
            response = self.http.post(
                self.remediation_url + "/v1/incidents",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
                timeout=10,
            )
            if response.status_code == 401 and attempt == 0:
                continue

            response.raise_for_status()
            if response.status_code not in {200, 202}:
                raise ValueError("Unexpected incident response status")

            incident = response.json()
            if not isinstance(incident, dict) or not incident.get("id"):
                raise ValueError("Incident response missing its identifier")

            return incident

        raise RuntimeError("Incident submission did not complete")
