"""认证与当前用户接口，对照 docs/api-design.md 「9. 认证与当前用户（占位）」（3 个）。

见待定问题 A2：如果实际走公司统一 SSO/网关鉴权，这 3 个接口可能不需要 Galio 自己实现。
先把路由占位搭出来，返回 501，等认证方式定下来再实现，不在这里猜测飞书登录的具体交互细节。
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.envelope import ApiError

router = APIRouter(tags=["auth"], prefix="/auth")

_AUTH_UNDECIDED = "认证方式未最终确认，见 docs/api-design.md 待定问题 A2"


class FeishuLoginRequest(BaseModel):
    code: str  # 飞书 OAuth 回调 code


@router.post("/feishu-login")
def feishu_login(request: Request, body: FeishuLoginRequest):
    raise ApiError(50001, _AUTH_UNDECIDED, 501)


@router.get("/me")
def me(request: Request):
    raise ApiError(50001, _AUTH_UNDECIDED, 501)


@router.post("/logout")
def logout(request: Request):
    raise ApiError(50001, _AUTH_UNDECIDED, 501)
