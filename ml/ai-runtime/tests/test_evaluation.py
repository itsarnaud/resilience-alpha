import unittest
from unittest.mock import patch

from resilience_alpha_ai.anomaly_detection.evaluate import evaluate


class EvaluationTests(unittest.TestCase):
    def test_confusion_matrix(self):
        rows = [
            {"label": True},
            {"label": False},
            {"label": False},
            {"label": True},
        ]
        predictions = [
            {"is_anomaly": True},
            {"is_anomaly": True},
            {"is_anomaly": False},
            {"is_anomaly": False},
        ]
        artifact = {
            "data_origin": "synthetic",
            "status": "prototype_not_validated",
        }
        with patch(
            "resilience_alpha_ai.anomaly_detection.evaluate.predict_windows",
            return_value=predictions,
        ):
            result = evaluate(artifact, rows)

        for key in (
            "true_positives", "false_positives",
            "true_negatives", "false_negatives",
        ):
            self.assertEqual(result[key], 1)
        self.assertEqual(result["precision"], 0.5)
        self.assertEqual(result["recall"], 0.5)
        self.assertEqual(result["false_positive_rate"], 0.5)

    def test_no_detections(self):
        artifact = {
            "data_origin": "synthetic",
            "status": "prototype_not_validated",
        }
        with patch(
            "resilience_alpha_ai.anomaly_detection.evaluate.predict_windows",
            return_value=[{"is_anomaly": False}, {"is_anomaly": False}],
        ):
            result = evaluate(
                artifact, [{"label": True}, {"label": False}]
            )
        self.assertIsNone(result["precision"])
        self.assertEqual(result["recall"], 0.0)
        self.assertEqual(result["false_positive_rate"], 0.0)

    def test_invalid_labels_rejected(self):
        for rows in (
            [], [{"label": 1}], [{"label": "false"}],
            [{"label": False}], [{"label": True}],
        ):
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    evaluate({}, rows)


if __name__ == "__main__":
    unittest.main()
