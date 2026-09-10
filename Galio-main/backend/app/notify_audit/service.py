"""通知与审计的查询/写入逻辑。对照 docs/api-design.md 「8. 通知与审计」。"""
from __future__ import annotations

import uuid

from sqlmodel import Session, select

from app.notify_audit.models import AuditLog, Notification
from app.pagination import Pagination


def list_notifications(session: Session, pagination: Pagination, status: str | None = None) -> tuple[list[Notification], int]:
    statement = select(Notification).order_by(Notification.created_at.desc())
    if status:
        statement = statement.where(Notification.status == status)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def mark_notification_read(session: Session, notification_id: uuid.UUID) -> Notification:
    """TODO: database-schema.md 的 notification 表没有"已读"字段（只有投递管线的
    pending/sending/sent/failed），这是 api-design.md 规划时的一个真实缺口——需要先给
    notification 加一列（比如 read_at timestamptz）再实现这个接口，不能借用 status 字段
    冒充已读状态（语义会和投递状态混在一起）。当前直接抛错，不假装成功。
    """
    raise NotImplementedError(
        "notification 表缺少已读字段，需要先更新 docs/database-schema.md 再实现，见本函数 docstring"
    )


def write_audit_log(session: Session, *, actor: str, action: str, entity_type: str,
                     entity_id: uuid.UUID | None = None, request_id: str | None = None,
                     detail: dict | None = None) -> AuditLog:
    """给其他模块调用的公共写入口；本次脚手架里暂未在各业务 service 里接线调用，
    留给实现阶段按「提交前检查」逐个补齐审计点。
    """
    log = AuditLog(actor=actor, action=action, entity_type=entity_type, entity_id=entity_id,
                    request_id=request_id, detail=detail)
    session.add(log)
    session.commit()
    session.refresh(log)
    return log


def query_audit_logs(session: Session, pagination: Pagination, entity_type: str | None = None,
                      actor: str | None = None) -> tuple[list[AuditLog], int]:
    statement = select(AuditLog).order_by(AuditLog.created_at.desc())
    if entity_type:
        statement = statement.where(AuditLog.entity_type == entity_type)
    if actor:
        statement = statement.where(AuditLog.actor == actor)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total
