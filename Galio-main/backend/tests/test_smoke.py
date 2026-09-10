"""冒烟测试：app 能正常装配、OpenAPI 能生成——不需要数据库连接。"""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_healthz(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_openapi_has_routes(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    paths = schema["paths"]
    # 对照 docs/api-design.md 的路由数量做一个粗略的回归信号，不追求精确匹配。
    assert len(paths) >= 40
