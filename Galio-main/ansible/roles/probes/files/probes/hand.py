#!/usr/bin/env python3
"""灵巧手探针：在线状态、SDK 报错日志流、关节诊断。

用 wuji_sdk scan() 扫描 Zenoh 网络，过滤无实际 IP 的 zenoh:// 设备。
灵巧手 SN 格式：WH2JA...=左手, WH2KA...=右手（J=左, K=右，见项目 memory 规则）。
"""
from __future__ import annotations

from _probe_protocol import main


def describe() -> dict:
    return {
        "device_type": "hand",
        "metrics": ["hand_status", "hand_l_online", "hand_r_online", "hand_l_joints", "hand_r_joints", "sdk_error_count"],
        "check_items": ["hand_online", "hand_l_online", "hand_r_online"],
    }


def _scan_hands() -> list[dict]:
    """用 wuji SDK 扫描灵巧手设备。

    只保留 DeviceType.WujiHand2 的设备，排除手套和 Unknown 类型。
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
            if d.device_type not in (DeviceType.WujiHand2, DeviceType.WujiHand) and not sn.upper().startswith("WH"):
                continue
            # 灵巧手 SN 格式 WH2JA...=左, WH2KA...=右（第 4 位 J/K）
            side = _sn_to_side(sn)
            row = {"sn": sn, "address": addr, "side": side, "connected": False, "online_joints": 0, "error": None}
            try:
                hand = m.connect(sn=sn, device_name=f"probe_{sn[-4:]}")
                online = hand.online_joints_count().get()
                row["online_joints"] = int(online or 0)
                row["connected"] = row["online_joints"] > 0
            except Exception as exc:
                row["error"] = str(exc)[:160]
            results.append(row)
        m.disconnect_all()
    except Exception:
        pass
    return results


def _sn_to_side(sn: str) -> str | None:
    """从 SN 判断左右手。

    SN 格式：WH2JA...=左手, WH2KA...=右手（第 4 位 J/K 区分左右）。
    """
    if len(sn) >= 4:
        if sn[3] == "J":
            return "L"
        if sn[3] == "K":
            return "R"
    return None


def collect() -> dict:
    hands = _scan_hands()
    if not hands:
        return {"status": "unknown", "metrics": {}}
    l_online = any(h["side"] == "L" and h.get("connected") for h in hands)
    r_online = any(h["side"] == "R" and h.get("connected") for h in hands)
    all_online = l_online and r_online
    any_online = l_online or r_online
    return {
        "status": "ok" if all_online else "degraded" if any_online else "fail",
        "metrics": {
            "hand_status": 1 if all_online else 0,
            "hand_l_online": 1 if l_online else 0,
            "hand_r_online": 1 if r_online else 0,
            "hand_l_joints": max((h.get("online_joints", 0) for h in hands if h.get("side") == "L"), default=0),
            "hand_r_joints": max((h.get("online_joints", 0) for h in hands if h.get("side") == "R"), default=0),
            "sdk_error_count": sum(1 for h in hands if h.get("error")),
        },
    }


def check(item_id: str) -> dict:
    if item_id in {"hand_online", "hand_l_online", "hand_r_online"}:
        hands = _scan_hands()
        if not hands:
            return {"result": "unknown", "evidence": {}, "suggestion": "wuji_sdk 未安装或扫描无结果"}
        online = {
            "L": any(h["side"] == "L" and h.get("connected") and h.get("online_joints", 0) > 0 for h in hands),
            "R": any(h["side"] == "R" and h.get("connected") and h.get("online_joints", 0) > 0 for h in hands),
        }
        if item_id == "hand_l_online":
            side = "L"
        elif item_id == "hand_r_online":
            side = "R"
        else:
            side = None
        if side:
            return {
                "result": "pass" if online[side] else "fail",
                "evidence": {"hands": hands, "online": online},
                "suggestion": None if online[side] else f"设备灵巧手{side}未连接或无在线关节",
            }
        l, r = online["L"], online["R"]
        if l and r:
            return {"result": "pass", "evidence": {"hands": hands, "online": online}, "suggestion": None}
        elif not l:
            return {"result": "fail", "evidence": {"hands": hands, "online": online},
                    "suggestion": "设备灵巧手L未连接或无在线关节"}
        elif not r:
            return {"result": "fail", "evidence": {"hands": hands, "online": online},
                    "suggestion": "设备灵巧手R未连接或无在线关节"}
        else:
            return {"result": "fail", "evidence": {"hands": hands, "online": online},
                    "suggestion": "灵巧手未检测到"}
    return {"result": "unknown", "evidence": {}, "suggestion": f"未知 check item: {item_id}"}


if __name__ == "__main__":
    main(describe, collect, check)
