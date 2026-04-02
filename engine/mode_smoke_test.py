from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.algorithms.video_cleaner import clean_video
from app.schemas.models import JobMode


BASE = Path("data") / "mode-smoke"
WIDTH = 384
HEIGHT = 240
FPS = 12.0
FRAMES = 24


def _background(frame_index: int) -> np.ndarray:
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:] = (70 + (frame_index * 2) % 50, 92 + frame_index % 24, 126)
    cv2.circle(frame, (70 + frame_index * 7, 90), 28, (48, 150, 220), -1)
    cv2.rectangle(
        frame,
        (160 + (frame_index * 3) % 70, 70),
        (230 + (frame_index * 3) % 70, 150),
        (180, 120, 70),
        -1,
    )
    cv2.line(frame, (0, 170), (WIDTH, 145 + (frame_index % 8)), (140, 180, 120), 3)
    return frame


def _write_video(name: str, painter) -> Path:
    BASE.mkdir(parents=True, exist_ok=True)
    path = BASE / f"{name}.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (WIDTH, HEIGHT))
    for frame_index in range(FRAMES):
        frame = _background(frame_index)
        painter(frame, frame_index)
        writer.write(frame)
    writer.release()
    return path


def run() -> None:
    cases = [
        (
            "static",
            JobMode.VIDEO_STATIC_WATERMARK,
            lambda frame, _: cv2.putText(
                frame,
                "TV",
                (320, 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.62,
                (250, 250, 250),
                2,
                cv2.LINE_AA,
            ),
        ),
        (
            "dynamic",
            JobMode.VIDEO_DYNAMIC_WATERMARK,
            lambda frame, index: cv2.putText(
                frame,
                "LOGO",
                (20 + index * 7, 34 + (index % 4) * 3),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (250, 250, 250),
                2,
                cv2.LINE_AA,
            ),
        ),
        (
            "bottom",
            JobMode.VIDEO_BOTTOM_SUBTITLES,
            lambda frame, _: cv2.putText(
                frame,
                "BOTTOM SUBTITLE",
                (72, 220),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.82,
                (248, 248, 248),
                2,
                cv2.LINE_AA,
            ),
        ),
        (
            "burned",
            JobMode.VIDEO_BURNED_SUBTITLES,
            lambda frame, _: cv2.putText(
                frame,
                "BURNED TEXT",
                (92, 138),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.82,
                (248, 248, 248),
                2,
                cv2.LINE_AA,
            ),
        ),
    ]

    for name, mode, painter in cases:
        input_path = _write_video(name, painter)
        output_path = BASE / f"{name}-out.mp4"
        detections, logs = clean_video(input_path, output_path, mode, lambda _: None)
        labels = [d.label for d in detections]
        print(name, output_path.exists(), labels, logs[-1])


if __name__ == "__main__":
    run()
