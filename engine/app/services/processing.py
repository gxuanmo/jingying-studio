from __future__ import annotations

from app.algorithms.image_cleaner import clean_image
from app.algorithms.video_cleaner import clean_video
from app.schemas.models import AssetRecord, MediaType, ProcessResult
from app.services.preview import generate_analysis_preview
from app.services.storage import StorageService


def process_asset(asset: AssetRecord, mode, storage: StorageService, progress_callback) -> ProcessResult:
    input_path = storage.uploads_dir / asset.stored_name
    if asset.media_type == MediaType.IMAGE:
        progress_callback(20)
        result_name, output_path = storage.make_result_path(".png")
        detections, logs = clean_image(input_path, output_path, mode)
        analysis_url = generate_analysis_preview(asset, detections, storage)
        progress_callback(100)
        return ProcessResult(
            result_url=storage.result_url(result_name),
            analysis_url=analysis_url,
            detections=detections,
            logs=logs,
        )

    progress_callback(10)
    result_name, output_path = storage.make_result_path(".mp4")
    detections, logs = clean_video(input_path, output_path, mode, progress_callback)
    analysis_url = generate_analysis_preview(asset, detections, storage)
    progress_callback(100)
    return ProcessResult(
        result_url=storage.result_url(result_name),
        analysis_url=analysis_url,
        detections=detections,
        logs=logs,
    )
