from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _split_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    app_title: str
    app_version: str
    data_dir: Path
    metadata_db_path: Path
    cors_origins: list[str]


def load_settings(base_dir: Path) -> Settings:
    data_dir = Path(os.getenv("MEDIA_CLEANER_DATA_DIR", str(base_dir.parent / "data"))).resolve()
    metadata_db_path = Path(
        os.getenv("MEDIA_CLEANER_METADATA_DB", str(data_dir / "metadata.sqlite3"))
    ).resolve()
    cors_origins = _split_csv(
        os.getenv("MEDIA_CLEANER_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    )
    return Settings(
        app_title=os.getenv("MEDIA_CLEANER_APP_TITLE", "Jingying Studio Engine"),
        app_version=os.getenv("MEDIA_CLEANER_APP_VERSION", "0.2.0"),
        data_dir=data_dir,
        metadata_db_path=metadata_db_path,
        cors_origins=cors_origins,
    )
