from __future__ import annotations

from pathlib import Path

import cv2

from app.schemas.models import MediaType


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


def detect_media_type(filename: str, content_type: str) -> MediaType:
    extension = Path(filename).suffix.lower()
    if content_type.startswith("image/") or extension in IMAGE_EXTENSIONS:
        return MediaType.IMAGE
    if content_type.startswith("video/") or extension in VIDEO_EXTENSIONS:
        return MediaType.VIDEO
    raise ValueError("Unsupported media type. Please upload an image or video.")


def probe_media(path: Path, media_type: MediaType) -> tuple[int, int, float]:
    if media_type == MediaType.IMAGE:
        image = cv2.imread(str(path))
        if image is None:
            raise ValueError("Failed to decode image.")
        height, width = image.shape[:2]
        return width, height, 0.0

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError("Failed to open video.")
    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    finally:
        capture.release()

    duration_seconds = 0.0 if fps <= 0 else frame_count / fps
    return width, height, duration_seconds

