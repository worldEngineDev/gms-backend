#!/usr/bin/env python3
"""摄像头探针：三路相机识别、实际帧率、帧输出健康度。

业务相机约定：
  - front：前置/RealSense 彩色相机
  - left_wrist：左手腕 USB Camera
  - right_wrist：右手腕 USB Camera

优先按 v4l2 设备名识别；识别不到时按稳定的 /dev/video* 顺序兜底。
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

from _probe_protocol import main


BUSINESS_CAMERA_IDS = ("front", "left_wrist", "right_wrist")


def describe() -> dict:
    return {
        "device_type": "camera",
        "metrics": [
            "camera_enumerated",
            "protocol_negotiated",
            "frame_health",
            "camera_fps_avg",
            "camera_front_fps",
            "camera_left_wrist_fps",
            "camera_right_wrist_fps",
        ],
        "check_items": ["camera_online", "camera_frame_ok"],
    }


def _v4l2_info(dev: str) -> dict:
    """读取 v4l2 设备描述；工具不可用时保留设备节点本身。"""
    info = ""
    try:
        result = subprocess.run(
            ["v4l2-ctl", "--device", dev, "--all"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        info = f"{result.stdout}\n{result.stderr}"
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        info = ""

    name_match = re.search(r"(?:Card type|Card)\s*:\s*(.+)", info, re.IGNORECASE)
    pixel_match = re.search(r"Pixel Format\s*:\s*'([^']+)'", info, re.IGNORECASE)
    size_match = re.search(r"Width/Height\s*:\s*(\d+)\s*/\s*(\d+)", info, re.IGNORECASE)
    fps_match = re.search(r"Frames per second\s*:\s*([\d.]+)", info, re.IGNORECASE)
    if fps_match is None:
        fps_match = re.search(r"([\d.]+)\s*fps", info, re.IGNORECASE)

    # metadata-only node（如 RealSense 的 metadata）没有 Video Capture 能力。
    capture_node = not info or bool(re.search(r"Video Capture", info, re.IGNORECASE))
    return {
        "device": dev,
        "name": name_match.group(1).strip() if name_match else dev,
        "pixel_format": pixel_match.group(1).strip() if pixel_match else None,
        "max_fps": float(fps_match.group(1)) if fps_match else 30.0,
        "width": int(size_match.group(1)) if size_match else None,
        "height": int(size_match.group(2)) if size_match else None,
        "capture_node": capture_node,
    }


def _enumerate_cameras() -> list[dict]:
    """枚举视频采集节点并分配 front/left_wrist/right_wrist 业务 ID。"""
    cameras = []
    for i in range(32):
        path = f"/dev/video{i}"
        if os.path.exists(path):
            item = _v4l2_info(path)
            if item["capture_node"]:
                cameras.append(item)

    cameras.sort(key=lambda item: int(re.search(r"(\d+)$", item["device"]).group(1)))
    for camera in cameras:
        camera["camera_id"] = None

    # 与 machine-heartbeat-agent 保持一致：RealSense 彩色流作为前置相机。
    realsense = [
        c for c in cameras
        if re.search(r"realsense|depth camera|intel", c["name"], re.IGNORECASE)
    ]
    color_realsense = [
        c for c in realsense
        if not str(c.get("pixel_format") or "").upper().startswith("Z16")
    ]
    if color_realsense:
        front = max(
            color_realsense,
            key=lambda c: (c.get("width") or 0) * (c.get("height") or 0),
        )
    elif realsense:
        front = realsense[0]
    else:
        front = None
    if front:
        front["camera_id"] = "front"

    # 现场设备名可能不是 RealSense/USB Camera，先按稳定设备号给剩余节点
    # 分配前置，再分配左右手腕；这样三路普通 USB 摄像头也不会把前置漏掉。
    unassigned = [c for c in cameras if not c["camera_id"]]
    for camera_id in BUSINESS_CAMERA_IDS:
        if any(c["camera_id"] == camera_id for c in cameras):
            continue
        if unassigned:
            unassigned.pop(0)["camera_id"] = camera_id

    return cameras


def _v4l2_negotiated(camera: dict) -> bool:
    dev = camera["device"]
    try:
        result = subprocess.run(
            ["v4l2-ctl", "--device", dev, "--get-fmt-video"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return result.returncode == 0 and "pixelformat" in result.stdout.lower()
    except FileNotFoundError:
        return os.path.exists(dev)
    except (subprocess.TimeoutExpired, OSError):
        return False


def _frame_health(camera: dict) -> str:
    """抓两帧缩略灰度图比较，返回 ok|frozen|unknown。"""
    dev = camera["device"]
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "v4l2", "-i", dev, "-frames:v", "2",
                "-vf", "scale=16:16,format=gray", "-f", "rawvideo", "-",
            ],
            capture_output=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or len(result.stdout) < 512:
            return "unknown"
        frame_size = len(result.stdout) // 2
        first, second = result.stdout[:frame_size], result.stdout[frame_size:frame_size * 2]
        if not first or not second:
            return "unknown"
        if hashlib.sha256(first).digest() == hashlib.sha256(second).digest():
            return "frozen"
        return "ok"
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return "unknown"


def _measure_fps(camera: dict, frames: int = 30) -> float | None:
    """短窗口实测帧率，并用当前 V4L2 模式上限限制 burst 误判。"""
    dev = camera["device"]
    started = time.monotonic()
    try:
        result = subprocess.run(
            [
                "v4l2-ctl", "--device", dev,
                "--stream-mmap", f"--stream-count={frames}",
                "--stream-to=/dev/null",
            ],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if result.returncode == 0:
            elapsed = time.monotonic() - started
            if elapsed > 0:
                measured = frames / elapsed
                return round(min(measured, camera.get("max_fps") or 30.0), 2)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass

    # 部分 UVC 驱动不支持 v4l2-ctl streaming，使用 ffmpeg 兜底。
    started = time.monotonic()
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "info",
                "-f", "v4l2", "-i", dev, "-frames:v", str(frames),
                "-f", "null", "-",
            ],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        output = f"{result.stdout}\n{result.stderr}"
        matches = re.findall(r"frame=\s*(\d+)", output)
        actual_frames = int(matches[-1]) if matches else (frames if result.returncode == 0 else 0)
        elapsed = time.monotonic() - started
        if actual_frames > 0 and elapsed > 0:
            measured = actual_frames / elapsed
            return round(min(measured, camera.get("max_fps") or 30.0), 2)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def _run_per_camera(cameras: list[dict], fn) -> list:
    if not cameras:
        return []
    with ThreadPoolExecutor(max_workers=min(3, len(cameras))) as pool:
        return list(pool.map(fn, cameras))


def _status_metrics(cameras: list[dict]) -> tuple[dict, list[str], list[str]]:
    negotiated = _run_per_camera(cameras, _v4l2_negotiated)
    frame_statuses = _run_per_camera(cameras, _frame_health)
    fps_values = _run_per_camera(cameras, _measure_fps)
    metrics = {
        "camera_enumerated": len(cameras),
        "protocol_negotiated": 1 if negotiated and all(negotiated) else 0,
        "frame_health": 1 if frame_statuses and all(v == "ok" for v in frame_statuses) else 0,
        "camera_fps_avg": round(
            sum(v for v in fps_values if v is not None) /
            max(1, sum(v is not None for v in fps_values)), 2
        ) if any(v is not None for v in fps_values) else -1,
    }
    for camera, fps, frame in zip(cameras, fps_values, frame_statuses):
        camera_id = camera.get("camera_id") or camera["device"].replace("/dev/", "").replace("-", "_")
        metrics[f"camera_{camera_id}_fps"] = fps if fps is not None else -1
        metrics[f"camera_{camera_id}_frame_ok"] = 1 if frame == "ok" else 0
    return metrics, frame_statuses, fps_values


def collect() -> dict:
    cameras = _enumerate_cameras()
    if not cameras:
        return {"status": "fail", "metrics": {"camera_enumerated": 0}}
    metrics, frames, fps = _status_metrics(cameras)
    available = [value for value in fps if value is not None and value > 0]
    if all(_v4l2_negotiated(c) for c in cameras) and all(v == "ok" for v in frames):
        status = "ok" if len(available) == len(cameras) else "degraded"
    else:
        status = "degraded" if available else "fail"
    return {"status": status, "metrics": metrics}


def check(item_id: str) -> dict:
    cameras = _enumerate_cameras()
    if item_id == "camera_online":
        if not cameras:
            return {"result": "fail", "evidence": {"cameras": []}, "suggestion": "无摄像头设备，检查 USB 连接"}
        negotiated = {c["device"]: _v4l2_negotiated(c) for c in cameras}
        if all(negotiated.values()):
            return {"result": "pass", "evidence": {"cameras": negotiated}, "suggestion": None}
        return {
            "result": "fail",
            "evidence": {"cameras": negotiated},
            "suggestion": f"摄像头协商失败: {[dev for dev, ok in negotiated.items() if not ok]}",
        }

    if item_id == "camera_frame_ok":
        if not cameras:
            return {"result": "fail", "evidence": {}, "suggestion": "无摄像头设备"}
        metrics, frames, fps = _status_metrics(cameras)
        evidence = {
            "metrics": metrics,
            "cameras": [
                {"device": c["device"], "camera_id": c.get("camera_id"), "frame_health": frame, "fps": value}
                for c, frame, value in zip(cameras, frames, fps)
            ],
        }
        if all(v == "ok" for v in frames) and all(v is not None and v > 0 for v in fps):
            return {"result": "pass", "evidence": evidence, "suggestion": None}
        if any(v == "frozen" for v in frames):
            return {"result": "fail", "evidence": evidence, "suggestion": "画面冻结，检查摄像头是否被遮挡"}
        return {"result": "unknown", "evidence": evidence, "suggestion": "帧检测工具不可用或摄像头未输出"}

    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
