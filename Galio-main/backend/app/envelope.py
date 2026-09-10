"""统一响应信封 {code, message, request_id, data}，见 docs/architecture.md「API 设计约定」。"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    """业务错误：非 0 code，配合 HTTP 状态码使用。"""

    def __init__(self, code: int, message: str, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code


def envelope(data: Any = None, *, code: int = 0, message: str = "ok", request_id: str) -> dict:
    return {"code": code, "message": message, "request_id": request_id, "data": data}


def paginated(items: list, page: int, page_size: int, total: int) -> dict:
    """列表接口的 data 形状：{items, page, page_size, total}。"""
    return {"items": items, "page": page, "page_size": page_size, "total": total}


def request_id(request: Request) -> str:
    """调用方可传 X-Request-ID；不传则生成，响应里回显。作为 FastAPI 依赖在各 router 里复用。"""
    return request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex[:12]}"


def install_error_handlers(app: FastAPI) -> None:
    """把 FastAPI 默认的错误响应也套进统一信封，业务代码里正常 raise ApiError/HTTPException 即可。"""

    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=envelope(None, code=exc.code, message=exc.message, request_id=request_id(request)),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=envelope(
                jsonable_encoder(exc.errors()),
                code=422,
                message="参数校验失败",
                request_id=request_id(request),
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=envelope(None, code=exc.status_code, message=str(exc.detail), request_id=request_id(request)),
        )
