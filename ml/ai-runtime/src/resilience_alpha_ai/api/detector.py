"""Authenticated, read-only detector API."""

import hashlib
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import joblib
import sklearn
from fastapi import Depends, FastAPI, HTTPException, Query

from resilience_alpha_ai.api.security import operator_dependency
from resilience_alpha_ai.anomaly_detection.model_loader import load_model
from resilience_alpha_ai.anomaly_detection.features import FEATURE_NAMES
from resilience_alpha_ai.anomaly_detection.observation_store import ObservationStore


def create_app() -> FastAPI:
    model_path = Path(os.environ["DETECTOR_MODEL_PATH"])
    state_path = Path(os.environ["DETECTOR_STATE_DB"])

    require_operator = operator_dependency(
        os.environ["AUTH_JWKS_URL"],
        os.getenv("JWT_ISSUER", "resilience-auth"),
        os.getenv("JWT_AUDIENCE", "resilience-platform"),
    )

    # Load only trusted model artifacts.
    threshold_path = os.getenv("DETECTOR_THRESHOLD_CONFIG")
    artifact = (load_model(model_path, threshold_path) if threshold_path else joblib.load(model_path))
    if artifact["sklearn_version"] != sklearn.__version__:
        raise ValueError("Model and runtime scikit-learn versions differ")
    if artifact["feature_names"] != list(FEATURE_NAMES):
        raise ValueError("Model feature order differs from runtime")

    model_version = hashlib.sha256(model_path.read_bytes()).hexdigest()[:12]
    store = ObservationStore(state_path)
    app = FastAPI(title="RESILIENCE-ALPHA Detector", version="0.1.0")

    @app.get("/detector/healthz")
    def health():
        # Liveness of this API, not proof that collection is current.
        return {"status": "alive", "service": "ml-detector-api"}

    @app.get(
        "/detector/v1/model",
        dependencies=[Depends(require_operator)],
    )
    def model_info():
        return {
            "name": "isolation-forest",
            "version": model_version,
            "trained_at": artifact["trained_at"],
            "threshold": artifact.get("decision_threshold", float(-artifact["model"].offset_)),
            "threshold_status": artifact.get("threshold_status", "model_default"),
            "features": artifact["feature_names"],
            "score_method": "negative_score_samples",
            "training_data_origin": artifact["data_origin"],
            "model_status": artifact["status"],
            "window_seconds": artifact["window_seconds"],
        }

    @app.get(
        "/detector/v1/anomalies",
        dependencies=[Depends(require_operator)],
    )
    def anomalies(
        since: datetime | None = None,
        limit: int = Query(default=200, ge=1, le=1000),
    ):
        if since is not None and since.utcoffset() is None:
            raise HTTPException(
                status_code=422,
                detail="since must include a timezone",
            )
        try:
            return store.list_predictions(
                since=since.isoformat() if since else None,
                limit=limit,
            )
        except sqlite3.Error:
            raise HTTPException(
                status_code=503,
                detail="Observation storage unavailable",
            ) from None

    return app
