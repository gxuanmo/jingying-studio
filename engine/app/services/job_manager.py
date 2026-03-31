from __future__ import annotations

from datetime import UTC, datetime
from threading import Lock, Thread
from typing import Dict
from uuid import uuid4

from fastapi import UploadFile

from app.schemas.models import AssetRecord, CreateJobRequest, JobRecord, JobStatus, ProcessResult
from app.services.metadata_store import MetadataStore
from app.services.media_probe import detect_media_type, probe_media
from app.services.processing import process_asset
from app.services.preview import generate_asset_preview
from app.services.storage import StorageService

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_VIDEO_DIMENSION = 1920
MAX_VIDEO_DURATION_SECONDS = 180.0


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class JobManager:
    def __init__(self, storage: StorageService, metadata_store: MetadataStore) -> None:
        self.storage = storage
        self.metadata_store = metadata_store
        self.assets: Dict[str, AssetRecord] = self.metadata_store.load_assets()
        self.jobs: Dict[str, JobRecord] = self.metadata_store.load_jobs()
        self.lock = Lock()

    def register_upload(self, file: UploadFile) -> AssetRecord:
        if not file.filename:
            raise ValueError("File name is required.")
        media_type = detect_media_type(file.filename, file.content_type or "")
        stored_name, target_path = self.storage.make_upload_path(file.filename)

        with target_path.open("wb") as target:
            while chunk := file.file.read(1024 * 1024):
                target.write(chunk)

        file_size_bytes = target_path.stat().st_size
        if file_size_bytes > MAX_UPLOAD_BYTES:
            target_path.unlink(missing_ok=True)
            raise ValueError("File is larger than the 500MB limit for this local MVP.")

        width, height, duration_seconds = probe_media(target_path, media_type)
        if media_type.value == "video":
            if max(width, height) > MAX_VIDEO_DIMENSION:
                target_path.unlink(missing_ok=True)
                raise ValueError("Video resolution exceeds the 1080p limit for this build.")
            if duration_seconds > MAX_VIDEO_DURATION_SECONDS:
                target_path.unlink(missing_ok=True)
                raise ValueError("Video duration exceeds the 3 minute limit for this build.")

        preview_url = generate_asset_preview(target_path, media_type, self.storage)
        asset = AssetRecord(
            id=uuid4().hex,
            original_name=file.filename,
            stored_name=stored_name,
            media_type=media_type,
            content_type=file.content_type or "application/octet-stream",
            file_size_bytes=file_size_bytes,
            width=width,
            height=height,
            duration_seconds=round(duration_seconds, 2),
            url=self.storage.upload_url(stored_name),
            preview_url=preview_url,
            created_at=now_iso(),
        )
        with self.lock:
            self.assets[asset.id] = asset
            self.metadata_store.upsert_asset(asset)
        return asset

    def create_job(self, request: CreateJobRequest) -> JobRecord:
        asset = self.assets.get(request.asset_id)
        if asset is None:
            raise ValueError("Asset not found.")
        if asset.media_type.value == "image" and request.mode.value.startswith("video_"):
            raise ValueError("The selected video mode cannot run on an image.")
        if asset.media_type.value == "video" and request.mode.value.startswith("image_"):
            raise ValueError("The selected image mode cannot run on a video.")

        timestamp = now_iso()
        job = JobRecord(
            id=uuid4().hex,
            asset_id=asset.id,
            media_type=asset.media_type,
            mode=request.mode,
            status=JobStatus.QUEUED,
            progress=0,
            created_at=timestamp,
            updated_at=timestamp,
        )
        with self.lock:
            self.jobs[job.id] = job
            self.metadata_store.upsert_job(job)
        worker = Thread(target=self._run_job, args=(job.id,), daemon=True)
        worker.start()
        return job

    def get_job(self, job_id: str) -> JobRecord:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise ValueError("Job not found.")
            return job.model_copy(deep=True)

    def list_jobs(self) -> list[JobRecord]:
        with self.lock:
            jobs = [job.model_copy(deep=True) for job in self.jobs.values()]
        return sorted(jobs, key=lambda item: item.created_at, reverse=True)

    def _run_job(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs[job_id]
            job.status = JobStatus.RUNNING
            job.progress = 5
            job.updated_at = now_iso()
            asset = self.assets[job.asset_id]
            self.metadata_store.upsert_job(job)

        try:
            result = process_asset(asset, job.mode, self.storage, lambda value: self._set_progress(job_id, value))
        except Exception as error:
            with self.lock:
                failed = self.jobs[job_id]
                failed.status = JobStatus.FAILED
                failed.error = str(error)
                failed.updated_at = now_iso()
                failed.logs.append(str(error))
                self.metadata_store.upsert_job(failed)
            return

        self._finalize(job_id, result)

    def _set_progress(self, job_id: str, value: int) -> None:
        with self.lock:
            job = self.jobs[job_id]
            job.progress = max(0, min(100, value))
            job.updated_at = now_iso()
            self.metadata_store.upsert_job(job)

    def _finalize(self, job_id: str, result: ProcessResult) -> None:
        with self.lock:
            job = self.jobs[job_id]
            job.status = JobStatus.SUCCEEDED
            job.progress = 100
            job.result_url = result.result_url
            job.analysis_url = result.analysis_url
            job.detections = result.detections
            job.logs = result.logs
            job.updated_at = now_iso()
            self.metadata_store.upsert_job(job)
