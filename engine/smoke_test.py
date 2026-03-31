from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.algorithms.image_cleaner import clean_image
from app.algorithms.video_cleaner import clean_video
from app.main import app
from app.schemas.models import JobMode


def run() -> None:
    base = Path("data") / "final-smoke"
    base.mkdir(parents=True, exist_ok=True)

    image = np.full((420, 720, 3), 226, dtype=np.uint8)
    cv2.rectangle(image, (0, 306), (720, 420), (180, 174, 165), -1)
    cv2.putText(image, "HELLO", (165, 190), cv2.FONT_HERSHEY_SIMPLEX, 2.1, (20, 20, 20), 5, cv2.LINE_AA)
    cv2.putText(image, "WM", (620, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (245, 245, 245), 2, cv2.LINE_AA)
    image_in = base / "input.png"
    image_out = base / "output.png"
    cv2.imwrite(str(image_in), image)
    image_detections, image_logs = clean_image(image_in, image_out, JobMode.AUTO)
    print("image", image_out.exists(), [d.label for d in image_detections], image_logs[-1])

    video_in = base / "input.mp4"
    video_out = base / "output.mp4"
    writer = cv2.VideoWriter(str(video_in), cv2.VideoWriter_fourcc(*"mp4v"), 10.0, (360, 240))
    for index in range(20):
        frame = np.zeros((240, 360, 3), dtype=np.uint8)
        frame[:] = (70 + index, 90 + index // 2, 120)
        cv2.circle(frame, (92 + index * 4, 110), 34, (42, 140, 220), -1)
        cv2.putText(frame, "TV", (304, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(frame, "SUBTITLE DEMO", (78, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.82, (248, 248, 248), 2, cv2.LINE_AA)
        writer.write(frame)
    writer.release()
    video_detections, video_logs = clean_video(video_in, video_out, JobMode.AUTO, lambda _: None)
    print("video", video_out.exists(), [d.label for d in video_detections], video_logs[-1])

    client = TestClient(app)
    with image_in.open("rb") as handle:
        upload = client.post("/api/uploads", files={"file": ("input.png", handle, "image/png")})
    upload.raise_for_status()
    asset = upload.json()
    job = client.post("/api/jobs", json={"asset_id": asset["id"], "mode": "auto"})
    job.raise_for_status()
    job_payload = job.json()
    for _ in range(40):
        status = client.get(f"/api/jobs/{job_payload['id']}")
        status.raise_for_status()
        payload = status.json()
        if payload["status"] in {"succeeded", "failed"}:
            print("api-job", payload["status"], bool(payload.get("analysis_url")), len(payload.get("detections", [])))
            break
        time.sleep(0.2)
    else:
        raise RuntimeError("API job timeout")

    list_response = client.get("/api/jobs")
    list_response.raise_for_status()
    print("api-list", len(list_response.json()) >= 1)


if __name__ == "__main__":
    run()
