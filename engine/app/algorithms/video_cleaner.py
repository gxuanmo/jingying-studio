from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
import warnings

import cv2
import numpy as np

from app.algorithms.common import (
    Box,
    box_area,
    box_iou,
    clamp_box,
    detect_text_candidate_boxes,
    expand_box,
    group_line_boxes,
    merge_boxes,
    pick_corner_boxes,
    repeated_pattern_boxes,
    resize_with_scale,
    scale_boxes,
    threshold_text_energy,
)
from app.schemas.models import DetectionSummary, JobMode

CONFIDENCE_BY_LABEL = {
    "video_static_watermark": 0.52,
    "video_dynamic_watermark": 0.34,
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
    confidences: list[float]


@dataclass
class FrameDetection:
    boxes: list[Box]
    confidence: float


def _min_hits(label: str, total_frames: int) -> int:
    if label == "video_static_watermark":
        return max(2, min(8, max(2, total_frames // 26)))
    if label == "video_dynamic_watermark":
        return max(3, min(10, max(3, total_frames // 24)))
    if label == "video_bottom_subtitles":
        return max(3, min(12, max(4, total_frames // 16)))
    if label == "video_burned_subtitles":
        return max(3, min(10, max(4, total_frames // 18)))
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
    y1 = int(height * 0.62)
    roi = frame[y1:, :]
    boxes, confidence = _detect_boxes_scaled(
        roi,
        lambda gray: detect_text_candidate_boxes(gray, horizontal_bias=True, relaxed=True),
    )
    if not boxes:
        return [], 0.0
    translated = [clamp_box((x1, y1 + top, x2, y1 + bottom), width, height) for x1, top, x2, bottom in boxes]
    line_boxes = group_line_boxes(translated, width, height)
    filtered = [
        box
        for box in line_boxes
        if (box[2] - box[0]) > width * 0.12 and box[1] >= height * 0.56 and (box[3] - box[1]) < height * 0.16
    ]
    if not filtered:
        return [], 0.0
    return filtered, min(1.0, confidence + 0.18)


def _burned_subtitle_boxes(frame: np.ndarray) -> tuple[list[Box], float]:
    height, width = frame.shape[:2]
    candidate_boxes: list[Box] = []
    confidences: list[float] = []

    boxes, confidence = _detect_boxes_scaled(
        frame,
        lambda gray: detect_text_candidate_boxes(gray, horizontal_bias=True, relaxed=False),
    )
    if boxes:
        candidate_boxes.extend(boxes)
        confidences.append(min(1.0, confidence + 0.04))

    band_y1 = int(height * 0.18)
    band_y2 = int(height * 0.82)
    band = frame[band_y1:band_y2, :]
    band_boxes, band_confidence = _detect_boxes_scaled(
        band,
        lambda gray: detect_text_candidate_boxes(gray, horizontal_bias=True, relaxed=False),
    )
    if band_boxes:
        candidate_boxes.extend(
            [clamp_box((x1, band_y1 + y1, x2, band_y1 + y2), width, height) for x1, y1, x2, y2 in band_boxes]
        )
        confidences.append(min(1.0, band_confidence + 0.08))

    relaxed_boxes, relaxed_confidence = _detect_boxes_scaled(
        frame,
        lambda gray: detect_text_candidate_boxes(gray, horizontal_bias=True, relaxed=True),
    )
    if relaxed_boxes:
        candidate_boxes.extend(relaxed_boxes)
        confidences.append(max(0.0, relaxed_confidence - 0.06))

    boxes = [
        box
        for box in group_line_boxes(candidate_boxes, width, height)
        if height * 0.08 < box[1] < height * 0.82
        and ((box[1] + box[3]) / 2) < height * 0.78
        and (box[2] - box[0]) > width * 0.08
        and (box[2] - box[0]) < width * 0.82
        and (box[3] - box[1]) < height * 0.18
    ]
    if not boxes:
        return [], 0.0
    return boxes, min(1.0, max(confidences, default=0.0))


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
        box_width = box[2] - box[0]
        box_height = box[3] - box[1]
        if area_ratio < 0.00008 or area_ratio > 0.018:
            continue
        if box_width > width * 0.28 or box_height > height * 0.16:
            continue
        if box[1] >= height * 0.68:
            continue
        if any(box_iou(box, static_box) > 0.35 for static_box in static_boxes):
            continue
        candidates.append(box)
    return merge_boxes(candidates, width, height, gap=max(10, width // 100)), max(0.0, confidence - 0.05)


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


def _box_center(box: Box) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def _box_size_delta(a: Box, b: Box) -> float:
    aw = max(1.0, float(a[2] - a[0]))
    ah = max(1.0, float(a[3] - a[1]))
    bw = max(1.0, float(b[2] - b[0]))
    bh = max(1.0, float(b[3] - b[1]))
    return max(abs(aw - bw) / max(aw, bw), abs(ah - bh) / max(ah, bh))


def _track_config(label: str, total_frames: int) -> dict[str, float]:
    min_support = float(_min_hits(label, total_frames))
    if label == "video_dynamic_watermark":
        return {
            "max_gap": 12.0,
            "min_iou": 0.08,
            "center_distance_factor": 3.2,
            "size_tolerance": 0.8,
            "min_support": min_support,
            "min_confidence": max(0.28, CONFIDENCE_BY_LABEL[label] - 0.12),
            "max_interp_gap": 12.0,
        }
    if label == "video_bottom_subtitles":
        return {
            "max_gap": 3.0,
            "min_iou": 0.18,
            "center_distance_factor": 1.8,
            "size_tolerance": 0.45,
            "min_support": min_support,
            "min_confidence": max(0.4, CONFIDENCE_BY_LABEL[label] - 0.04),
            "max_interp_gap": 2.0,
        }
    if label == "video_burned_subtitles":
        return {
            "max_gap": 16.0,
            "min_iou": 0.1,
            "center_distance_factor": 2.0,
            "size_tolerance": 0.5,
            "min_support": min_support,
            "min_confidence": max(0.4, CONFIDENCE_BY_LABEL[label] - 0.05),
            "max_interp_gap": 16.0,
        }
    return {
        "max_gap": 3.0,
        "min_iou": 0.12,
        "center_distance_factor": 2.2,
        "size_tolerance": 0.6,
        "min_support": min_support,
        "min_confidence": max(0.38, CONFIDENCE_BY_LABEL[label] - 0.05),
        "max_interp_gap": 2.0,
    }


def _track_match_score(
    box: Box,
    track: Track,
    frame_index: int,
    *,
    max_gap: int,
    min_iou: float,
    center_distance_factor: float,
    size_tolerance: float,
) -> float:
    gap = frame_index - track.last_frame
    if gap < 1 or gap > max_gap:
        return -1.0

    iou = box_iou(box, track.last_box)
    center_x, center_y = _box_center(box)
    last_x, last_y = _box_center(track.last_box)
    center_distance = float(np.hypot(center_x - last_x, center_y - last_y))
    motion_scale = max(12.0, center_distance_factor * max(track.last_box[2] - track.last_box[0], track.last_box[3] - track.last_box[1]))
    size_delta = _box_size_delta(box, track.last_box)

    if iou < min_iou and (center_distance > motion_scale or size_delta > size_tolerance):
        return -1.0

    distance_score = max(0.0, 1.0 - (center_distance / motion_scale))
    size_score = max(0.0, 1.0 - (size_delta / max(size_tolerance, 1e-6)))
    temporal_penalty = 0.02 * max(0, gap - 1)
    return iou + (0.38 * distance_score) + (0.24 * size_score) - temporal_penalty


def _update_tracks(
    tracks: list[Track],
    frame_index: int,
    detections: list[tuple[Box, float]],
    *,
    max_gap: int,
    min_iou: float,
    center_distance_factor: float,
    size_tolerance: float,
) -> None:
    for box, confidence in detections:
        best_track: Track | None = None
        best_score = -1.0
        for track in tracks:
            candidate_score = _track_match_score(
                box,
                track,
                frame_index,
                max_gap=max_gap,
                min_iou=min_iou,
                center_distance_factor=center_distance_factor,
                size_tolerance=size_tolerance,
            )
            if candidate_score > best_score:
                best_score = candidate_score
                best_track = track
        if best_track is not None and best_score > 0.08:
            best_track.last_frame = frame_index
            best_track.last_box = box
            best_track.frames.append(frame_index)
            best_track.boxes.append(box)
            best_track.confidences.append(confidence)
        else:
            tracks.append(
                Track(
                    last_frame=frame_index,
                    last_box=box,
                    frames=[frame_index],
                    boxes=[box],
                    confidences=[confidence],
                )
            )


def _median_box(boxes: list[Box], width: int, height: int) -> Box:
    coords = np.asarray(boxes, dtype=np.float32)
    median = np.median(coords, axis=0)
    return clamp_box(tuple(int(round(value)) for value in median), width, height)


def _interpolate_box(a: Box, b: Box, alpha: float, width: int, height: int) -> Box:
    interpolated = tuple(int(round((1.0 - alpha) * av + alpha * bv)) for av, bv in zip(a, b))
    return clamp_box(interpolated, width, height)


def _smoothed_track_boxes(track: Track, width: int, height: int, max_interp_gap: int) -> dict[int, Box]:
    smoothed: dict[int, Box] = {}
    ordered = sorted(zip(track.frames, track.boxes), key=lambda item: item[0])
    frames = [item[0] for item in ordered]
    boxes = [item[1] for item in ordered]

    for index, frame_index in enumerate(frames):
        local_boxes = boxes[max(0, index - 2) : min(len(boxes), index + 3)]
        smoothed[frame_index] = _median_box(local_boxes, width, height)

    for index in range(len(frames) - 1):
        current_frame = frames[index]
        next_frame = frames[index + 1]
        gap = next_frame - current_frame
        if gap <= 1 or gap > max_interp_gap:
            continue
        for missing_frame in range(current_frame + 1, next_frame):
            alpha = (missing_frame - current_frame) / float(gap)
            smoothed[missing_frame] = _interpolate_box(
                smoothed[current_frame],
                smoothed[next_frame],
                alpha,
                width,
                height,
            )

    return smoothed


def _finalize_temporal_label(
    raw_frames: list[dict[str, FrameDetection]],
    label: str,
    total_frames: int,
    width: int,
    height: int,
) -> tuple[list[list[Box]], list[float], list[Track]]:
    config = _track_config(label, total_frames)
    tracks: list[Track] = []
    for frame_index, frame_payload in enumerate(raw_frames):
        detection = frame_payload.get(label)
        if detection is None or not detection.boxes:
            continue
        _update_tracks(
            tracks,
            frame_index,
            [(box, detection.confidence) for box in detection.boxes],
            max_gap=int(config["max_gap"]),
            min_iou=float(config["min_iou"]),
            center_distance_factor=float(config["center_distance_factor"]),
            size_tolerance=float(config["size_tolerance"]),
        )

    frame_boxes: list[list[Box]] = [[] for _ in range(total_frames)]
    frame_confidences = [0.0] * total_frames
    strong_tracks: list[Track] = []
    for track in tracks:
        support = len(track.frames)
        average_confidence = float(np.mean(track.confidences)) if track.confidences else 0.0
        boosted_confidence = min(0.99, average_confidence + min(0.18, support * 0.028))
        if support < int(config["min_support"]) or boosted_confidence < float(config["min_confidence"]):
            continue
        strong_tracks.append(track)
        for track_frame_index, box in _smoothed_track_boxes(track, width, height, max_interp_gap=int(config["max_interp_gap"])).items():
            frame_boxes[track_frame_index].append(box)
            frame_confidences[track_frame_index] = max(frame_confidences[track_frame_index], boosted_confidence)

    for frame_index, boxes in enumerate(frame_boxes):
        if boxes:
            frame_boxes[frame_index] = merge_boxes(boxes, width, height, gap=max(12, width // 110))

    return frame_boxes, frame_confidences, strong_tracks


def _pad_box_for_label(box: Box, label: str, width: int, height: int) -> Box:
    box_width = box[2] - box[0]
    box_height = box[3] - box[1]
    if label == "video_bottom_subtitles":
        return expand_box(box, max(10, box_width // 14), max(6, box_height // 2), width, height)
    if label == "video_burned_subtitles":
        return expand_box(box, max(8, box_width // 12), max(6, box_height // 3), width, height)
    if label == "video_dynamic_watermark":
        return expand_box(box, max(8, box_width // 8), max(6, box_height // 4), width, height)
    return expand_box(box, max(8, box_width // 6), max(6, box_height // 4), width, height)


def _refine_box_mask(gray: np.ndarray, box: Box, label: str) -> np.ndarray:
    x1, y1, x2, y2 = box
    roi = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return np.zeros((0, 0), dtype=np.uint8)
    if roi.shape[0] < 8 or roi.shape[1] < 12:
        return np.full(roi.shape, 255, dtype=np.uint8)

    horizontal_bias = label in {"video_bottom_subtitles", "video_burned_subtitles"}
    energy = threshold_text_energy(roi, horizontal_bias=horizontal_bias, relaxed=True)
    edges = cv2.Canny(roi, 48, 128)
    candidate = cv2.max(energy, edges)
    candidate = cv2.morphologyEx(
        candidate,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3 if horizontal_bias else 2, 2)),
    )
    candidate = cv2.dilate(candidate, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)), iterations=1)

    coverage = float(np.count_nonzero(candidate)) / float(candidate.size)
    if coverage < 0.04:
        return np.full_like(candidate, 255)
    if coverage > 0.88:
        tightened = cv2.erode(candidate, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)), iterations=1)
        if np.count_nonzero(tightened):
            return tightened
    return candidate


def _build_mask(frame: np.ndarray, detections: dict[str, list[Box]]) -> np.ndarray:
    height, width = frame.shape[:2]
    if not detections:
        return np.zeros((height, width), dtype=np.uint8)

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    mask = np.zeros((height, width), dtype=np.uint8)
    for label, boxes in detections.items():
        for box in boxes:
            padded = _pad_box_for_label(box, label, width, height)
            x1, y1, x2, y2 = padded
            component_mask = _refine_box_mask(gray, padded, label)
            target = mask[y1:y2, x1:x2]
            np.maximum(target, component_mask, out=target)

    if not np.any(mask):
        return mask

    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
    )
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)), iterations=1)
    return mask


def _repair_frame(center_frame: np.ndarray, center_mask: np.ndarray, neighbors: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    repaired = center_frame.copy()
    fill_mask = center_mask > 0
    if not np.any(fill_mask):
        return repaired

    height, width = center_frame.shape[:2]
    warped_candidates: list[np.ndarray] = []
    valid_masks: list[np.ndarray] = []

    for neighbor_frame, neighbor_mask in neighbors:
        warp = _estimate_warp(neighbor_frame, center_frame)
        warped_frame = _warp_neighbor(neighbor_frame, warp, width, height)
        warped_mask = _warp_neighbor(neighbor_mask, warp, width, height, is_mask=True)
        valid = fill_mask & (warped_mask < 32)
        if not np.any(valid):
            continue
        warped_candidates.append(warped_frame.astype(np.float32))
        valid_masks.append(valid)

    valid_pixels = np.zeros(fill_mask.shape, dtype=bool)
    if warped_candidates:
        candidate_stack = np.stack(warped_candidates, axis=0)
        valid_stack = np.stack(valid_masks, axis=0)
        masked_candidates = np.where(valid_stack[..., None], candidate_stack, np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            candidate_median = np.nanmedian(masked_candidates, axis=0)
            candidate_mean = np.nanmean(masked_candidates, axis=0)
        blended = np.where(np.isnan(candidate_median), candidate_mean, candidate_median)
        valid_pixels = np.isfinite(blended).all(axis=2) & fill_mask
        repaired[valid_pixels] = np.clip(blended[valid_pixels], 0, 255).astype(np.uint8)

    unresolved = fill_mask & ~valid_pixels
    if np.any(unresolved):
        fallback = cv2.inpaint(repaired, unresolved.astype(np.uint8) * 255, 4, cv2.INPAINT_TELEA)
        repaired[unresolved] = fallback[unresolved]
    return repaired


def clean_video(
    input_path: Path,
    output_path: Path,
    mode: JobMode,
    progress_callback,
) -> tuple[list[DetectionSummary], list[str]]:
    static_analysis = _analyze_static_watermarks(input_path, mode)
    logs = list(static_analysis.notes)

    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise ValueError("Failed to open the uploaded video.")

    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 24.0)
    metadata_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        capture.release()
        raise ValueError("Video metadata is incomplete.")

    raw_frames: list[dict[str, FrameDetection]] = []
    frame_index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break

            detections: dict[str, FrameDetection] = {}
            if mode in {JobMode.AUTO, JobMode.VIDEO_BOTTOM_SUBTITLES}:
                boxes, confidence = _bottom_subtitle_boxes(frame)
                detections["video_bottom_subtitles"] = FrameDetection(boxes=boxes, confidence=confidence)
            if mode in {JobMode.AUTO, JobMode.VIDEO_BURNED_SUBTITLES}:
                boxes, confidence = _burned_subtitle_boxes(frame)
                detections["video_burned_subtitles"] = FrameDetection(boxes=boxes, confidence=confidence)
            if mode in {JobMode.AUTO, JobMode.VIDEO_DYNAMIC_WATERMARK}:
                boxes, confidence = _dynamic_boxes(frame, static_analysis.boxes)
                detections["video_dynamic_watermark"] = FrameDetection(boxes=boxes, confidence=confidence)

            raw_frames.append(detections)
            frame_index += 1
            denominator = max(metadata_frame_count, frame_index)
            progress_callback(8 + int((frame_index / denominator) * 34))
    finally:
        capture.release()

    total_processed_frames = len(raw_frames)
    if total_processed_frames == 0:
        raise ValueError("No frames were decoded from the uploaded video.")

    frame_detections: list[dict[str, FrameDetection]] = [{} for _ in range(total_processed_frames)]

    if mode in {JobMode.AUTO, JobMode.VIDEO_STATIC_WATERMARK} and static_analysis.boxes and _passes_confidence(
        "video_static_watermark", static_analysis.confidence
    ):
        for frame_payload in frame_detections:
            frame_payload["video_static_watermark"] = FrameDetection(
                boxes=static_analysis.boxes,
                confidence=static_analysis.confidence,
            )
        logs.append("Static watermark mode uses a video-level persistent mask.")
    elif mode == JobMode.VIDEO_STATIC_WATERMARK:
        raise ValueError("No persistent static watermark cluster was found.")

    for label, requested_mode in (
        ("video_bottom_subtitles", JobMode.VIDEO_BOTTOM_SUBTITLES),
        ("video_burned_subtitles", JobMode.VIDEO_BURNED_SUBTITLES),
        ("video_dynamic_watermark", JobMode.VIDEO_DYNAMIC_WATERMARK),
    ):
        if mode not in {JobMode.AUTO, requested_mode}:
            continue

        frame_boxes, frame_confidences, strong_tracks = _finalize_temporal_label(
            raw_frames,
            label,
            total_processed_frames,
            width,
            height,
        )
        logs.append(f"{label} tracks kept after temporal stabilization: {len(strong_tracks)}.")

        if requested_mode == mode and not strong_tracks:
            if label == "video_dynamic_watermark":
                raise ValueError("Dynamic watermark tracking confidence stayed below the safety threshold.")
            if label == "video_burned_subtitles":
                raise ValueError("Burned subtitle detection did not stay stable enough across frames.")
            raise ValueError("Bottom subtitle detection did not stay stable enough across frames.")

        for index, boxes in enumerate(frame_boxes):
            confidence = frame_confidences[index]
            if boxes and _passes_confidence(label, confidence):
                frame_detections[index][label] = FrameDetection(boxes=boxes, confidence=confidence)

    if mode == JobMode.AUTO and not any(frame_payload for frame_payload in frame_detections):
        raise ValueError("No high-confidence removable watermark or subtitle pattern was detected in this video.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(output_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps if fps > 0 else 24.0,
        (width, height),
    )
    if not writer.isOpened():
        raise ValueError("Failed to initialize the video writer.")

    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        writer.release()
        raise ValueError("Failed to reopen the uploaded video for rendering.")

    buffer_radius = 3
    frame_buffer: deque[np.ndarray] = deque()
    mask_buffer: deque[np.ndarray] = deque()
    stats = defaultdict(lambda: {"hits": 0, "area": 0.0, "boxes": [], "confidence_sum": 0.0})
    render_index = 0

    def enqueue(frame: np.ndarray, index: int) -> None:
        active = frame_detections[index]
        for label, payload in active.items():
            if not payload.boxes:
                continue
            stats[label]["hits"] += 1
            stats[label]["area"] += sum(box_area(box) for box in payload.boxes) / float(width * height)
            stats[label]["boxes"] = [list(box) for box in payload.boxes[:3]]
            stats[label]["confidence_sum"] += payload.confidence

        frame_buffer.append(frame)
        mask_buffer.append(_build_mask(frame, {label: payload.boxes for label, payload in active.items() if payload.boxes}))

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
            enqueue(frame, render_index)
            flush(process_all=False)
            render_index += 1
            progress_callback(45 + int((render_index / total_processed_frames) * 50))
        flush(process_all=True)
    finally:
        capture.release()
        writer.release()

    detections: list[DetectionSummary] = []
    for label, payload in stats.items():
        if payload["hits"] < _min_hits(label, total_processed_frames):
            continue
        average_confidence = payload["confidence_sum"] / payload["hits"]
        hit_ratio = payload["hits"] / float(total_processed_frames)
        confidence = min(0.99, (0.72 * average_confidence) + (0.2 * min(1.0, hit_ratio * 3.0)) + 0.06)
        detections.append(
            DetectionSummary(
                label=label,
                confidence=round(confidence, 3),
                area_ratio=round(payload["area"] / payload["hits"], 4),
                frame_hits=int(payload["hits"]),
                boxes=payload["boxes"],
                notes=[f"Triggered on {payload['hits']} frames after temporal stabilization."],
            )
        )

    if mode != JobMode.AUTO and not detections:
        raise ValueError("The selected video mode did not produce a confident removable region.")

    logs.append(
        "Video pipeline: classical candidate localization + temporal track stabilization + motion-compensated background fusion + Telea fallback."
    )
    return detections, logs
