from __future__ import annotations

import sqlite3
from pathlib import Path

from app.schemas.models import AssetRecord, JobRecord


class MetadataStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                )
                """
            )
            connection.commit()

    def load_assets(self) -> dict[str, AssetRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload_json FROM assets").fetchall()
        assets: dict[str, AssetRecord] = {}
        for row in rows:
            asset = AssetRecord.model_validate_json(row["payload_json"])
            assets[asset.id] = asset
        return assets

    def load_jobs(self) -> dict[str, JobRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload_json FROM jobs").fetchall()
        jobs: dict[str, JobRecord] = {}
        for row in rows:
            job = JobRecord.model_validate_json(row["payload_json"])
            jobs[job.id] = job
        return jobs

    def upsert_asset(self, asset: AssetRecord) -> None:
        payload = asset.model_dump_json()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO assets (id, created_at, payload_json)
                VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    created_at = excluded.created_at,
                    payload_json = excluded.payload_json
                """,
                (asset.id, asset.created_at, payload),
            )
            connection.commit()

    def upsert_job(self, job: JobRecord) -> None:
        payload = job.model_dump_json()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs (id, created_at, updated_at, status, payload_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    status = excluded.status,
                    payload_json = excluded.payload_json
                """,
                (job.id, job.created_at, job.updated_at, job.status.value, payload),
            )
            connection.commit()

