from __future__ import annotations

from enum import Enum
from typing import List

from pydantic import BaseModel, Field


class MediaType(str, Enum):
    IMAGE = "image"
    VIDEO = "video"


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobMode(str, Enum):
    AUTO = "auto"
    IMAGE_TEXT = "image_text"
    IMAGE_WATERMARK = "image_watermark"
    VIDEO_STATIC_WATERMARK = "video_static_watermark"
    VIDEO_DYNAMIC_WATERMARK = "video_dynamic_watermark"
    VIDEO_BOTTOM_SUBTITLES = "video_bottom_subtitles"
    VIDEO_BURNED_SUBTITLES = "video_burned_subtitles"


class DetectionSummary(BaseModel):
    label: str
    confidence: float
    area_ratio: float = 0.0
    frame_hits: int = 0
    boxes: List[List[int]] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)


class AssetRecord(BaseModel):
    id: str
    original_name: str
    stored_name: str
    media_type: MediaType
    content_type: str
    file_size_bytes: int
    width: int
    height: int
    duration_seconds: float = 0.0
    url: str
    preview_url: str | None = None
    created_at: str


class CreateJobRequest(BaseModel):
    asset_id: str
    mode: JobMode = JobMode.AUTO


class JobRecord(BaseModel):
    id: str
    asset_id: str
    media_type: MediaType
    mode: JobMode
    status: JobStatus
    progress: int = 0
    created_at: str
    updated_at: str
    result_url: str | None = None
    analysis_url: str | None = None
    error: str | None = None
    detections: List[DetectionSummary] = Field(default_factory=list)
    logs: List[str] = Field(default_factory=list)


class ProcessResult(BaseModel):
    result_url: str
    analysis_url: str | None = None
    detections: List[DetectionSummary]
    logs: List[str] = Field(default_factory=list)
