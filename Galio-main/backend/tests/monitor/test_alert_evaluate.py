"""告警评估引擎的纯函数单元测试——不依赖数据库。

只测 _compare 和 _resolve_device_for_metric 等纯函数。
完整评估流程需要真实 PG（用到 advisory lock / 部分唯一索引），留到集成测试。
"""
from __future__ import annotations

import uuid

from app.jobs.handlers.alert_evaluate import _compare, _resolve_device_for_metric


def test_compare_greater_than() -> None:
    assert _compare(95.0, ">", 90.0) is True
    assert _compare(85.0, ">", 90.0) is False
    assert _compare(90.0, ">", 90.0) is False


def test_compare_less_than() -> None:
    assert _compare(10.0, "<", 20.0) is True
    assert _compare(30.0, "<", 20.0) is False


def test_compare_greater_equal() -> None:
    assert _compare(90.0, ">=", 90.0) is True
    assert _compare(91.0, ">=", 90.0) is True
    assert _compare(89.0, ">=", 90.0) is False


def test_compare_less_equal() -> None:
    assert _compare(90.0, "<=", 90.0) is True
    assert _compare(89.0, "<=", 90.0) is True
    assert _compare(91.0, "<=", 90.0) is False


def test_compare_equal() -> None:
    assert _compare(90.0, "==", 90.0) is True
    assert _compare(91.0, "==", 90.0) is False


def test_compare_unknown_operator() -> None:
    assert _compare(90.0, "!=", 90.0) is False


def test_resolve_device_for_metric_with_id() -> None:
    dev_uuid = str(uuid.uuid4())
    result = _resolve_device_for_metric(dev_uuid)
    assert result == uuid.UUID(dev_uuid)


def test_resolve_device_for_metric_none() -> None:
    assert _resolve_device_for_metric(None) is None
    assert _resolve_device_for_metric("") is None
