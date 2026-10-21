"""Queue one immutable incident per active anomaly episode."""

from datetime import datetime

from resilience_alpha_ai.anomaly_detection.episodes import EpisodeTracker
from resilience_alpha_ai.anomaly_detection.incidents import build_incident
from resilience_alpha_ai.anomaly_detection.outbox import IncidentOutbox


def queue_prediction(
    prediction: dict,
    tracker: EpisodeTracker,
    outbox: IncidentOutbox,
    evidence: list[dict],
    *,
    allow_prototype: bool = False,
) -> dict | None:
    if type(prediction.get("is_anomaly")) is not bool:
        raise ValueError("Prediction must include a boolean is_anomaly")

    if not prediction["is_anomaly"]:
        return None

    if (
        prediction.get("model_status") != "validated"
        and not allow_prototype
    ):
        raise ValueError("Prototype model: incident queueing disabled")

    incident_type = "UNKNOWN_ANOMALY"
    source_ip = prediction["source_ip"]
    episode_id = tracker.get_or_create(source_ip, incident_type)
    key = f"{incident_type}:auth:{episode_id}"

    existing = outbox.get_payload(key)
    if existing is not None:
        return {"dedup_key": key, "queued": False}

    payload = build_incident(
        episode_id=episode_id,
        source_ip=source_ip,
        normalized_score=prediction["score"],
        detected_at=datetime.fromisoformat(
            prediction["window_end"].replace("Z", "+00:00")
        ),
        evidence=evidence,
        incident_type=incident_type,
    )
    inserted = outbox.enqueue(payload)
    return {"dedup_key": key, "queued": inserted}
