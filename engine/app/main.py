from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import load_settings
from app.schemas.models import CreateJobRequest
from app.services.job_manager import JobManager
from app.services.metadata_store import MetadataStore
from app.services.storage import StorageService


BASE_DIR = Path(__file__).resolve().parents[1]
settings = load_settings(BASE_DIR)
storage = StorageService(settings.data_dir)
metadata_store = MetadataStore(settings.metadata_db_path)
job_manager = JobManager(storage, metadata_store)

app = FastAPI(title=settings.app_title, version=settings.app_version)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=storage.uploads_dir), name="uploads")
app.mount("/results", StaticFiles(directory=storage.results_dir), name="results")
app.mount("/previews", StaticFiles(directory=storage.previews_dir), name="previews")


@app.get("/api/health")
def health() -> dict[str, str | int]:
    return {
        "status": "ok",
        "assets": len(job_manager.assets),
        "jobs": len(job_manager.jobs),
    }


@app.post("/api/uploads")
def upload_asset(file: UploadFile = File(...)):
    try:
        return job_manager.register_upload(file)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/jobs")
def create_job(request: CreateJobRequest):
    try:
        return job_manager.create_job(request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/jobs")
def list_jobs():
    return job_manager.list_jobs()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    try:
        return job_manager.get_job(job_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
