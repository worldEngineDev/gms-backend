#!/usr/bin/env python3
"""USB 链路探针：传输速率实测、接口规格（3.0 协商结果）、插口松动（错误计数/重枚举事件）。

读 /sys/bus/usb/devices/ 获取 USB 设备信息。速率实测需要具体设备路径映射，先做枚举+规格检测。
"""
from __future__ import annotations

import os
import re

from _probe_protocol import main


def describe() -> dict:
    return {
        "device_type": "link",
        "metrics": ["usb_transfer_rate", "usb_spec_negotiated", "reenum_count"],
        "check_items": ["link_speed_ok"],
    }


def _list_usb_devices() -> list[dict]:
    """枚举 /sys/bus/usb/devices/ 下的 USB 设备。"""
    base = "/sys/bus/usb/devices/"
    if not os.path.isdir(base):
        return []
    devices = []
    for name in os.listdir(base):
        if not name.startswith("usb"):
            continue
        dev_path = os.path.join(base, name)
        info = {"name": name}
        # 读 speed（Mbps）
        speed_path = os.path.join(dev_path, "speed")
        if os.path.exists(speed_path):
            try:
                with open(speed_path) as f:
                    info["speed"] = int(f.read().strip())
            except (ValueError, OSError):
                info["speed"] = None
        # 读 USB 版本（2.0/3.0）
        ver_path = os.path.join(dev_path, "version")
        if os.path.exists(ver_path):
            try:
                with open(ver_path) as f:
                    info["version"] = f.read().strip()
            except OSError:
                info["version"] = None
        # 读 product 名称
        prod_path = os.path.join(dev_path, "product")
        if os.path.exists(prod_path):
            try:
                with open(prod_path) as f:
                    info["product"] = f.read().strip()
            except OSError:
                pass
        devices.append(info)
    return devices


def _get_usb_errors() -> int:
    """读 dmesg 中的 USB 错误计数（枚举失败/断开重连）。"""
    try:
        with open("/var/log/dmesg") as f:
            log = f.read()
        return len(re.findall(r"usb.*error|usb.*disconnect|usb.*reset", log, re.IGNORECASE))
    except (FileNotFoundError, OSError):
        return 0


def collect() -> dict:
    devices = _list_usb_devices()
    if not devices:
        return {"status": "unknown", "metrics": {}}
    # USB 3.0 speed = 5000 Mbps, USB 2.0 = 480 Mbps
    speeds = [d.get("speed", 0) for d in devices if d.get("speed")]
    max_speed = max(speeds) if speeds else 0
    # 3.0 协商成功 = 有设备 speed >= 5000
    spec_30 = any(s >= 5000 for s in speeds) if speeds else False
    errors = _get_usb_errors()
    return {
        "status": "ok" if devices else "unknown",
        "metrics": {
            "usb_transfer_rate": max_speed,
            "usb_spec_negotiated": 1 if spec_30 else 0,
            "reenum_count": errors,
        },
    }


def check(item_id: str) -> dict:
    if item_id == "link_speed_ok":
        devices = _list_usb_devices()
        if not devices:
            return {"result": "unknown", "evidence": {}, "suggestion": "无 USB 设备或 /sys/bus/usb 不可访问"}
        speeds = [d.get("speed", 0) for d in devices if d.get("speed")]
        if not speeds:
            return {"result": "unknown", "evidence": {"devices": devices}, "suggestion": "无法读取 USB 速率"}
        max_speed = max(speeds)
        # USB 3.0 = 5000 Mbps, USB 2.0 = 480 Mbps
        if max_speed >= 480:
            return {"result": "pass", "evidence": {"max_speed_mbps": max_speed, "devices": devices},
                    "suggestion": None}
        else:
            return {"result": "fail", "evidence": {"max_speed_mbps": max_speed, "devices": devices},
                    "suggestion": f"USB 速率过低: {max_speed} Mbps，检查 USB 线缆和接口"}
    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
