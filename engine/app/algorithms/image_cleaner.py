from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.algorithms.common import (
    DetectionResult,
    box_area,
    boxes_to_mask,
    detect_text_candidate_boxes,
    expand_box,
    merge_boxes,
    pick_corner_boxes,
    repeated_pattern_boxes,
    resize_with_scale,
    scale_boxes,
)
from app.schemas.models import DetectionSummary, JobMode


def _corner_edge_boxes(gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    height, width = gray.shape[:2]
    margin_x = max(48, int(width * 0.28))
    margin_y = max(40, int(height * 0.24))
    regions = [
        (0, 0, margin_x, margin_y),
        (width - margin_x, 0, width, margin_y),
        (0, height - margin_y, margin_x, height),
        (width - margin_x, height - margin_y, width, height),
    ]
    boxes: list[tuple[int, int, int, int]] = []
    for x1, y1, x2, y2 in regions:
        roi = gray[y1:y2, x1:x2]
        edges = cv2.Canny(roi, 70, 150)
        edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)))
        component_count, _, stats, _ = cv2.connectedComponentsWithStats(edges, connectivity=8)
        roi_area = max(1, roi.shape[0] * roi.shape[1])
        for index in range(1, component_count):
            cx, cy, w, h, area = stats[index]
            if area < max(18, roi_area * 0.0018):
                continue
            if area > roi_area * 0.22:
                continue
            boxes.append((x1 + cx, y1 + cy, x1 + cx + w, y1 + cy + h))
    return merge_boxes(boxes, width, height, gap=max(10, width // 100))


def _build_watermark_result(gray: np.ndarray) -> DetectionResult:
    height, width = gray.shape[:2]
    candidate_result = detect_text_candidate_boxes(gray, relaxed=True)
    corner_boxes = pick_corner_boxes(candidate_result.boxes, width, height) if candidate_result.boxes else []
    tiled_boxes = repeated_pattern_boxes(candidate_result.boxes, width, height)
    edge_boxes = _corner_edge_boxes(gray)
    merged = merge_boxes(corner_boxes + tiled_boxes + edge_boxes, width, height, gap=max(10, width // 90))
    if not merged:
        return DetectionResult(notes=["No corner, repeated, or edge-stable watermark pattern was strong enough."])

    area_ratio = sum(box_area(box) for box in merged) / float(width * height)
    confidence = max(
        0.0,
        min(
            1.0,
            (candidate_result.confidence * 0.72)
            + (0.22 if corner_boxes else 0.0)
            + (0.12 if tiled_boxes else 0.0)
            + (0.1 if edge_boxes else 0.0)
            - (0.15 * area_ratio),
        ),
    )
    return DetectionResult(
        boxes=merged,
        confidence=confidence,
        area_ratio=area_ratio,
        notes=[
            f"Watermark candidates: {len(merged)} regions.",
            "Corner bias, repeated-pattern search, and edge-stable corner analysis were applied.",
        ],
    )


def _summary(label: str, result: DetectionResult, boxes_override: list[list[int]] | None = None) -> DetectionSummary:
    return DetectionSummary(
        label=label,
        confidence=round(result.confidence, 3),
        area_ratio=round(result.area_ratio, 4),
        boxes=boxes_override if boxes_override is not None else [list(box) for box in result.boxes],
        notes=result.notes,
    )


def clean_image(input_path: Path, output_path: Path, mode: JobMode) -> tuple[list[DetectionSummary], list[str]]:
    image = cv2.imread(str(input_path))
    if image is None:
        raise ValueError("Failed to decode the uploaded image.")

    original_height, original_width = image.shape[:2]
    work_image, scale = resize_with_scale(image, max_side=1600)
    inverse_scale = 1.0 / scale
    gray = cv2.cvtColor(work_image, cv2.COLOR_BGR2GRAY)

    text_result = detect_text_candidate_boxes(gray, relaxed=True)
    watermark_result = _build_watermark_result(gray)

    selected_boxes = []
    detection_payloads: list[tuple[str, DetectionResult]] = []
    logs = [
        "Image pipeline: morphology + connected components + classical inpainting.",
        "No external detection or inpainting model is used in this MVP.",
    ]

    if mode in {JobMode.AUTO, JobMode.IMAGE_TEXT} and text_result.confidence >= 0.42:
        selected_boxes.extend(text_result.boxes)
        detection_payloads.append(("image_text", text_result))
    elif mode == JobMode.IMAGE_TEXT:
        raise ValueError("Low confidence while detecting removable text in this image.")

    if mode in {JobMode.AUTO, JobMode.IMAGE_WATERMARK} and watermark_result.confidence >= 0.48:
        selected_boxes.extend(watermark_result.boxes)
        detection_payloads.append(("image_watermark", watermark_result))
    elif mode == JobMode.IMAGE_WATERMARK:
        raise ValueError("Low confidence while detecting removable watermark patterns in this image.")

    if mode == JobMode.AUTO and not selected_boxes:
        raise ValueError("No high-confidence removable text or watermark was detected.")

    if not detection_payloads and mode not in {JobMode.AUTO, JobMode.IMAGE_TEXT, JobMode.IMAGE_WATERMARK}:
        raise ValueError("The selected mode is not valid for image input.")

    padded_boxes = [
        expand_box(
            box,
            padding_x=max(8, (box[2] - box[0]) // 6),
            padding_y=max(6, (box[3] - box[1]) // 4),
            width=work_image.shape[1],
            height=work_image.shape[0],
        )
        for box in selected_boxes
    ]
    merged_boxes = merge_boxes(
        padded_boxes,
        work_image.shape[1],
        work_image.shape[0],
        gap=max(12, work_image.shape[1] // 100),
    )
    if not merged_boxes:
        raise ValueError("Detection finished, but no final mask survived refinement.")

    mask = boxes_to_mask(work_image.shape[:2], merged_boxes)
    area_ratio = float(np.count_nonzero(mask)) / float(mask.size)
    if area_ratio > 0.28:
        raise ValueError("Removal area is too large for the current classical image pipeline.")

    inpaint_radius = 4 if area_ratio < 0.015 else 7
    repaired = cv2.inpaint(work_image, mask, inpaintRadius=inpaint_radius, flags=cv2.INPAINT_TELEA)

    final_boxes = merged_boxes
    if scale != 1.0:
        repaired = cv2.resize(repaired, (original_width, original_height), interpolation=cv2.INTER_LINEAR)
        final_boxes = scale_boxes(merged_boxes, inverse_scale, original_width, original_height)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), repaired):
        raise ValueError("Failed to write cleaned image to disk.")

    logs.append(f"Final image mask covered {area_ratio:.2%} of the working frame.")
    detections = []
    for label, result in detection_payloads:
        detections.append(_summary(label, result, boxes_override=[list(box) for box in final_boxes]))
    return detections, logs
