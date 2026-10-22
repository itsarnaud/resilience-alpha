"""Load trusted local models with an optional model-bound decision threshold."""
import hashlib
import json
import math
from pathlib import Path

import joblib


def apply_threshold_config(artifact, config, model_sha256):
    if config.get('model_sha256') != model_sha256:
        raise ValueError('Threshold configuration belongs to a different model')
    if config.get('score_method') != 'negative_score_samples':
        raise ValueError('Unsupported threshold score method')
    if config.get('comparison') != 'score > threshold':
        raise ValueError('Unsupported threshold comparison')
    value = config.get('threshold')
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError('Threshold must be a finite number between zero and one')
    status = config.get('status', 'provisional_not_validated')
    if status not in {'provisional_not_validated', 'validated'}:
        raise ValueError('Unsupported threshold validation status')
    result = dict(artifact)
    result['decision_threshold'] = float(value)
    # Preserve an explicitly reviewed threshold status; never promote the model.
    result['threshold_status'] = status
    return result


def require_validated_delivery(artifact):
    """Reject prototypes and unknown threshold states before opening a live queue."""
    if artifact.get('status') != 'validated':
        raise ValueError('Live delivery requires a validated model')
    if artifact.get('threshold_status', 'model_default') not in {'validated', 'model_default'}:
        raise ValueError('Live delivery requires a validated threshold')


def load_model(model_path, threshold_path=None):
    model_path = Path(model_path)
    # joblib deserializes executable Python; use only trusted local artifacts.
    artifact = joblib.load(model_path)
    if threshold_path is not None:
        config = json.loads(Path(threshold_path).read_text(encoding='utf-8-sig'))
        artifact = apply_threshold_config(artifact, config, hashlib.sha256(model_path.read_bytes()).hexdigest())
    return artifact
