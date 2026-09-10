#!/usr/bin/env python3
"""机械臂探针：状态、SDK 拖拽模式、上位机状态、超限/越线事件。

机械臂 SDK（libMarvinSDK.so）存在端口独占问题（见项目 memory）：
同一时间只能有一个客户端绑定 UDP 4730 端口，探针不直接调 SDK，
改为检查 marvin 进程存活 + UDP 4730 端口监听状态。
"""
from __future__ import annotations

import subprocess

from _probe_protocol import main


def describe() -> dict:
    return {
        "device_type": "arm",
        "metrics": ["arm_status", "drag_mode", "host_status", "limit_exceeded_count"],
        "check_items": ["arm_online", "arm_no_limit_exceeded"],
    }


def _marvin_running() -> bool:
    """检查 marvin 进程是否存活。"""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "marvin"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except FileNotFoundError:
        # pgrep 不存在时用 ps
        try:
            result = subprocess.run(
                ["ps", "aux"], capture_output=True, text=True, timeout=5, check=False,
            )
            return "marvin" in result.stdout.lower()
        except Exception:
            return False
    except Exception:
        return False


def _udp_4730_listening() -> bool:
    """检查 UDP 4730 端口是否被监听（机械臂 SDK 绑定端口）。"""
    try:
        # 用 ss 命令检查 UDP 端口
        result = subprocess.run(
            ["ss", "-lun"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if result.returncode == 0:
            return ":4730 " in result.stdout or ":4730\n" in result.stdout
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # 退化为用 netstat
    try:
        result = subprocess.run(
            ["netstat", "-lun"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return result.returncode == 0 and ":4730" in result.stdout
    except Exception:
        return False


def collect() -> dict:
    marvin_ok = _marvin_running()
    port_ok = _udp_4730_listening()
    # 进程存活 + 端口监听 = 在线
    arm_online = marvin_ok and port_ok
    return {
        "status": "ok" if arm_online else "fail",
        "metrics": {
            "arm_status": 1 if arm_online else 0,
            "drag_mode": 0,  # 拖拽模式需要 SDK 调用，探针不抢占端口
            "host_status": 1 if marvin_ok else 0,
            "limit_exceeded_count": 0,  # 超限事件需要 SDK，探针不抢占端口
        },
    }


def check(item_id: str) -> dict:
    if item_id == "arm_online":
        marvin_ok = _marvin_running()
        port_ok = _udp_4730_listening()
        arm_online = marvin_ok and port_ok
        evidence = {
            "marvin_process": marvin_ok,
            "udp_4730_listening": port_ok,
            "note": "探针不直接调 SDK（端口独占问题），改查进程+端口",
        }
        if arm_online:
            return {"result": "pass", "evidence": evidence, "suggestion": None}
        elif not marvin_ok:
            return {"result": "fail", "evidence": evidence, "suggestion": "机械臂进程未运行，检查 marvin 服务"}
        else:
            return {"result": "fail", "evidence": evidence, "suggestion": "机械臂 UDP 4730 端口未监听，SDK 可能未正常初始化"}
    elif item_id == "arm_no_limit_exceeded":
        # 超限事件需要 SDK 调用，探针不抢占端口，返回 unknown
        return {"result": "unknown", "evidence": {}, "suggestion": "超限检测需 SDK 调用，探针不抢占端口（见 memory 端口独占问题）"}
    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
