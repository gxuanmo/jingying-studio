from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.schemas.models import AssetRecord, DetectionSummary, MediaType
from app.services.storage import StorageService


COLOR_BY_LABEL: dict[str, tuple[int, int, int]] = {
    "image_text": (38, 111, 244),
    "image_watermark": (0, 166, 153),
    "video_static_watermark": (0, 166, 153),
    "video_dynamic_watermark": (236, 115, 49),
    "video_bottom_subtitles": (117, 86, 251),
    "video_burned_subtitles": (221, 60, 110),
}


def _resize_preview(frame: np.ndarray, max_side: int = 1280) -> np.ndarray:
    height, width = frame.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    if scale == 1.0:
        return frame
    return cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)


def generate_asset_preview(input_path: Path, media_type: MediaType, storage: StorageService) -> str | None:
    if media_type == MediaType.IMAGE:
        return None

    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        return None

    frame = None
    try:
        for _ in range(12):
            ok, candidate = capture.read()
            if not ok:
                break
            if candidate is not None:
                frame = candidate
                break
    finally:
        capture.release()

    if frame is None:
        return None

    frame = _resize_preview(frame)
    stored_name, preview_path = storage.make_preview_path(".jpg")
    if not cv2.imwrite(str(preview_path), frame):
        return None
    return storage.preview_url(stored_name)


def generate_analysis_preview(
    asset: AssetRecord,
    detections: list[DetectionSummary],
    storage: StorageService,
) -> str | None:
    input_path = storage.uploads_dir / asset.stored_name
    if asset.media_type == MediaType.IMAGE:
        frame = cv2.imread(str(input_path))
    else:
        capture = cv2.VideoCapture(str(input_path))
        if not capture.isOpened():
            return None
        try:
            ok, frame = capture.read()
            if not ok:
                frame = None
        finally:
            capture.release()

    if frame is None:
        return None

    overlay = frame.copy()
    for detection in detections:
        color = COLOR_BY_LABEL.get(detection.label, (34, 102, 213))
        for raw_box in detection.boxes:
            if len(raw_box) != 4:
                continue
            x1, y1, x2, y2 = raw_box
            cv2.rectangle(overlay, (x1, y1), (x2, y2), color, -1)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            label = detection.label.replace("_", " ")
            cv2.putText(
                frame,
                label,
                (x1 + 4, max(18, y1 - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                color,
                1,
                cv2.LINE_AA,
            )

    frame = cv2.addWeighted(overlay, 0.18, frame, 0.82, 0)
    banner_height = 42
    canvas = np.full((frame.shape[0] + banner_height, frame.shape[1], 3), (18, 34, 39), dtype=np.uint8)
    canvas[banner_height:, :] = frame
    cv2.putText(
        canvas,
        f"Detected regions: {', '.join(detection.label for detection in detections) or 'none'}",
        (16, 26),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.58,
        (224, 240, 235),
        1,
        cv2.LINE_AA,
    )
    canvas = _resize_preview(canvas)
    stored_name, preview_path = storage.make_preview_path(".jpg")
    if not cv2.imwrite(str(preview_path), canvas):
        return None
    return storage.preview_url(stored_name)
