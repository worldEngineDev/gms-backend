"""版本对账：比对 version_report 与 config_template/release 目标版本，命中漂移时开 alert_event。

对照 docs/database-schema.md 取舍 5：期望 vs 实际版本对账是查询逻辑，不维护额外状态表。
漂移检测结果通过 alert_rule（rule_type='threshold', config.metric_name='version_drift'）
联动到 alert_event——也可以直接在这里开单，但复用告警引擎更一致。
"""
from __future__ import annotations

import logging

from sqlmodel import Session, select

from app.jobs.models import Job
from app.monitor.models import AlertEvent, AlertRule
from app.pagination import Pagination
from app.release import service as release_service

logger = logging.getLogger("galio.worker.version_reconcile")


async def run(job: Job, session: Session) -> None:
    _ = job
    drift_items, _ = release_service.version_drift(session, Pagination(page=1, page_size=500))

    # 查找版本漂移专用告警规则——按约定 rule_type='threshold' 且 config.metric_name='version_drift'
    rule = session.exec(
        select(AlertRule).where(
            AlertRule.rule_type == "threshold",
            AlertRule.enabled.is_(True),
            AlertRule.deleted_at.is_(None),
        )
    ).first()

    for item in drift_items:
        if not item.get("is_drift"):
            continue
        _fire_version_drift_event(session, rule, item)

    # 配置指纹漂移检测
    fp_items, _ = release_service.config_fingerprint_drift(session, Pagination(page=1, page_size=500))
    for item in fp_items:
        if not item.get("is_drift"):
            continue
        _fire_version_drift_event(session, rule, {
            "station_id": item["station_id"],
            "module": item["module"],
            "expected_version": item["expected_fingerprint"],
            "reported_version": item["reported_fingerprint"],
            "reported_at": item["reported_at"],
        })


def _fire_version_drift_event(session: Session, rule: AlertRule | None, item: dict) -> None:
    """版本漂移命中时开 alert_event。

    没有对应的 alert_rule 时也开事件——用 nil rule_id 占位不行（FK 约束），
    所以要求先建一条 version_drift 告警规则；规则不存在时跳过，记 warning。
    """
    if rule is None:
        logger.warning("version drift detected but no alert_rule with rule_type='threshold' found; "
                       "station=%s module=%s expected=%s actual=%s",
                       item.get("station_id"), item.get("module"),
                       item.get("expected_version"), item.get("reported_version"))
        return

    station_id = item["station_id"]
    detail = {
        "module": item["module"],
        "expected_version": item["expected_version"],
        "reported_version": item["reported_version"],
        "reported_at": item["reported_at"].isoformat() if item["reported_at"] else None,
    }

    # 查找已有的 open 版本漂移事件（去重）
    existing = session.exec(
        select(AlertEvent).where(
            AlertEvent.alert_rule_id == rule.id,
            AlertEvent.station_id == station_id,
            AlertEvent.device_id.is_(None),
            AlertEvent.status == "open",
            AlertEvent.deleted_at.is_(None),
        )
    ).first()

    if existing is not None:
        existing.occurrence_count += 1
        existing.detail = {**(existing.detail or {}), **detail}
        session.add(existing)
        session.commit()
        return

    event = AlertEvent(
        alert_rule_id=rule.id,
        station_id=station_id,
        device_id=None,
        severity=rule.severity,
        status="open",
        detail=detail,
        created_by="ingest",
    )
    session.add(event)
    session.commit()
