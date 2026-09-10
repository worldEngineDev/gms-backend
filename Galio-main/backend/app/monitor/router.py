"""监控与告警接口，对照 docs/api-design.md 「5. 监控与告警」（8 个）。"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.monitor import service
from app.pagination import Pagination, pagination_params

router = APIRouter(tags=["monitor"])


class AlertRuleCreate(BaseModel):
    name: str
    rule_type: str
    severity: str
    config: dict
    scope_device_type: str | None = None
    auto_create_ticket: bool = False
    created_by: str


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    severity: str | None = None
    config: dict | None = None
    enabled: bool | None = None


@router.get("/monitor/stations/health-summary")
def station_health_summary(request: Request, session: Session = Depends(get_session)):
    """状态大盘批量接口：工位、探针状态和各设备最新指标。"""
    return envelope(service.list_station_health(session), request_id=request_id(request))


@router.get("/stations/{station_id}/metrics")
def query_metrics(request: Request, station_id: uuid.UUID, metric_name: str | None = None,
                   start: datetime | None = None, end: datetime | None = None,
                   session: Session = Depends(get_session)):
    rows = service.query_metrics(session, station_id, metric_name, start, end)
    return envelope(rows, request_id=request_id(request))


@router.get("/stations/by-code/{code}/latest-metrics")
def latest_metrics_by_code(request: Request, code: str,
                           session: Session = Depends(get_session)):
    """按工位编号（如 we-105）查最新一批指标+探针状态，给 GMS 移动端用。

    返回 {metrics: {name: value}, probes: {probe: {status, last_checked}}}
    """
    from sqlalchemy import text
    from app.people_assets.models import Station
    from app.monitor.models import StationSnapshot

    row = session.exec(
        Station.__table__.select().where(Station.code == code)
    ).first()
    if row is None:
        raise ApiError(40401, f"station {code} not found", 404)

    # 每个指标取最新一条
    sql = text("""
        SELECT DISTINCT ON (metric_name) metric_name, metric_value, recorded_at
        FROM metric
        WHERE station_id = :sid
        ORDER BY metric_name, recorded_at DESC
        LIMIT 100
    """)
    rows = session.execute(sql, {"sid": str(row.id)}).all()
    metrics = {r[0]: r[1] for r in rows}

    # 探针状态从 station_snapshot.health 取
    snapshot = session.get(StationSnapshot, row.id)
    probes = dict(snapshot.health) if snapshot and snapshot.health else {}

    return envelope({"metrics": metrics, "probes": probes},
                    request_id=request_id(request))


@router.get("/alert-rules")
def list_alert_rules(request: Request, pagination: Pagination = Depends(pagination_params),
                      session: Session = Depends(get_session)):
    rows, total = service.list_alert_rules(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/alert-rules")
def create_alert_rule(request: Request, body: AlertRuleCreate, session: Session = Depends(get_session)):
    rule = service.create_alert_rule(session, **body.model_dump())
    return envelope(rule, request_id=request_id(request))


@router.patch("/alert-rules/{rule_id}")
def update_alert_rule(request: Request, rule_id: uuid.UUID, body: AlertRuleUpdate,
                       session: Session = Depends(get_session)):
    rule = service.update_alert_rule(session, rule_id, **body.model_dump())
    if rule is None:
        raise ApiError(40401, "alert rule not found", 404)
    return envelope(rule, request_id=request_id(request))


@router.delete("/alert-rules/{rule_id}")
def delete_alert_rule(request: Request, rule_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_alert_rule(session, rule_id):
        raise ApiError(40401, "alert rule not found", 404)
    return envelope(None, request_id=request_id(request))


@router.get("/alert-events")
def list_alert_events(request: Request, status: str | None = None, severity: str | None = None,
                       pagination: Pagination = Depends(pagination_params),
                       session: Session = Depends(get_session)):
    rows, total = service.list_alert_events(session, pagination, status=status, severity=severity)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/alert-events/{event_id}/ack")
def ack_alert_event(request: Request, event_id: uuid.UUID, session: Session = Depends(get_session)):
    event = service.ack_alert_event(session, event_id)
    if event is None:
        raise ApiError(40401, "alert event not found", 404)
    return envelope(event, request_id=request_id(request))


@router.post("/alert-events/{event_id}/resolve")
def resolve_alert_event(request: Request, event_id: uuid.UUID, session: Session = Depends(get_session)):
    event = service.resolve_alert_event(session, event_id)
    if event is None:
        raise ApiError(40401, "alert event not found", 404)
    return envelope(event, request_id=request_id(request))
