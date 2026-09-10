#!/usr/bin/env python3
"""服务/进程探针：采集相关服务运行状态、启动阶段上报。

用 systemctl 检查关键服务状态。启动阶段判断用"超时阈值 + 历史启动时长基线"。
"""
from __future__ import annotations

import subprocess

from _probe_protocol import main


# 工位上需要监控的关键服务列表（见 docs/architecture.md「启动慢 vs 坏的区分」）
MONITORED_SERVICES = [
    "marvinedge",    # 机械臂心跳代理
    "gello-importer",  # 数据采集导入器
    "node_exporter", # 主机指标采集
    "docker",        # 容器运行时
]


def describe() -> dict:
    return {
        "device_type": "svc",
        "metrics": ["service_status", "startup_phase"],
        "check_items": ["svc_running"],
    }


def _systemctl_status(service: str) -> str:
    """用 systemctl 检查服务状态。返回 active|inactive|failed|unknown。"""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5, check=False,
        )
        status = result.stdout.strip()
        # systemctl is-active 返回: active|inactive|failed|activating|unknown
        return status if status in ("active", "inactive", "failed", "activating", "unknown") else "unknown"
    except FileNotFoundError:
        return "unknown"
    except Exception:
        return "unknown"


def _systemctl_active_since(service: str) -> str | None:
    """获取服务上次启动时间（用于判断是否在启动阶段）。保留给后续启动阶段判断扩展。"""
    try:
        result = subprocess.run(
            ["systemctl", "show", service, "--property=ActiveEnterTimestamp"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip().split("=")[1] if "=" in result.stdout else None
    except Exception:
        pass
    return None


def collect() -> dict:
    statuses = {svc: _systemctl_status(svc) for svc in MONITORED_SERVICES}
    all_active = all(s == "active" for s in statuses.values()) if statuses else False
    any_activating = any(s == "activating" for s in statuses.values())

    if any_activating:
        phase = "starting"
    elif all_active:
        phase = "ready"
    else:
        phase = "failed"

    return {
        "status": "ok" if all_active else ("fail" if any(s == "failed" for s in statuses.values()) else "unknown"),
        "metrics": {
            "service_status": 1 if all_active else 0,
            "startup_phase": {"starting": 0, "ready": 1, "failed": -1, "unknown": -2}.get(phase, -2),
        },
    }


def check(item_id: str) -> dict:
    if item_id == "svc_running":
        statuses = {svc: _systemctl_status(svc) for svc in MONITORED_SERVICES}
        all_active = all(s == "active" for s in statuses.values()) if statuses else False
        if all_active:
            return {"result": "pass", "evidence": {"services": statuses}, "suggestion": None}
        # 区分启动中和失败
        failed = [svc for svc, s in statuses.items() if s == "failed"]
        starting = [svc for svc, s in statuses.items() if s == "activating"]
        inactive = [svc for svc, s in statuses.items() if s == "inactive"]
        if failed:
            return {"result": "fail", "evidence": {"services": statuses, "failed": failed},
                    "suggestion": f"服务启动失败: {failed}"}
        elif starting:
            return {"result": "fail", "evidence": {"services": statuses, "starting": starting},
                    "suggestion": f"服务启动中: {starting}"}
        else:
            return {"result": "fail", "evidence": {"services": statuses, "inactive": inactive},
                    "suggestion": f"服务未运行: {inactive}"}
    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
