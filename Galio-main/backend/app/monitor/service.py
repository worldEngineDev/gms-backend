"""监控与告警的查询/写入逻辑。对照 docs/api-design.md 「5. 监控与告警」。"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import bindparam, text
from sqlmodel import Session, select

from app.monitor.models import AlertEvent, AlertRule, Metric, StationSnapshot
from app.pagination import Pagination
from app.people_assets.models import Station


def query_metrics(session: Session, station_id: uuid.UUID, metric_name: str | None,
                   start: datetime | None, end: datetime | None, limit: int = 500) -> list[Metric]:
    statement = select(Metric).where(Metric.station_id == station_id)
    if metric_name:
        statement = statement.where(Metric.metric_name == metric_name)
    if start:
        statement = statement.where(Metric.recorded_at >= start)
    if end:
        statement = statement.where(Metric.recorded_at <= end)
    statement = statement.order_by(Metric.recorded_at.desc()).limit(limit)
    return session.exec(statement).all()


def list_station_health(session: Session, limit: int = 500) -> list[dict]:
    """返回状态大盘所需的工位、探针和每个指标的最新值。

    采用 DISTINCT ON 将每个工位/指标压缩为一条，避免前端为每个工位
    发起 N+1 次 latest-metrics 请求。
    """
    stations = session.exec(
        select(Station)
        .where(Station.deleted_at.is_(None))
        .order_by(Station.code)
        .limit(limit)
    ).all()
    if not stations:
        return []

    station_ids = [station.id for station in stations]
    station_keys = [str(station_id) for station_id in station_ids]
    latest_metrics: dict[str, dict[str, float]] = {station_id: {} for station_id in station_keys}
    latest_at: dict[str, str | None] = {station_id: None for station_id in station_keys}

    statement = text(
        """
        SELECT DISTINCT ON (station_id, metric_name)
               station_id, metric_name, metric_value, recorded_at
        FROM metric
        WHERE station_id IN :station_ids
        ORDER BY station_id, metric_name, recorded_at DESC
        """
    ).bindparams(bindparam("station_ids", expanding=True))
    for row in session.execute(statement, {"station_ids": station_ids}).all():
        station_id = str(row[0])
        latest_metrics.setdefault(station_id, {})[row[1]] = float(row[2])
        if latest_at.get(station_id) is None and row[3] is not None:
            latest_at[station_id] = row[3].isoformat()

    result = []
    for station in stations:
        station_id = str(station.id)
        snapshot = session.get(StationSnapshot, station.id)
        health = dict(snapshot.health or {}) if snapshot else {}
        snapshot_status = snapshot.status if snapshot else "unknown"
        if snapshot and snapshot.last_poll_status == "unreachable":
            status = "offline"
        elif any(
            isinstance(value, dict) and value.get("status") in {"fail", "error", "degraded"}
            for value in health.values()
        ):
            status = "degraded"
        elif snapshot_status in {"online", "degraded", "offline"}:
            status = snapshot_status
        else:
            status = "unknown"
        result.append(
            {
                "id": station.id,
                "code": station.code,
                "name": station.name,
                "status": status,
                "station_status": station.status,
                "snapshot": {
                    "status": snapshot_status,
                    "last_poll_status": snapshot.last_poll_status if snapshot else None,
                    "last_polled_at": snapshot.last_polled_at if snapshot else None,
                    "updated_at": snapshot.updated_at if snapshot else None,
                },
                "metrics": latest_metrics.get(station_id, {}),
                "latest_metric_at": latest_at.get(station_id),
                "probes": health,
            }
        )
    return result


def list_alert_rules(session: Session, pagination: Pagination) -> tuple[list[AlertRule], int]:
    statement = select(AlertRule).where(AlertRule.deleted_at.is_(None))
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_alert_rule(session: Session, *, name: str, rule_type: str, severity: str, config: dict,
                       created_by: str, scope_device_type: str | None = None,
                       auto_create_ticket: bool = False) -> AlertRule:
    rule = AlertRule(
        name=name, rule_type=rule_type, severity=severity, config=config,
        scope_device_type=scope_device_type, auto_create_ticket=auto_create_ticket, created_by=created_by,
    )
    session.add(rule)
    session.commit()
    session.refresh(rule)
    return rule


def update_alert_rule(session: Session, rule_id: uuid.UUID, **fields) -> AlertRule | None:
    rule = session.get(AlertRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(rule, key, value)
    session.add(rule)
    session.commit()
    session.refresh(rule)
    return rule


def delete_alert_rule(session: Session, rule_id: uuid.UUID) -> bool:
    rule = session.get(AlertRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        return False
    rule.deleted_at = datetime.now(UTC)
    session.add(rule)
    session.commit()
    return True


def list_alert_events(session: Session, pagination: Pagination, status: str | None = None,
                       severity: str | None = None) -> tuple[list[AlertEvent], int]:
    statement = select(AlertEvent).where(AlertEvent.deleted_at.is_(None)).order_by(AlertEvent.opened_at.desc())
    if status:
        statement = statement.where(AlertEvent.status == status)
    if severity:
        statement = statement.where(AlertEvent.severity == severity)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def ack_alert_event(session: Session, event_id: uuid.UUID) -> AlertEvent | None:
    event = session.get(AlertEvent, event_id)
    if event is None or event.deleted_at is not None:
        return None
    event.status = "acked"
    session.add(event)
    session.commit()
    session.refresh(event)
    return event


def resolve_alert_event(session: Session, event_id: uuid.UUID) -> AlertEvent | None:
    event = session.get(AlertEvent, event_id)
    if event is None or event.deleted_at is not None:
        return None
    event.status = "resolved"
    event.resolved_at = datetime.now(UTC)
    session.add(event)
    session.commit()
    session.refresh(event)
    return event
