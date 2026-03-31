from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import cv2
import numpy as np


Box = tuple[int, int, int, int]


@dataclass
class DetectionResult:
    boxes: list[Box] = field(default_factory=list)
    confidence: float = 0.0
    area_ratio: float = 0.0
    notes: list[str] = field(default_factory=list)


def odd_kernel(value: int) -> int:
    return max(3, value + (1 - value % 2))


def resize_with_scale(image: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    if scale == 1.0:
        return image, 1.0
    resized = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def clamp_box(box: Box, width: int, height: int) -> Box:
    x1, y1, x2, y2 = box
    x1 = max(0, min(x1, width - 1))
    x2 = max(x1 + 1, min(x2, width))
    y1 = max(0, min(y1, height - 1))
    y2 = max(y1 + 1, min(y2, height))
    return x1, y1, x2, y2


def scale_boxes(boxes: Iterable[Box], inverse_scale: float, width: int, height: int) -> list[Box]:
    scaled: list[Box] = []
    for x1, y1, x2, y2 in boxes:
        scaled.append(
            clamp_box(
                (
                    int(round(x1 * inverse_scale)),
                    int(round(y1 * inverse_scale)),
                    int(round(x2 * inverse_scale)),
                    int(round(y2 * inverse_scale)),
                ),
                width,
                height,
            )
        )
    return scaled


def expand_box(box: Box, padding_x: int, padding_y: int, width: int, height: int) -> Box:
    x1, y1, x2, y2 = box
    return clamp_box((x1 - padding_x, y1 - padding_y, x2 + padding_x, y2 + padding_y), width, height)


def box_area(box: Box) -> int:
    x1, y1, x2, y2 = box
    return max(0, x2 - x1) * max(0, y2 - y1)


def box_iou(a: Box, b: Box) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    x1 = max(ax1, bx1)
    y1 = max(ay1, by1)
    x2 = min(ax2, bx2)
    y2 = min(ay2, by2)
    intersection = box_area((x1, y1, x2, y2))
    if intersection <= 0:
        return 0.0
    union = box_area(a) + box_area(b) - intersection
    return 0.0 if union <= 0 else intersection / union


def merge_boxes(boxes: Iterable[Box], width: int, height: int, gap: int = 12) -> list[Box]:
    remaining = [clamp_box(box, width, height) for box in boxes if box_area(box) > 0]
    if not remaining:
        return []

    merged = True
    while merged:
        merged = False
        next_boxes: list[Box] = []
        while remaining:
            current = remaining.pop()
            cx1, cy1, cx2, cy2 = current
            bucket = [current]
            still_remaining: list[Box] = []
            for candidate in remaining:
                x1, y1, x2, y2 = candidate
                intersects = not (x2 < cx1 - gap or x1 > cx2 + gap or y2 < cy1 - gap or y1 > cy2 + gap)
                if intersects:
                    bucket.append(candidate)
                    cx1 = min(cx1, x1)
                    cy1 = min(cy1, y1)
                    cx2 = max(cx2, x2)
                    cy2 = max(cy2, y2)
                    merged = True
                else:
                    still_remaining.append(candidate)
            remaining = still_remaining
            next_boxes.append(clamp_box((cx1, cy1, cx2, cy2), width, height))
        remaining = next_boxes
    return sorted(remaining, key=lambda box: (box[1], box[0]))


def boxes_to_mask(shape: tuple[int, int], boxes: Iterable[Box]) -> np.ndarray:
    mask = np.zeros(shape, dtype=np.uint8)
    for x1, y1, x2, y2 in boxes:
        mask[y1:y2, x1:x2] = 255
    return mask


def threshold_text_energy(gray: np.ndarray, horizontal_bias: bool = False, relaxed: bool = False) -> np.ndarray:
    small = cv2.GaussianBlur(gray, (0, 0), 1.0)
    top_hat_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (odd_kernel(gray.shape[1] // (24 if horizontal_bias else 32)), 3)
    )
    black_hat_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (odd_kernel(gray.shape[1] // (20 if horizontal_bias else 28)), 3)
    )
    top_hat = cv2.morphologyEx(small, cv2.MORPH_TOPHAT, top_hat_kernel)
    black_hat = cv2.morphologyEx(small, cv2.MORPH_BLACKHAT, black_hat_kernel)
    gradient = cv2.morphologyEx(small, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    score = cv2.max(cv2.max(top_hat, black_hat), gradient)
    if relaxed:
        score = cv2.equalizeHist(score)
    _, thresholded = cv2.threshold(score, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thresholded = cv2.morphologyEx(
        thresholded,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (odd_kernel(gray.shape[1] // 72), odd_kernel(gray.shape[0] // 160))),
    )
    thresholded = cv2.dilate(
        thresholded,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3 if horizontal_bias else 2, 2)),
        iterations=1,
    )
    return thresholded


def connected_component_boxes(mask: np.ndarray, gray: np.ndarray) -> list[tuple[Box, float]]:
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    height, width = gray.shape[:2]
    image_area = height * width
    boxes: list[tuple[Box, float]] = []
    for index in range(1, component_count):
        x, y, w, h, area = stats[index]
        if area < max(24, image_area * 0.00004):
            continue
        if area > image_area * 0.18:
            continue
        ratio = w / max(1, h)
        if ratio < 0.18 or ratio > 28:
            continue
        component_mask = labels[y : y + h, x : x + w] == index
        fill_ratio = float(component_mask.mean())
        if fill_ratio < 0.06 or fill_ratio > 0.95:
            continue
        crop = gray[y : y + h, x : x + w]
        contrast = float(crop.max() - crop.min()) / 255.0
        edge_score = float(cv2.Laplacian(crop, cv2.CV_32F).var()) / 255.0
        score = (0.55 * fill_ratio) + (0.25 * contrast) + (0.2 * min(edge_score, 1.0))
        boxes.append(((x, y, x + w, y + h), score))
    return boxes


def detect_text_candidate_boxes(gray: np.ndarray, horizontal_bias: bool = False, relaxed: bool = False) -> DetectionResult:
    height, width = gray.shape[:2]
    thresholded = threshold_text_energy(gray, horizontal_bias=horizontal_bias, relaxed=relaxed)
    components = connected_component_boxes(thresholded, gray)
    boxes = [component[0] for component in components]
    merged_boxes = merge_boxes(boxes, width, height, gap=max(10, width // 80))
    if not merged_boxes:
        return DetectionResult(notes=["No text-like connected components survived filtering."])

    weighted_score = sum(component[1] for component in components) / max(len(components), 1)
    area_ratio = sum(box_area(box) for box in merged_boxes) / float(width * height)
    confidence = max(0.0, min(1.0, (0.62 * weighted_score) + (0.25 * min(len(merged_boxes), 6) / 6.0) - (0.18 * area_ratio)))
    return DetectionResult(
        boxes=merged_boxes,
        confidence=confidence,
        area_ratio=area_ratio,
        notes=[f"Detected {len(merged_boxes)} text-like regions."],
    )


def group_line_boxes(boxes: Iterable[Box], width: int, height: int) -> list[Box]:
    ordered = sorted(boxes, key=lambda item: (item[1], item[0]))
    grouped: list[list[Box]] = []
    for box in ordered:
        added = False
        x1, y1, x2, y2 = box
        cy = (y1 + y2) / 2
        for group in grouped:
            gy1 = min(item[1] for item in group)
            gy2 = max(item[3] for item in group)
            gcy = (gy1 + gy2) / 2
            avg_height = sum(item[3] - item[1] for item in group) / len(group)
            if abs(cy - gcy) <= max(10, avg_height * 0.85):
                group.append(box)
                added = True
                break
        if not added:
            grouped.append([box])
    line_boxes = []
    for group in grouped:
        if len(group) == 1 and box_area(group[0]) < width * height * 0.0008:
            continue
        x1 = min(item[0] for item in group)
        y1 = min(item[1] for item in group)
        x2 = max(item[2] for item in group)
        y2 = max(item[3] for item in group)
        line_boxes.append(clamp_box((x1, y1, x2, y2), width, height))
    return merge_boxes(line_boxes, width, height, gap=max(12, width // 50))


def pick_corner_boxes(boxes: Iterable[Box], width: int, height: int, margin_ratio: float = 0.32) -> list[Box]:
    margin_x = width * margin_ratio
    margin_y = height * margin_ratio
    selected: list[Box] = []
    for box in boxes:
        x1, y1, x2, y2 = box
        if (x2 <= margin_x or x1 >= width - margin_x) and (y2 <= margin_y or y1 >= height - margin_y):
            selected.append(box)
    return selected


def repeated_pattern_boxes(boxes: Iterable[Box], width: int, height: int) -> list[Box]:
    ordered = sorted(boxes, key=lambda box: box_area(box))
    selected: list[Box] = []
    for index, box in enumerate(ordered):
        bw = box[2] - box[0]
        bh = box[3] - box[1]
        similar = 1
        for candidate in ordered[index + 1 :]:
            cw = candidate[2] - candidate[0]
            ch = candidate[3] - candidate[1]
            if abs(cw - bw) <= max(8, bw * 0.35) and abs(ch - bh) <= max(6, bh * 0.35):
                similar += 1
        if similar >= 3 and box_area(box) < width * height * 0.015:
            selected.append(box)
    return merge_boxes(selected, width, height, gap=max(16, width // 40))

