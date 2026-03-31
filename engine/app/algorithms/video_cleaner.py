from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.algorithms.common import (
    Box,
    box_area,
    box_iou,
    boxes_to_mask,
    clamp_box,
    detect_text_candidate_boxes,
    expand_box,
    group_line_boxes,
    merge_boxes,
    pick_corner_boxes,
    repeated_pattern_boxes,
    resize_with_scale,
    scale_boxes,
)
from app.schemas.models import DetectionSummary, JobMode

CONFIDENCE_BY_LABEL = {
    "video_static_watermark": 0.52,
    "video_dynamic_watermark": 0.44,
    "video_bottom_subtitles": 0.5,
    "video_burned_subtitles": 0.46,
}


@dataclass
class StaticAnalysis:
    boxes: list[Box]
    confidence: float
    notes: list[str]


@dataclass
class Track:
    last_frame: int
    last_box: Box
    frames: list[int]
    boxes: list[Box]


def _min_hits(label: str, total_frames: int) -> int:
    if label == "video_static_watermark":
        return max(2, total_frames // 26)
    if label == "video_dynamic_watermark":
        return max(5, total_frames // 18)
    if label == "video_bottom_subtitles":
        return max(4, total_frames // 16)
    if label == "video_burned_subtitles":
        return max(4, total_frames // 18)
    return 1


def _passes_confidence(label: str, confidence: float) -> bool:
    return confidence >= CONFIDENCE_BY_LABEL.get(label, 0.0)


def _detect_boxes_scaled(frame: np.ndarray, detector) -> tuple[list[Box], float]:
    resized, scale = resize_with_scale(frame, max_side=960)
    inverse_scale = 1.0 / scale
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    result = detector(gray)
    boxes = scale_boxes(result.boxes, inverse_scale, frame.shape[1], frame.shape[0])
    return boxes, result.confidence


def _bottom_subtitle_boxes(frame: np.ndarray) -> tuple[list[Box], float]:
    height, width = frame.shape[:2]
    y1 = int(height * 0.65)
    roi = frame[y1:, :]
    boxes, confidence = _detect_boxes_scaled(
        roi,
        lambda gray: detect_text_candidate_boxes(gray, horizontal_bias=True, relaxed=True),
    )
    if not boxes:
        return [], 0.0
    translated = [clamp_box((x1, y1 + top, x2, y1 + bottom), width, height) for x1, top, x2, bottom in boxes]
    line_boxes = group_line_boxes(translated, width, height)
    filtered = [box for box in line_boxes if (box[2] - box[0]) > width * 0.12]
    if not filtered:
        return [], 0.0
    return filtered, min(1.0, confidence + 0.18)


def _burned_subtitle_boxes(frame: np.ndarray) -> tuple[list[Box], float]:
    height, width = frame.shape[:2]
    boxes, confidence = _detect_boxes_scaled(
        frame,
        lambda gray: detect_text_candidate_boxes(gray, horizontal_bias=True, relaxed=True),
    )
    boxes = [
        box
        for box in group_line_boxes(boxes, width, height)
        if height * 0.08 < box[1] < height * 0.84 and (box[2] - box[0]) > width * 0.08
    ]
    if not boxes:
        return [], 0.0
    return boxes, max(0.0, confidence - 0.08)


def _watermark_boxes(frame: np.ndarray) -> tuple[list[Box], float]:
    height, width = frame.shape[:2]
    boxes, confidence = _detect_boxes_scaled(frame, lambda gray: detect_text_candidate_boxes(gray, relaxed=True))
    candidates = merge_boxes(
        pick_corner_boxes(boxes, width, height) + repeated_pattern_boxes(boxes, width, height),
        width,
        height,
        gap=max(12, width // 120),
    )
    if not candidates:
        return [], 0.0
    return candidates, min(1.0, confidence + 0.1)


def _dynamic_boxes(frame: np.ndarray, static_boxes: list[Box]) -> tuple[list[Box], float]:
    height, width = frame.shape[:2]
    boxes, confidence = _detect_boxes_scaled(frame, lambda gray: detect_text_candidate_boxes(gray, relaxed=True))
    candidates: list[Box] = []
    for box in boxes:
        area_ratio = box_area(box) / float(width * height)
        if area_ratio < 0.00008 or area_ratio > 0.018:
            continue
        if box[1] >= height * 0.68:
            continue
        if any(box_iou(box, static_box) > 0.35 for static_box in static_boxes):
            continue
        candidates.append(box)
    return merge_boxes(candidates, width, height, gap=max(10, width // 100)), max(0.0, confidence - 0.06)


def _analyze_static_watermarks(path: Path, requested_mode: JobMode) -> StaticAnalysis:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError("Failed to open video during analysis.")
    edge_accumulators: list[np.ndarray] | None = None
    corner_regions: list[tuple[int, int, int, int]] | None = None
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    try:
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        sample_step = max(1, total_frames // 36) if total_frames else 8
        clusters: list[dict[str, object]] = []
        frame_index = 0
        sampled = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % sample_step == 0:
                if edge_accumulators is None or corner_regions is None:
                    frame_height, frame_width = frame.shape[:2]
                    margin_x = max(48, int(frame_width * 0.28))
                    margin_y = max(40, int(frame_height * 0.24))
                    corner_regions = [
                        (0, 0, margin_x, margin_y),
                        (frame_width - margin_x, 0, frame_width, margin_y),
                        (0, frame_height - margin_y, margin_x, frame_height),
                        (frame_width - margin_x, frame_height - margin_y, frame_width, frame_height),
                    ]
                    edge_accumulators = [
                        np.zeros((region[3] - region[1], region[2] - region[0]), dtype=np.float32)
                        for region in corner_regions
                    ]

                boxes, confidence = _watermark_boxes(frame)
                for box in boxes:
                    matched = False
                    for cluster in clusters:
                        if box_iou(box, cluster["box"]) > 0.55:
                            cluster["hits"] = int(cluster["hits"]) + 1
                            cluster["confidence"] = float(cluster["confidence"]) + confidence
                            cluster["box"] = (
                                int((cluster["box"][0] + box[0]) / 2),
                                int((cluster["box"][1] + box[1]) / 2),
                                int((cluster["box"][2] + box[2]) / 2),
                                int((cluster["box"][3] + box[3]) / 2),
                            )
                            matched = True
                            break
                    if not matched:
                        clusters.append({"box": box, "hits": 1, "confidence": confidence})

                for index, (x1, y1, x2, y2) in enumerate(corner_regions or []):
                    roi = frame[y1:y2, x1:x2]
                    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                    edges = cv2.Canny(gray, 80, 180)
                    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)
                    edge_accumulators[index] += (edges > 0).astype(np.float32)
                sampled += 1
            frame_index += 1
    finally:
        capture.release()

    if sampled == 0:
        return StaticAnalysis([], 0.0, ["No frames were available for static watermark analysis."])

    persistent = [cluster for cluster in clusters if int(cluster["hits"]) / sampled >= 0.45]
    persistent_boxes = [cluster["box"] for cluster in persistent]

    edge_boxes: list[Box] = []
    if edge_accumulators is not None and corner_regions is not None:
        for index, accumulator in enumerate(edge_accumulators):
            if accumulator.size == 0:
                continue
            persistent_edges = ((accumulator / sampled) > 0.56).astype(np.uint8) * 255
            persistent_edges = cv2.morphologyEx(
                persistent_edges,
                cv2.MORPH_CLOSE,
                cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)),
            )
            component_count, _, stats, _ = cv2.connectedComponentsWithStats(persistent_edges, connectivity=8)
            region = corner_regions[index]
            roi_area = max(1, (region[2] - region[0]) * (region[3] - region[1]))
            for component_index in range(1, component_count):
                x, y, w, h, area = stats[component_index]
                if area < max(18, roi_area * 0.0016):
                    continue
                if area > roi_area * 0.18:
                    continue
                edge_boxes.append(
                    clamp_box(
                        (region[0] + x, region[1] + y, region[0] + x + w, region[1] + y + h),
                        frame_width,
                        frame_height,
                    )
                )

    if frame_width > 0 and frame_height > 0:
        boxes = merge_boxes(persistent_boxes + edge_boxes, frame_width, frame_height, gap=max(10, frame_width // 120))
    else:
        boxes = persistent_boxes + edge_boxes
    average_confidence = 0.0
    if persistent:
        average_confidence = sum(float(cluster["confidence"]) / int(cluster["hits"]) for cluster in persistent) / len(persistent)
        average_confidence = min(1.0, average_confidence + 0.12)
    if edge_boxes:
        average_confidence = min(1.0, max(average_confidence, 0.46) + 0.08)
    notes = [
        f"Sampled {sampled} frames for static watermark persistence.",
        f"Persistent corner clusters: {len(persistent_boxes)}.",
        f"Corner edge-persistence regions: {len(edge_boxes)}.",
    ]
    if requested_mode == JobMode.VIDEO_STATIC_WATERMARK and average_confidence < CONFIDENCE_BY_LABEL["video_static_watermark"]:
        notes.append("Static watermark confidence stayed below the safety threshold.")
    return StaticAnalysis(boxes=boxes, confidence=average_confidence, notes=notes)


def _estimate_warp(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    source_gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
    target_gray = cv2.cvtColor(target, cv2.COLOR_BGR2GRAY)
    source_small, scale = resize_with_scale(source_gray, max_side=480)
    target_small, _ = resize_with_scale(target_gray, max_side=480)

    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-4)
    try:
        cv2.findTransformECC(target_small, source_small, warp, cv2.MOTION_EUCLIDEAN, criteria, None, 1)
    except cv2.error:
        return np.eye(2, 3, dtype=np.float32)

    if scale != 1.0:
        warp = warp.copy()
        warp[0, 2] /= scale
        warp[1, 2] /= scale
    return warp


def _warp_neighbor(frame: np.ndarray, warp: np.ndarray, width: int, height: int, is_mask: bool = False) -> np.ndarray:
    return cv2.warpAffine(
        frame,
        warp,
        (width, height),
        flags=(cv2.INTER_NEAREST if is_mask else cv2.INTER_LINEAR) | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _repair_frame(center_frame: np.ndarray, center_mask: np.ndarray, neighbors: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    height, width = center_frame.shape[:2]
    repaired = center_frame.copy()
    fill_mask = center_mask > 0
    candidate_sum = np.zeros_like(center_frame, dtype=np.float32)
    candidate_count = np.zeros((height, width, 1), dtype=np.float32)

    for neighbor_frame, neighbor_mask in neighbors:
        if not np.any(fill_mask):
            break
        warp = _estimate_warp(neighbor_frame, center_frame)
        warped_frame = _warp_neighbor(neighbor_frame, warp, width, height)
        warped_mask = _warp_neighbor(neighbor_mask, warp, width, height, is_mask=True)
        valid = fill_mask & (warped_mask < 32)
        if not np.any(valid):
            continue
        candidate_sum[valid] += warped_frame[valid].astype(np.float32)
        candidate_count[valid] += 1.0

    valid_pixels = candidate_count.squeeze(-1) > 0
    repaired[valid_pixels] = np.clip(candidate_sum[valid_pixels] / candidate_count[valid_pixels], 0, 255).astype(np.uint8)

    unresolved = fill_mask & ~valid_pixels
    if np.any(unresolved):
        repaired = cv2.inpaint(repaired, unresolved.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
    return repaired


def _build_mask(frame_shape: tuple[int, int, int], boxes: list[Box]) -> np.ndarray:
    height, width = frame_shape[:2]
    padded = [
        expand_box(
            box,
            padding_x=max(8, (box[2] - box[0]) // 6),
            padding_y=max(6, (box[3] - box[1]) // 5),
            width=width,
            height=height,
        )
        for box in boxes
    ]
    merged = merge_boxes(padded, width, height, gap=max(10, width // 120))
    return boxes_to_mask((height, width), merged)


def _update_tracks(tracks: list[Track], frame_index: int, boxes: list[Box]) -> None:
    for box in boxes:
        best_track: Track | None = None
        best_score = 0.0
        for track in tracks:
            if frame_index - track.last_frame > 8:
                continue
            candidate_score = box_iou(box, track.last_box)
            if candidate_score > best_score:
                best_score = candidate_score
                best_track = track
        if best_track and best_score > 0.05:
            best_track.last_frame = frame_index
            best_track.last_box = box
            best_track.frames.append(frame_index)
            best_track.boxes.append(box)
        else:
            tracks.append(Track(last_frame=frame_index, last_box=box, frames=[frame_index], boxes=[box]))


def clean_video(
    input_path: Path,
    output_path: Path,
    mode: JobMode,
    progress_callback,
) -> tuple[list[DetectionSummary], list[str]]:
    static_analysis = _analyze_static_watermarks(input_path, mode)

    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise ValueError("Failed to open the uploaded video.")

    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 24.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        capture.release()
        raise ValueError("Video metadata is incomplete.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(output_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps if fps > 0 else 24.0,
        (width, height),
    )
    if not writer.isOpened():
        capture.release()
        raise ValueError("Failed to initialize the video writer.")

    buffer_radius = 2
    frame_buffer: deque[np.ndarray] = deque()
    mask_buffer: deque[np.ndarray] = deque()
    stats = defaultdict(lambda: {"hits": 0, "area": 0.0, "boxes": []})
    logs = list(static_analysis.notes)
    dynamic_tracks: list[Track] = []
    frame_index = 0

    def detect_frame_boxes(frame: np.ndarray, index: int) -> dict[str, tuple[list[Box], float]]:
        detections: dict[str, tuple[list[Box], float]] = {}
        if mode in {JobMode.AUTO, JobMode.VIDEO_STATIC_WATERMARK} and static_analysis.boxes:
            detections["video_static_watermark"] = (static_analysis.boxes, static_analysis.confidence)
        elif mode == JobMode.VIDEO_STATIC_WATERMARK and static_analysis.confidence < 0.52:
            detections["video_static_watermark"] = ([], static_analysis.confidence)

        if mode in {JobMode.AUTO, JobMode.VIDEO_BOTTOM_SUBTITLES}:
            detections["video_bottom_subtitles"] = _bottom_subtitle_boxes(frame)
        if mode in {JobMode.AUTO, JobMode.VIDEO_BURNED_SUBTITLES}:
            detections["video_burned_subtitles"] = _burned_subtitle_boxes(frame)
        if mode in {JobMode.AUTO, JobMode.VIDEO_DYNAMIC_WATERMARK}:
            dynamic_boxes, confidence = _dynamic_boxes(frame, static_analysis.boxes)
            detections["video_dynamic_watermark"] = (dynamic_boxes, confidence)
            _update_tracks(dynamic_tracks, index, dynamic_boxes)
        return detections

    def enqueue(frame: np.ndarray, index: int) -> None:
        detections = detect_frame_boxes(frame, index)
        merged_boxes: list[Box] = []
        for label, (boxes, confidence) in detections.items():
            if not boxes or not _passes_confidence(label, confidence):
                continue
            if boxes:
                merged_boxes.extend(boxes)
                stats[label]["hits"] += 1
                stats[label]["area"] += sum(box_area(box) for box in boxes) / float(width * height)
                stats[label]["boxes"] = [list(box) for box in boxes[:3]]
        frame_buffer.append(frame)
        mask_buffer.append(_build_mask(frame.shape, merged_boxes))

    def flush(process_all: bool = False) -> None:
        while frame_buffer and (process_all or len(frame_buffer) > buffer_radius * 2):
            center_index = min(buffer_radius, len(frame_buffer) // 2)
            center_frame = frame_buffer[center_index]
            center_mask = mask_buffer[center_index]
            neighbors = [(frame_buffer[i], mask_buffer[i]) for i in range(len(frame_buffer)) if i != center_index]
            repaired = _repair_frame(center_frame, center_mask, neighbors)
            writer.write(repaired)
            del frame_buffer[center_index]
            del mask_buffer[center_index]

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            enqueue(frame, frame_index)
            flush(process_all=False)
            frame_index += 1
            if frame_count:
                progress_callback(12 + int((frame_index / frame_count) * 83))
        flush(process_all=True)
    finally:
        capture.release()
        writer.release()

    detections: list[DetectionSummary] = []
    total_processed_frames = max(frame_index, 1)

    if mode == JobMode.VIDEO_DYNAMIC_WATERMARK:
        strong_tracks = [track for track in dynamic_tracks if len(track.frames) >= 5]
        if not strong_tracks:
            raise ValueError("Dynamic watermark tracking confidence stayed below the safety threshold.")
        logs.append(f"Dynamic watermark tracks kept: {len(strong_tracks)}.")

    if mode == JobMode.VIDEO_BURNED_SUBTITLES and stats["video_burned_subtitles"]["hits"] < _min_hits("video_burned_subtitles", total_processed_frames):
        raise ValueError("Burned subtitle detection did not stay stable enough across frames.")

    if mode == JobMode.VIDEO_BOTTOM_SUBTITLES and stats["video_bottom_subtitles"]["hits"] < _min_hits("video_bottom_subtitles", total_processed_frames):
        raise ValueError("Bottom subtitle detection did not stay stable enough across frames.")

    if mode == JobMode.VIDEO_STATIC_WATERMARK and not static_analysis.boxes:
        raise ValueError("No persistent static watermark cluster was found.")

    for label, payload in stats.items():
        if payload["hits"] < _min_hits(label, total_processed_frames):
            continue
        detections.append(
            DetectionSummary(
                label=label,
                confidence=round(min(0.99, payload["hits"] / total_processed_frames + 0.22), 3),
                area_ratio=round(payload["area"] / payload["hits"], 4),
                frame_hits=int(payload["hits"]),
                boxes=payload["boxes"],
                notes=[f"Triggered on {payload['hits']} frames."],
            )
        )

    if mode == JobMode.AUTO and not detections:
        raise ValueError("No high-confidence removable watermark or subtitle pattern was detected in this video.")
    if mode != JobMode.AUTO and not detections:
        raise ValueError("The selected video mode did not produce a confident removable region.")

    logs.append("Video pipeline: detection per frame + temporal neighbor repair + Telea fallback.")
    return detections, logs
