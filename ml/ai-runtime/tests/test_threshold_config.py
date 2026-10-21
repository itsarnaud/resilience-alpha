import unittest
from unittest.mock import patch
import numpy as np
import sklearn
from resilience_alpha_ai.anomaly_detection.model_loader import apply_threshold_config
from resilience_alpha_ai.anomaly_detection.predict import predict_windows
from resilience_alpha_ai.anomaly_detection.features import FEATURE_NAMES

class FakeModel:
    offset_ = -.5
    def decision_function(self, matrix): return np.array([-.1, -.3])
    def predict(self, matrix): return np.array([-1, -1])

class ThresholdTests(unittest.TestCase):
    def config(self, value=.6):
        return dict(model_sha256='abc', score_method='negative_score_samples', comparison='score > threshold', threshold=value)
    def test_model_binding_and_invalid_thresholds(self):
        with self.assertRaises(ValueError):apply_threshold_config({},self.config(),'other')
        for value in (True, None, float('nan'), float('inf'), -.1, 1.1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                apply_threshold_config({},self.config(value),'abc')
    def test_no_promotion_or_mutation(self):
        original={'status':'prototype_not_validated'}
        adjusted=apply_threshold_config(original,self.config(),'abc')
        self.assertNotIn('decision_threshold',original)
        self.assertEqual(adjusted['status'],original['status'])
        self.assertEqual(adjusted['threshold_status'],'provisional_not_validated')
    def test_threshold_controls_predictions_at_strict_boundary(self):
        artifact=dict(model=FakeModel(),feature_names=list(FEATURE_NAMES),sklearn_version=sklearn.__version__,window_seconds=60,data_origin='synthetic',status='prototype_not_validated')
        rows=[dict(source_ip='192.0.2.1',window_start='2026-10-20T08:00:00+00:00',window_end='2026-10-20T08:01:00+00:00',**{k:0 for k in FEATURE_NAMES}) for _ in range(2)]
        adjusted=apply_threshold_config(artifact,self.config(),'abc')
        with patch('resilience_alpha_ai.anomaly_detection.predict.feature_matrix',return_value=np.zeros((2,5))):
            before=predict_windows(artifact,rows)
            after=predict_windows(adjusted,rows)
        self.assertEqual([r['is_anomaly'] for r in before],[True,True])
        self.assertEqual([r['is_anomaly'] for r in after],[False,True])
        self.assertEqual([r['score'] for r in before],[r['score'] for r in after])

if __name__=='__main__':unittest.main()
