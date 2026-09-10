"""飞书开放平台客户端：tenant_access_token 缓存 + 群机器人 Webhook + 单聊/加急。

参考现有 GMS feishu.js 的实现，统一用 httpx 异步调用。
凭据从 settings 读取（复用现有 GMS 的 app_id/app_secret）。
"""
from __future__ import annotations

import logging
import time

import httpx

from app.settings import settings

logger = logging.getLogger("galio.feishu")

# tenant_access_token 缓存（进程内）
_token_cache: str | None = None
_token_expires_at: float = 0


async def get_tenant_token() -> str:
    """获取 tenant_access_token（自动缓存，2h TTL，提前 60s 刷新）。"""
    global _token_cache, _token_expires_at

    if _token_cache and time.time() < _token_expires_at - 60:
        return _token_cache

    if not settings.feishu_app_id or not settings.feishu_app_secret:
        raise RuntimeError("飞书凭据未配置（GALIO_FEISHU_APP_ID / GALIO_FEISHU_APP_SECRET）")

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://{settings.feishu_base_url}/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": settings.feishu_app_id, "app_secret": settings.feishu_app_secret},
        )
        resp.raise_for_status()
        data = resp.json()

    if data.get("code") != 0:
        raise RuntimeError(f"飞书 auth 失败: {data.get('msg')}")

    _token_cache = data["tenant_access_token"]
    _token_expires_at = time.time() + data.get("expire", 7200)
    logger.info("飞书 token 刷新成功，有效期 %ss", data.get("expire"))
    return _token_cache


async def send_group_webhook(message: dict) -> bool:
    """通过群机器人 Webhook 发消息（不需要 tenant_access_token）。

    message 格式见飞书文档：{"msg_type": "text", "content": {"text": "..."}}
    或交互卡片格式。
    """
    if not settings.feishu_group_webhook:
        raise RuntimeError("飞书群机器人 Webhook 未配置（GALIO_FEISHU_GROUP_WEBHOOK）")

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(settings.feishu_group_webhook, json=message)
        resp.raise_for_status()
        data = resp.json()

    if data.get("code") != 0 and data.get("StatusCode") != 0:
        logger.error("飞书群消息发送失败: %s", data)
        return False
    return True


async def send_dm(user_id: str, message: dict) -> bool:
    """通过 OpenAPI 发单聊卡片消息给指定用户。"""
    token = await get_tenant_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://{settings.feishu_base_url}/open-apis/im/v1/messages",
            headers=headers,
            params={"receive_id_type": "open_id"},
            json={
                "receive_id": user_id,
                "msg_type": message.get("msg_type", "interactive"),
                "content": message.get("content", ""),
            },
        )
        resp.raise_for_status()
        data = resp.json()

    if data.get("code") != 0:
        logger.error("飞书单聊发送失败: %s", data)
        return False
    return True


async def send_urgent_call(_phone: str | None, user_id: str | None, message: str) -> bool:
    """通过飞书开放平台给用户发起电话加急。"""
    if not settings.feishu_urgent_enabled:
        logger.warning("飞书加急未启用，跳过: %s", message[:100])
        return False

    token = await get_tenant_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 飞书加急通话 API：对指定用户发起电话加急
    if user_id:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://{settings.feishu_base_url}/open-apis/phone/v1/urgent_call",
                headers=headers,
                json={"user_id": user_id, "message": message},
            )
            resp.raise_for_status()
            data = resp.json()
        return data.get("code") == 0

    return False
