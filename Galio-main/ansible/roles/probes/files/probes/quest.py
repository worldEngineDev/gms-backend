#!/usr/bin/env python3
"""Quest 头显探针：ADB 连通、手柄连接状态、手柄/头显电量、App 通信。

ADB 连通性用 subprocess 调 adb 命令实现。
手柄/电量通过 adb shell dump 读 Quest 系统属性。
"""
from __future__ import annotations

import re
import subprocess

from _probe_protocol import main


def describe() -> dict:
    return {
        "device_type": "quest",
        "metrics": ["adb_connected", "controller_connected", "headset_battery", "controller_battery"],
        "check_items": ["quest_adb_ok"],
    }


def _adb_cmd(args: list[str], timeout: int = 5) -> str:
    """执行 adb 命令，返回 stdout。失败返回空字符串。"""
    try:
        result = subprocess.run(["adb"] + args, capture_output=True, text=True, timeout=timeout, check=False)
        return result.stdout.strip() if result.returncode == 0 else ""
    except FileNotFoundError:
        return ""
    except Exception:
        return ""


def _adb_connected() -> bool:
    state = _adb_cmd(["get-state"])
    return state == "device"


def _get_battery_level() -> int | None:
    """读头显电量百分比。"""
    out = _adb_cmd(["shell", "dumpsys", "battery"], timeout=10)
    match = re.search(r"level:\s*(\d+)", out)
    return int(match.group(1)) if match else None


def _get_controller_connected() -> bool:
    """检查手柄是否连接。"""
    out = _adb_cmd(["shell", "dumpsys", "input"], timeout=10)
    # Quest 手柄设备名含 "controller"
    return "controller" in out.lower()


def _get_controller_battery() -> int | None:
    """读手柄电量百分比。"""
    out = _adb_cmd(["shell", "dumpsys", "battery"], timeout=10)
    matches = re.findall(r"level:\s*(\d+)", out)
    return int(matches[1]) if len(matches) > 1 else None


def collect() -> dict:
    adb_ok = _adb_connected()
    if not adb_ok:
        return {"status": "fail", "metrics": {"adb_connected": 0}}
    controller = _get_controller_connected()
    headset_batt = _get_battery_level()
    return {
        "status": "ok" if adb_ok else "fail",
        "metrics": {
            "adb_connected": 1 if adb_ok else 0,
            "controller_connected": 1 if controller else 0,
            "headset_battery": headset_batt if headset_batt is not None else -1,
            "controller_battery": -1,  # 手柄电量需要更复杂的解析，先占位
        },
    }


def check(item_id: str) -> dict:
    if item_id == "quest_adb_ok":
        ok = _adb_connected()
        batt = _get_battery_level()
        evidence = {"adb_connected": ok, "headset_battery": batt}
        if ok:
            return {"result": "pass", "evidence": evidence, "suggestion": None}
        else:
            return {"result": "fail", "evidence": evidence, "suggestion": "ADB 未连接，检查 USB 线缆或头显开发者模式"}
    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
