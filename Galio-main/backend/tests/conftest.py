"""pytest fixtures 供各模块测试复用。

DB 相关的测试需要一个真实 PostgreSQL（用到 JSONB/ARRAY/advisory lock，SQLite 顶不了），
测试数据库的搭建方式（testcontainers？CI 里起一个 postgres service？）还没定，
这里先只给不依赖 DB 的 TestClient fixture。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main_api import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)
