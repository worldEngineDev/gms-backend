"""对照 docs/database-schema.md notification 表：claim pending 通知，按 channel 投递。

channel 分派：
  - feishu_group: 群机器人 Webhook（运维通知群）
  - feishu_dm: OpenAPI 单聊卡片
  - feishu_urgent_call: 加急电话
  - feishu_urgent_sms: 已停用（兼容旧数据，不会发送）
  - web: 站内消息（写回 notification.payload，前端轮询/拉取）
  - kiosk: 工位弹窗（通过 Webhook 推送到工位 kiosk 前端）
"""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from sqlmodel import Session, select

from app.jobs.models import Job
from app.notify_audit.feishu_client import (
    send_dm,
    send_group_webhook,
    send_urgent_call,
)
from app.notify_audit.models import Notification

logger = logging.getLogger("galio.worker.notification_dispatch")


async def run(job: Job, session: Session) -> None:
    _ = job
    # 用 SKIP LOCKED 领取 pending 通知，避免多 Worker 重复投递
    pending = session.exec(
        select(Notification)
        .where(Notification.status == "pending")
        .order_by(Notification.priority, Notification.created_at)
        .with_for_update(skip_locked=True)
        .limit(50)
    ).all()

    if not pending:
        return

    for notification in pending:
        notification.status = "sending"
        notification.claimed_at = datetime.now(UTC)
        session.add(notification)
    session.commit()

    for notification in pending:
        try:
            await _deliver(notification)
            notification.status = "sent"
            notification.sent_at = datetime.now(UTC)
        except Exception as exc:
            logger.exception("notification %s delivery failed", notification.id)
            notification.status = "failed"
            notification.attempt_count += 1
            notification.last_error = str(exc)[:500]
        session.add(notification)
    session.commit()


async def _deliver(notification: Notification) -> None:
    """按 channel 分派到飞书/web/kiosk。"""
    channel = notification.channel
    payload = notification.payload or {}

    if channel == "feishu_group":
        await _deliver_feishu_group(notification, payload)
    elif channel == "feishu_dm":
        await _deliver_feishu_dm(notification, payload)
    elif channel == "feishu_urgent_call":
        await _deliver_feishu_urgent(notification, payload, mode="call")
    elif channel == "feishu_urgent_sms":
        raise ValueError("feishu_urgent_sms 已停用，请使用 feishu_group、feishu_dm 或 feishu_urgent_call")
    elif channel == "web":
        # 站内消息：不改 payload，只标记 sent——前端轮询 notification 表拉取未读
        pass
    elif channel == "kiosk":
        # 工位弹窗：通过群机器人 Webhook 推送到工位群（工位 kiosk 前端监听群消息）
        await _deliver_feishu_group(notification, payload)
    else:
        raise ValueError(f"unknown channel: {channel}")


async def _deliver_feishu_group(notification: Notification, payload: dict) -> None:
    """群机器人 Webhook 投递。

    payload 约定：
      {"text": "..."} → 纯文本消息
      {"card": {...}} → 交互卡片
    """
    if "card" in payload:
        message = {"msg_type": "interactive", "card": payload["card"]}
    else:
        text = payload.get("text", _format_default_text(notification))
        message = {"msg_type": "text", "content": {"text": text}}

    ok = await send_group_webhook(message)
    if not ok:
        raise RuntimeError("群消息投递失败")


async def _deliver_feishu_dm(notification: Notification, payload: dict) -> None:
    """单聊卡片投递。

    payload 约定：
      {"user_id": "ou_xxx", "card": {...}} 或 {"user_id": "ou_xxx", "text": "..."}
    """
    user_id = payload.get("user_id") or notification.target
    if not user_id:
        raise ValueError("feishu_dm 需要 payload.user_id 或 notification.target")

    if "card" in payload:
        content = json.dumps(payload["card"])
        message = {"msg_type": "interactive", "content": content}
    else:
        text = payload.get("text", _format_default_text(notification))
        message = {"msg_type": "text", "content": json.dumps({"text": text})}

    ok = await send_dm(user_id, message)
    if not ok:
        raise RuntimeError("单聊消息投递失败")


async def _deliver_feishu_urgent(notification: Notification, payload: dict, *, mode: str) -> None:
    """飞书电话加急投递。

    payload 约定：
      {"user_id": "ou_xxx", "text": "...", "phone": "1xxx"}（phone 为备选，优先 user_id）
    """
    user_id = payload.get("user_id") or notification.target
    phone = payload.get("phone")
    text = payload.get("text", _format_default_text(notification))

    ok = await send_urgent_call(phone, user_id, text)
    if not ok:
        raise RuntimeError(f"加急{mode}投递失败")


def _format_default_text(notification: Notification) -> str:
    """没有显式 text 时，用 notification.template + payload 生成简洁消息。

    告警消息保持简洁（用户偏好）：只含核心信息，区分左右设备。
    """
    template = notification.template
    payload = notification.payload or {}

    # 告警事件格式：区分左右设备（用户偏好）
    if template == "alert":
        station = payload.get("station_name", "")
        device = payload.get("device_name", "")
        severity = payload.get("severity", "")
        detail = payload.get("detail", {})
        # 设备名区分左右（如"设备手套L"而非"设备手套"）
        metric = detail.get("metric_name", "")
        value = detail.get("metric_value", "")
        threshold = detail.get("threshold", "")
        return f"[{severity}] {station} {device} {metric}={value} (阈值{threshold})"
    elif template == "ticket":
        station = payload.get("station_name", "")
        fault = payload.get("fault_type", "")
        return f"[报修] {station} {fault}"
    elif template == "release":
        action = payload.get("action", "")
        version = payload.get("version", "")
        return f"[发布] {action} 版本{version}"
    else:
        return f"[{template}] {json.dumps(payload, ensure_ascii=False)[:200]}"
