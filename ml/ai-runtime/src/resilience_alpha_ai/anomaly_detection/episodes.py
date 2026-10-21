"""Persist anomaly episode identities for a single detector worker."""

import sqlite3
from ipaddress import ip_address
from pathlib import Path
from uuid import uuid4


class EpisodeTracker:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=10)
        with self.db:
            self.db.execute("""
                CREATE TABLE IF NOT EXISTS active_episodes (
                    source_ip TEXT NOT NULL,
                    incident_type TEXT NOT NULL,
                    episode_id TEXT NOT NULL,
                    PRIMARY KEY (source_ip, incident_type)
                )
            """)

    def close(self):
        self.db.close()

    @staticmethod
    def validate_key(source_ip: str, incident_type: str) -> tuple[str, str]:
        source_ip = str(ip_address(source_ip))
        if incident_type not in {"UNKNOWN_ANOMALY", "BRUTE_FORCE"}:
            raise ValueError("Unsupported incident type")
        return source_ip, incident_type

    def get_or_create(
        self,
        source_ip: str,
        incident_type: str = "UNKNOWN_ANOMALY",
    ) -> str:
        source_ip, incident_type = self.validate_key(source_ip, incident_type)

        with self.db:
            self.db.execute("""
                INSERT OR IGNORE INTO active_episodes
                    (source_ip, incident_type, episode_id)
                VALUES (?, ?, ?)
            """, (source_ip, incident_type, str(uuid4())))

            row = self.db.execute("""
                SELECT episode_id FROM active_episodes
                WHERE source_ip = ? AND incident_type = ?
            """, (source_ip, incident_type)).fetchone()

        return row[0]

    def close_episode(
        self,
        source_ip: str,
        expected_episode_id: str,
        incident_type: str = "UNKNOWN_ANOMALY",
    ) -> bool:
        """Call only after the controller confirms the episode has ended."""
        source_ip, incident_type = self.validate_key(source_ip, incident_type)

        with self.db:
            cursor = self.db.execute("""
                DELETE FROM active_episodes
                WHERE source_ip = ? AND incident_type = ? AND episode_id = ?
            """, (source_ip, incident_type, expected_episode_id))

        return cursor.rowcount == 1
