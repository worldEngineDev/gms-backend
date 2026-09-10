#!/usr/bin/env python3
"""数据手套探针：在线状态、线束瞬断计数。

用 wuji_sdk scan() 扫描 Zenoh 网络，过滤无实际 IP 的 zenoh:// 设备（见项目 memory）。
手套 SN 格式：WG1JA...=左手, WG1KA...=右手（J=左, K=右，见项目 memory 规则）。
"""
from __future__ import annotations

import time

from _probe_protocol import main


def describe() -> dict:
    return {
        "device_type": "glove",
        "metrics": ["glove_online", "glove_l_online", "glove_r_online", "glove_l_tactile", "glove_r_tactile", "glove_l_emf_poses", "glove_r_emf_poses", "cable_dropout_count", "sdk_error_count"],
        "check_items": ["glove_online", "glove_l_online", "glove_r_online"],
    }


def _scan_gloves() -> list[dict]:
    """用 wuji SDK 扫描手套设备，过滤无 IP 的 zenoh:// 设备。

    只保留 DeviceType.WujiGlove 的设备，排除灵巧手和 Unknown 类型。
    返回 [{"sn": "...", "address": "...", "side": "L|R"}] 列表。
    wuji_sdk 未安装时返回空列表。
    """
    try:
        from wuji_sdk import SdkManager, DeviceType  # noqa: PLC0415
    except ImportError:
        return []

    results = []
    try:
        m = SdkManager.instance()
        devs = m.scan()
        for d in devs:
            addr = str(d.address) if hasattr(d, "address") else ""
            sn = str(d.sn) if hasattr(d, "sn") else ""
            if d.device_type != DeviceType.WujiGlove and not sn.upper().startswith("WG1"):
                continue
            # 手套 SN 格式 WG1JA...=左, WG1KA...=右（第 4 位 J/K）
            side = _sn_to_side(sn)
            row = {"sn": sn, "address": addr, "side": side, "connected": False, "tactile": False, "emf_poses": False, "error": None}
            try:
                glove = m.connect(sn=sn, device_name=f"probe_{sn[-4:]}")
                connected = getattr(glove, "is_connected", True)
                row["connected"] = bool(connected() if callable(connected) else connected)
                for stream_name in ("tactile", "emf_poses"):
                    sub = getattr(glove, stream_name)().subscribe()
                    try:
                        deadline = time.monotonic() + 2
                        while time.monotonic() < deadline:
                            if sub.recv() is not None:
                                row[stream_name] = True
                                break
                            time.sleep(0.02)
                    finally:
                        sub.close()
                if not row["tactile"] and not row["emf_poses"]:
                    row["error"] = "数据流无帧"
            except Exception as exc:
                row["error"] = str(exc)[:160]
            results.append(row)
        m.disconnect_all()
    except Exception:
        pass
    return results


def _sn_to_side(sn: str) -> str | None:
    """从 SN 判断左右手。

    SN 格式：WG1JA...=左手, WG1KA...=右手（第 4 位 J/K 区分左右）。
    """
    sn = sn.upper()
    if len(sn) >= 4:
        if sn[3] == "J":
            return "L"
        if sn[3] == "K":
            return "R"
    return None


def collect() -> dict:
    gloves = _scan_gloves()
    if not gloves:
        return {"status": "unknown", "metrics": {}}
    l_online = any(g["side"] == "L" and g.get("connected") and (g.get("tactile") or g.get("emf_poses")) for g in gloves)
    r_online = any(g["side"] == "R" and g.get("connected") and (g.get("tactile") or g.get("emf_poses")) for g in gloves)
    all_online = l_online and r_online
    any_online = l_online or r_online
    return {
        "status": "ok" if all_online else "degraded" if any_online else "fail",
        "metrics": {
            "glove_online": 1 if all_online else 0,
            "glove_l_online": 1 if l_online else 0,
            "glove_r_online": 1 if r_online else 0,
            "glove_l_tactile": 1 if any(g["side"] == "L" and g.get("tactile") for g in gloves) else 0,
            "glove_r_tactile": 1 if any(g["side"] == "R" and g.get("tactile") for g in gloves) else 0,
            "glove_l_emf_poses": 1 if any(g["side"] == "L" and g.get("emf_poses") for g in gloves) else 0,
            "glove_r_emf_poses": 1 if any(g["side"] == "R" and g.get("emf_poses") for g in gloves) else 0,
            "cable_dropout_count": sum(1 for g in gloves if g.get("connected") and not (g.get("tactile") or g.get("emf_poses"))),
            "sdk_error_count": sum(1 for g in gloves if g.get("error")),
        },
    }


def check(item_id: str) -> dict:
    if item_id in {"glove_online", "glove_l_online", "glove_r_online"}:
        gloves = _scan_gloves()
        if not gloves:
            return {"result": "unknown", "evidence": {}, "suggestion": "wuji_sdk 未安装或扫描无结果"}
        online = {
            "L": any(g["side"] == "L" and g.get("connected") and (g.get("tactile") or g.get("emf_poses") ) for g in gloves),
            "R": any(g["side"] == "R" and g.get("connected") and (g.get("tactile") or g.get("emf_poses") ) for g in gloves),
        }
        if item_id == "glove_l_online":
            side = "L"
        elif item_id == "glove_r_online":
            side = "R"
        else:
            side = None
        if side:
            return {
                "result": "pass" if online[side] else "fail",
                "evidence": {"gloves": gloves, "online": online},
                "suggestion": None if online[side] else f"设备手套{side}未连接或数据流中断",
            }
        if online["L"] and online["R"]:
            return {"result": "pass", "evidence": {"gloves": gloves, "online": online}, "suggestion": None}
        missing = "L" if not online["L"] else "R"
        return {
            "result": "fail",
            "evidence": {"gloves": gloves, "online": online},
            "suggestion": f"设备手套{missing}未连接或数据流中断",
        }
    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
