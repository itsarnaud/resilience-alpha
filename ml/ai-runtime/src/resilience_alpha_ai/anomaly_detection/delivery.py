"""Deliver queued incidents using one worker."""

import httpx

from resilience_alpha_ai.anomaly_detection.outbox import IncidentOutbox
from resilience_alpha_ai.anomaly_detection.remediation_client import RemediationClient


def deliver_pending(
    outbox: IncidentOutbox,
    client: RemediationClient,
    now: float | None = None,
) -> dict:
    counts = {"accepted": 0, "deferred": 0}

    for item in outbox.ready(now=now):
        key = item["dedup_key"]

        try:
            client.submit_incident(item["payload"])
        except httpx.TransportError:
            outbox.schedule_retry(key, now=now)
            counts["deferred"] += 1
            continue
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            if status == 429 or 500 <= status <= 599:
                outbox.schedule_retry(key, now=now)
                counts["deferred"] += 1
                continue
            raise RuntimeError(
                f"Delivery stopped: HTTP {status}. "
                "Incident remains pending; check credentials or contract."
            ) from None

        # A malformed success response raises before reaching this point.
        outbox.mark_delivered(key)
        counts["accepted"] += 1

    return counts
