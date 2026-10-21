"""Persistent incident outbox for a single delivery worker."""

import json
import sqlite3
import time
from pathlib import Path


class IncidentOutbox:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=10)
        with self.db:
            self.db.execute("""
                CREATE TABLE IF NOT EXISTS incidents (
                    dedup_key TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt REAL NOT NULL DEFAULT 0,
                    delivered INTEGER NOT NULL DEFAULT 0
                )
            """)

    def close(self):
        self.db.close()

    def enqueue(self, payload: dict) -> bool:
        key = payload.get("dedup_key")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("A non-empty dedup_key is required")

        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), allow_nan=False
        )

        with self.db:
            existing = self.db.execute(
                "SELECT payload FROM incidents WHERE dedup_key = ?", (key,)
            ).fetchone()

            if existing:
                if existing[0] != encoded:
                    raise ValueError("Same incident key has a different payload")
                return False

            self.db.execute(
                "INSERT INTO incidents (dedup_key, payload) VALUES (?, ?)",
                (key, encoded),
            )
        return True

    def get_payload(self, key: str) -> dict | None:
        record = self.db.execute(
            "SELECT payload FROM incidents WHERE dedup_key = ?", (key,)
        ).fetchone()
        return json.loads(record[0]) if record else None

    def ready(self, now: float | None = None, limit: int = 20) -> list[dict]:
        if not 1 <= limit <= 1000:
            raise ValueError("limit must be between 1 and 1000")

        now = time.time() if now is None else now
        records = self.db.execute("""
            SELECT dedup_key, payload, attempts
            FROM incidents
            WHERE delivered = 0 AND next_attempt <= ?
            ORDER BY next_attempt, rowid
            LIMIT ?
        """, (now, limit)).fetchall()

        return [
            {"dedup_key": key, "payload": json.loads(payload), "attempts": attempts}
            for key, payload, attempts in records
        ]

    def mark_delivered(self, key: str):
        with self.db:
            cursor = self.db.execute(
                "UPDATE incidents SET delivered = 1 WHERE dedup_key = ?",
                (key,),
            )
            if cursor.rowcount != 1:
                raise KeyError("Unknown incident key")

    def schedule_retry(self, key: str, now: float | None = None) -> float:
        now = time.time() if now is None else now

        with self.db:
            record = self.db.execute("""
                SELECT attempts FROM incidents
                WHERE dedup_key = ? AND delivered = 0
            """, (key,)).fetchone()

            if record is None:
                raise KeyError("Unknown or already delivered incident")

            attempts = record[0] + 1
            delay = min(300, 5 * 2 ** min(attempts - 1, 6))
            next_attempt = now + delay

            self.db.execute("""
                UPDATE incidents
                SET attempts = ?, next_attempt = ?
                WHERE dedup_key = ?
            """, (attempts, next_attempt, key))

        return next_attempt
