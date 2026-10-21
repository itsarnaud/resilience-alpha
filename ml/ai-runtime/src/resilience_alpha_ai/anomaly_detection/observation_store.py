"""Store bounded observation history for the dashboard API."""

from contextlib import closing

import json
import sqlite3
from datetime import datetime
from pathlib import Path


class ObservationStore:
    def __init__(self, path: Path, retention: int = 500):
        if retention < 1:
            raise ValueError("Retention must be positive")
        self.path = path
        self.retention = retention
        path.parent.mkdir(parents=True, exist_ok=True)

        with closing(sqlite3.connect(path, timeout=10)) as db, db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS observations (
                    at REAL PRIMARY KEY,
                    report TEXT NOT NULL
                )
            """)

    @staticmethod
    def timestamp(value: str) -> float:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if at.utcoffset() is None:
            raise ValueError("Timestamp must include a timezone")
        return at.timestamp()

    def save(self, report: dict):
        at = self.timestamp(report["window_end"])
        encoded = json.dumps(report, allow_nan=False)

        with closing(sqlite3.connect(self.path, timeout=10)) as db, db:
            db.execute("""
                INSERT INTO observations (at, report) VALUES (?, ?)
                ON CONFLICT(at) DO UPDATE SET report = excluded.report
            """, (at, encoded))

            db.execute("""
                DELETE FROM observations
                WHERE at NOT IN (
                    SELECT at FROM observations
                    ORDER BY at DESC LIMIT ?
                )
            """, (self.retention,))

    def list_predictions(
        self, since: str | None = None, limit: int = 200
    ) -> list[dict]:
        if not 1 <= limit <= 1000:
            raise ValueError("Limit must be between 1 and 1000")

        cutoff = self.timestamp(since) if since else float("-inf")
        with closing(sqlite3.connect(self.path, timeout=10)) as db, db:
            records = db.execute("""
                SELECT report FROM observations
                WHERE at > ? ORDER BY at DESC
            """, (cutoff,)).fetchall()

        results = []
        for (encoded,) in records:
            report = json.loads(encoded)
            for prediction in report["predictions"]:
                results.append({
                    "at": prediction["window_end"],
                    "source_ip": prediction["source_ip"],
                    "score": prediction["score"],
                    "is_anomaly": prediction["is_anomaly"],
                    "features": prediction["features"],
                    "model_status": prediction["model_status"],
                    "training_data_origin": prediction["training_data_origin"],
                })
                if len(results) >= limit:
                    return results

        return results
