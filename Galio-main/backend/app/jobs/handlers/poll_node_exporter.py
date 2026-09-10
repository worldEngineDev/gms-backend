"""高频循环：HTTP 抓取各工位 node_exporter /metrics，写入 metric 表 + station_snapshot。

见 docs/architecture.md「主机基础指标：复用已预装的 node_exporter」。由 main_worker 的独立
asyncio 循环调用（不经 job 表——这条路径要的是高频、低开销，不需要 SKIP LOCKED 排队）。
"""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
from sqlmodel import select

from app.db import new_session
from app.monitor.models import Metric, StationSnapshot
from app.monitor.node_exporter_parser import derive_simple_metrics, parse
from app.people_assets.models import Station
from app.settings import settings


async def run() -> None:
    with new_session() as session:
        stations = session.exec(
            select(Station).where(Station.deleted_at.is_(None), Station.host.is_not(None))
        ).all()

    async with httpx.AsyncClient(timeout=5.0) as client:
        for station in stations:
            await _poll_one(client, station)


async def _poll_one(client: httpx.AsyncClient, station: Station) -> None:
    url = f"http://{station.host}:{settings.node_exporter_port}/metrics"
    now = datetime.now(UTC)
    with new_session() as session:
        snapshot = session.get(StationSnapshot, station.id) or StationSnapshot(station_id=station.id)
        try:
            response = await client.get(url)
            response.raise_for_status()
            derived = _parse_and_derive(response.text)
            _persist_metrics(session, station.id, derived, now)
            snapshot.last_polled_at = now
            snapshot.last_poll_status = "ok"
            snapshot.last_poll_error = None
            snapshot.status = "online"
            snapshot.health = {**snapshot.health, **derived}
            snapshot.updated_at = now
        except httpx.HTTPError as exc:
            snapshot.last_poll_status = "unreachable"
            snapshot.last_poll_error = str(exc)
            # 连续失败次数达到阈值时才改 status，避免抖动
            snapshot.status = _decide_offline_status(session, station.id, now)
            snapshot.updated_at = now
        session.add(snapshot)
        session.commit()


def _parse_and_derive(text: str) -> dict[str, float]:
    """解析 Prometheus 文本并派生平台统一指标名。"""
    parsed = parse(text)
    return derive_simple_metrics(parsed)


def _persist_metrics(session, station_id, derived: dict[str, float], now: datetime) -> None:
    """把派生后的标量指标逐行写入 metric 表。

    metric 表是按 recorded_at 分区的追加表，不设唯一索引——重复写入是允许的，
    worker 重启/重试不会冲突，只是多一行事实，告警评估取最新值即可。
    """
    for name, value in derived.items():
        session.add(Metric(
            station_id=station_id,
            device_id=None,  # 主机级指标不绑定具体设备
            metric_name=name,
            metric_value=value,
            recorded_at=now,
        ))


def _decide_offline_status(session, station_id, now: datetime) -> str:
    """按 settings.offline_after_consecutive_failures 判定是否离线。

    连续失败次数 = 最近 N 次 station_snapshot.last_poll_status != 'ok' 的记录数。
    但 station_snapshot 是 UPSERT 单行表，不保留历史——这里取最近 metric 记录的连续缺失来估计，
    更直白的做法：直接看 last_polled_at 距今有多少个轮次没抓到。
    """
    threshold_seconds = settings.offline_after_consecutive_failures * settings.node_exporter_poll_seconds
    snapshot = session.get(StationSnapshot, station_id)
    if snapshot is None or snapshot.last_polled_at is None:
        return "offline"
    elapsed = (now - snapshot.last_polled_at).total_seconds()
    return "offline" if elapsed >= threshold_seconds else (snapshot.status or "offline")
