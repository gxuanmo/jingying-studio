from __future__ import annotations

from pathlib import Path
from uuid import uuid4


class StorageService:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.uploads_dir = self.base_dir / "uploads"
        self.results_dir = self.base_dir / "results"
        self.previews_dir = self.base_dir / "previews"
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self.previews_dir.mkdir(parents=True, exist_ok=True)

    def make_upload_path(self, original_name: str) -> tuple[str, Path]:
        extension = Path(original_name).suffix.lower() or ".bin"
        stored_name = f"{uuid4().hex}{extension}"
        return stored_name, self.uploads_dir / stored_name

    def make_result_path(self, extension: str) -> tuple[str, Path]:
        normalized_extension = extension if extension.startswith(".") else f".{extension}"
        stored_name = f"{uuid4().hex}{normalized_extension.lower()}"
        return stored_name, self.results_dir / stored_name

    def make_preview_path(self, extension: str) -> tuple[str, Path]:
        normalized_extension = extension if extension.startswith(".") else f".{extension}"
        stored_name = f"{uuid4().hex}{normalized_extension.lower()}"
        return stored_name, self.previews_dir / stored_name

    @staticmethod
    def upload_url(stored_name: str) -> str:
        return f"/uploads/{stored_name}"

    @staticmethod
    def result_url(stored_name: str) -> str:
        return f"/results/{stored_name}"

    @staticmethod
    def preview_url(stored_name: str) -> str:
        return f"/previews/{stored_name}"

