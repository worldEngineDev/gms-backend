"""对照 docs/architecture.md「监控告警服务」：按 alert_rule 评估 metric/station_snapshot，产生/收敛 alert_event。

四种 rule_type：
  - threshold: metric_value 超过/低于阈值（如 CPU > 90%）
  - status_change: station_snapshot.health[device].status 从 ok 变为 fail/error
  - heartbeat_lost: station_snapshot.last_poll_status 连续 N 次 unreachable
  - frame_drop_rate: collect_task.frame_drop_count / 时长 超阈值

去重收敛：uq_alert_event_open(alert_rule_id, station_id, device_id) WHERE status='open'
  → 同一规则+工位+设备的 open 事件唯一，命中时 occurrence_count++，不重复开单。
auto_create_ticket=True 时联动 ticket.service.report_ticket 自动开单。

评估触发：由 main_worker 的 job_loop 调度（alert_evaluate job），也可以被巡检循环手动触发。
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlmodel import Session, select

from app.collect.models import CollectTask
from app.common import NIL_UUID
from app.jobs.models import Job
from app.monitor.models import AlertEvent, AlertRule, Metric, StationSnapshot
from app.people_assets.models import Device, Station
from app.ticket import service as ticket_service

logger = logging.getLogger("galio.worker.alert_evaluate")


async def run(job: Job, session: Session) -> None:
    """评估所有 enabled=True 的 alert_rule，命中时产生/收敛 alert_event。"""
    _ = job  # job 参数保留给调度框架，评估逻辑本身不依赖 job 内容
    rules = session.exec(
        select(AlertRule).where(AlertRule.enabled.is_(True), AlertRule.deleted_at.is_(None))
    ).all()

    for rule in rules:
        try:
            _evaluate_rule(session, rule)
        except Exception:
            logger.exception("alert rule %s (%s) evaluation failed", rule.id, rule.name)


def _evaluate_rule(session: Session, rule: AlertRule) -> None:
    """单条规则的评估逻辑。按 rule_type 分派到具体评估函数。"""
    if rule.rule_type == "threshold":
        _eval_threshold(session, rule)
    elif rule.rule_type == "status_change":
        _eval_status_change(session, rule)
    elif rule.rule_type == "heartbeat_lost":
        _eval_heartbeat_lost(session, rule)
    elif rule.rule_type == "frame_drop_rate":
        _eval_frame_drop_rate(session, rule)
    else:
        logger.warning("unknown rule_type %s for rule %s", rule.rule_type, rule.id)


# ---- threshold ----


def _eval_threshold(session: Session, rule: AlertRule) -> None:
    """阈值规则：config 约定 {"metric_name": "...", "operator": ">|<|>=|<=", "threshold": float, "scope_station_ids": [uuid?]}。

    遍历所有工位（或 scope 指定工位）的最新一条 metric，命中条件时开/收敛 alert_event。
    """
    config = rule.config or {}
    metric_name = config.get("metric_name")
    operator = config.get("operator", ">")
    threshold = config.get("threshold")
    if metric_name is None or threshold is None:
        return

    station_ids = _resolve_scope_stations(session, config.get("scope_station_ids"), rule.scope_device_type)

    for station_id in station_ids:
        device_id = _resolve_device_for_metric(config.get("device_id"))
        latest = _get_latest_metric(session, station_id, device_id, metric_name)
        if latest is None:
            continue
        if not _compare(latest.metric_value, operator, threshold):
            continue
        _fire_or_update_event(session, rule, station_id, device_id, {
            "metric_name": metric_name,
            "metric_value": latest.metric_value,
            "threshold": threshold,
            "operator": operator,
            "recorded_at": latest.recorded_at.isoformat(),
        })


# ---- status_change ----


def _eval_status_change(session: Session, rule: AlertRule) -> None:
    """状态变更规则：config 约定 {"probe": "arm", "from_status": "ok", "to_status": "fail"}。

    检查 station_snapshot.health[probe].status 是否从 from_status 变为 to_status。
    由于 station_snapshot 只存当前快照（不存历史），from_status 检查退化为：
    当前 status == to_status 且 open alert_event 不存在时即开单（首次发现）。
    """
    config = rule.config or {}
    probe = config.get("probe")
    to_status = config.get("to_status")
    if probe is None or to_status is None:
        return

    station_ids = _resolve_scope_stations(session, config.get("scope_station_ids"), rule.scope_device_type)

    for station_id in station_ids:
        snapshot = session.get(StationSnapshot, station_id)
        if snapshot is None or not snapshot.health:
            continue
        probe_health = snapshot.health.get(probe)
        if not isinstance(probe_health, dict):
            continue
        current_status = probe_health.get("status")
        if current_status != to_status:
            continue
        device_id = _resolve_device_for_probe(session, station_id, probe)
        _fire_or_update_event(session, rule, station_id, device_id, {
            "probe": probe,
            "current_status": current_status,
            "expected_status": config.get("from_status", "ok"),
            "last_checked": probe_health.get("last_checked"),
        })


# ---- heartbeat_lost ----


def _eval_heartbeat_lost(session: Session, rule: AlertRule) -> None:
    """心跳丢失规则：station_snapshot.last_poll_status == 'unreachable'。

    config 可选 {"consecutive_failures": int}，默认用 settings.offline_after_consecutive_failures。
    由于 station_snapshot 不保留历史计数，这里用 last_polled_at 距今的 elapsed 时间估算：
    elapsed >= consecutive_failures * poll_interval 即判定。
    """
    from app.settings import settings

    config = rule.config or {}
    required_failures = config.get("consecutive_failures", settings.offline_after_consecutive_failures)
    poll_interval = settings.node_exporter_poll_seconds

    station_ids = _resolve_scope_stations(session, config.get("scope_station_ids"), rule.scope_device_type)

    for station_id in station_ids:
        snapshot = session.get(StationSnapshot, station_id)
        if snapshot is None:
            continue
        if snapshot.last_poll_status != "unreachable":
            continue
        if snapshot.last_polled_at is None:
            # 从未成功抓取——直接判定心跳丢失
            elapsed = float("inf")
        else:
            elapsed = (datetime.now(UTC) - snapshot.last_polled_at).total_seconds()
        if elapsed < required_failures * poll_interval:
            continue
        _fire_or_update_event(session, rule, station_id, None, {
            "last_poll_status": snapshot.last_poll_status,
            "last_polled_at": snapshot.last_polled_at.isoformat() if snapshot.last_polled_at else None,
            "elapsed_seconds": elapsed if elapsed != float("inf") else None,
            "consecutive_failures_required": required_failures,
        })


# ---- frame_drop_rate ----


def _eval_frame_drop_rate(session: Session, rule: AlertRule) -> None:
    """掉帧率规则：collect_task.frame_drop_count 超阈值。

    config 约定 {"threshold": int, "scope_station_ids": [uuid?]}。
    只评估 status=in_progress 的任务——已完成的任务掉帧不再告警。
    """
    config = rule.config or {}
    threshold = config.get("threshold")
    if threshold is None:
        return

    statement = select(CollectTask).where(
        CollectTask.status == "in_progress",
        CollectTask.frame_drop_count >= threshold,
        CollectTask.deleted_at.is_(None),
    )
    scope_ids = config.get("scope_station_ids")
    if scope_ids:
        statement = statement.where(CollectTask.station_id.in_([uuid.UUID(s) for s in scope_ids]))

    tasks = session.exec(statement).all()
    for task in tasks:
        _fire_or_update_event(session, rule, task.station_id, None, {
            "collect_task_id": str(task.id),
            "frame_drop_count": task.frame_drop_count,
            "threshold": threshold,
            "task_name": task.task_name,
        })


# ---- 通用辅助 ----


def _fire_or_update_event(session: Session, rule: AlertRule, station_id: uuid.UUID,
                           device_id: uuid.UUID | None, detail: dict) -> None:
    """命中规则时：已有 open 事件则 occurrence_count++，否则新建。

    去重靠 uq_alert_event_open(alert_rule_id, station_id, coalesce(device_id, nil_uuid))
    WHERE status='open' AND deleted_at IS NULL——部分唯一索引保证同一规则+工位+设备
    只有一个 open 事件。用 SELECT 查现有 open 事件，有则更新，无则插入。
    """
    existing = _find_open_event(session, rule.id, station_id, device_id)
    if existing is not None:
        existing.occurrence_count += 1
        existing.detail = {**(existing.detail or {}), **detail, "last_fire": datetime.now(UTC).isoformat()}
        session.add(existing)
        session.commit()
        return

    # 新建 alert_event
    event = AlertEvent(
        alert_rule_id=rule.id,
        station_id=station_id,
        device_id=device_id,
        severity=rule.severity,
        status="open",
        detail=detail,
        created_by="ingest",
    )
    session.add(event)
    session.commit()
    session.refresh(event)

    # auto_create_ticket
    if rule.auto_create_ticket:
        ticket = ticket_service.report_ticket(
            session,
            station_id=station_id,
            source="alert_auto",
            device_id=device_id,
            created_by="alert_engine",
        )
        event.ticket_id = ticket.id
        session.add(event)
        session.commit()


def _find_open_event(session: Session, rule_id: uuid.UUID, station_id: uuid.UUID,
                     device_id: uuid.UUID | None) -> AlertEvent | None:
    """查找同一规则+工位+设备的 open 事件。device_id 为 None 时用 NIL_UUID 匹配。"""
    dev_filter = NIL_UUID if device_id is None else str(device_id)
    statement = text("""
        SELECT * FROM alert_event
        WHERE alert_rule_id = :rule_id
          AND station_id = :station_id
          AND COALESCE(device_id::text, :nil_uuid) = :dev_filter
          AND status = 'open'
          AND deleted_at IS NULL
        LIMIT 1
    """)
    result = session.execute(statement, {
        "rule_id": str(rule_id),
        "station_id": str(station_id),
        "nil_uuid": NIL_UUID,
        "dev_filter": dev_filter,
    })
    row = result.first()
    if row is None:
        return None
    # 从 row 重建 AlertEvent 对象（SQL text 查询不自动映射到 ORM）
    return session.get(AlertEvent, row.id)


def _resolve_scope_stations(session: Session, scope_station_ids: list[str] | None,
                            scope_device_type: str | None) -> list[uuid.UUID]:
    """解析规则作用的工位范围。

    scope_station_ids 优先（显式指定工位列表）；否则按 scope_device_type 筛选有该类型设备的工位；
    都没有则返回所有 active 工位。
    """
    if scope_station_ids:
        return [uuid.UUID(s) for s in scope_station_ids]

    if scope_device_type:
        statement = (
            select(Station.id)
            .join(Device, Device.station_id == Station.id)
            .where(Station.deleted_at.is_(None), Device.deleted_at.is_(None),
                   Device.type == scope_device_type)
            .distinct()
        )
        return [row for row in session.exec(statement).all()]

    stations = session.exec(
        select(Station).where(Station.deleted_at.is_(None), Station.status == "active")
    ).all()
    return [s.id for s in stations]


def _resolve_device_for_metric(device_id: str | None) -> uuid.UUID | None:
    """解析 metric 对应的 device_id。config 中可显式指定，否则返回 None（工位级指标）。"""
    if device_id:
        return uuid.UUID(device_id)
    return None


def _resolve_device_for_probe(session: Session, station_id: uuid.UUID,
                              probe: str) -> uuid.UUID | None:
    """按探针名找到工位上对应类型的设备 ID。"""
    from app.jobs.handlers.poll_device_probes import PROBE_TO_DEVICE_TYPE
    device_type = PROBE_TO_DEVICE_TYPE.get(probe)
    if device_type is None:
        return None
    device = session.exec(
        select(Device).where(
            Device.station_id == station_id,
            Device.type == device_type,
            Device.deleted_at.is_(None),
        )
    ).first()
    return device.id if device else None


def _get_latest_metric(session: Session, station_id: uuid.UUID, device_id: uuid.UUID | None,
                       metric_name: str) -> Metric | None:
    """取最新一条 metric 记录。"""
    statement = (
        select(Metric)
        .where(Metric.station_id == station_id, Metric.metric_name == metric_name)
    )
    if device_id is not None:
        statement = statement.where(Metric.device_id == device_id)
    else:
        statement = statement.where(Metric.device_id.is_(None))
    statement = statement.order_by(Metric.recorded_at.desc()).limit(1)
    return session.exec(statement).first()


def _compare(value: float, operator: str, threshold: float) -> bool:
    """简单比较运算。"""
    if operator == ">":
        return value > threshold
    if operator == "<":
        return value < threshold
    if operator == ">=":
        return value >= threshold
    if operator == "<=":
        return value <= threshold
    if operator == "==":
        return value == threshold
    return False
