"""认证依赖占位：当前用户注入、角色校验。见 docs/api-design.md 待定问题 A2（认证方式未最终确认）。

其他模块的 router 目前都没有接入这个依赖——先把接口形状搭出来，鉴权方式定下来之后
（自建飞书登录，还是走公司统一 SSO/网关）再决定要不要在各业务 router 上挂
`Depends(get_current_person)`，现在挂上去只会是猜测出来的假约束。
"""
from __future__ import annotations

from fastapi import Request

from app.envelope import ApiError

_AUTH_UNDECIDED = "认证方式未最终确认，见 docs/api-design.md 待定问题 A2"


def get_current_person(request: Request):
    raise ApiError(50001, _AUTH_UNDECIDED, 501)
