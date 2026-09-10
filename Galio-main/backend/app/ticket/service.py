"""工单调度的查询/状态机逻辑。对照 docs/api-design.md 「3. 工单调度」与 docs/architecture.md「工单状态机」。

状态流转用 `UPDATE ... WHERE status = 期望前态` 乐观断言（见 docs/database-schema.md「通用约定」），
影响行数为 0 即冲突，抛 TicketConflict，由 router 转成 409。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import update as sa_update
from sqlmodel import Session, select

from app.pagination import Pagination
from app.ticket.models import Ticket, TicketEvent


class TicketNotFound(Exception):
    pass


class TicketConflict(Exception):
    """当前状态不是期望前态，说明有并发流转或调用方状态过期。"""


def _get_or_raise(session: Session, ticket_id: uuid.UUID) -> Ticket:
    ticket = session.get(Ticket, ticket_id)
    if ticket is None or ticket.deleted_at is not None:
        raise TicketNotFound(str(ticket_id))
    return ticket


def _transition(session: Session, ticket_id: uuid.UUID, *, expected_statuses: tuple[str, ...],
                 new_status: str, event_type: str, actor_id: uuid.UUID | None, created_by: str,
                 extra_fields: dict | None = None) -> Ticket:
    fields = {"status": new_status, **(extra_fields or {})}
    statement = (
        sa_update(Ticket)
        .where(Ticket.id == ticket_id, Ticket.status.in_(expected_statuses), Ticket.deleted_at.is_(None))
        .values(**fields)
    )
    result = session.execute(statement)
    if result.rowcount == 0:
        raise TicketConflict(f"ticket {ticket_id} not in {expected_statuses}")
    session.add(TicketEvent(ticket_id=ticket_id, event_type=event_type, actor_id=actor_id, created_by=created_by))
    session.commit()
    return _get_or_raise(session, ticket_id)


def list_tickets(session: Session, pagination: Pagination, station_id: uuid.UUID | None = None,
                  status: str | None = None, assignee_id: uuid.UUID | None = None) -> tuple[list[Ticket], int]:
    statement = select(Ticket).where(Ticket.deleted_at.is_(None)).order_by(Ticket.reported_at.desc())
    if station_id:
        statement = statement.where(Ticket.station_id == station_id)
    if status:
        statement = statement.where(Ticket.status == status)
    if assignee_id:
        statement = statement.where(Ticket.assignee_id == assignee_id)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_ticket_detail(session: Session, ticket_id: uuid.UUID) -> dict | None:
    ticket = session.get(Ticket, ticket_id)
    if ticket is None or ticket.deleted_at is not None:
        return None
    events = session.exec(
        select(TicketEvent).where(TicketEvent.ticket_id == ticket_id).order_by(TicketEvent.created_at)
    ).all()
    return {"ticket": ticket, "events": events}


def report_ticket(session: Session, *, station_id: uuid.UUID, source: str, created_by: str,
                   device_id: uuid.UUID | None = None, reporter_id: uuid.UUID | None = None) -> Ticket:
    ticket = Ticket(station_id=station_id, source=source, device_id=device_id, reporter_id=reporter_id,
                     created_by=created_by)
    session.add(ticket)
    session.commit()
    session.refresh(ticket)
    session.add(TicketEvent(ticket_id=ticket.id, event_type="reported", actor_id=reporter_id, created_by=created_by))
    session.commit()
    return ticket


def triage(session: Session, ticket_id: uuid.UUID, *, fault_type_id: uuid.UUID | None, fault_category: str | None,
           actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    return _transition(
        session, ticket_id, expected_statuses=("reported",), new_status="triaged", event_type="triaged",
        actor_id=actor_id, created_by=created_by,
        extra_fields={"fault_type_id": fault_type_id, "fault_category": fault_category},
    )


def dispatch(session: Session, ticket_id: uuid.UUID, *, assignee_id: uuid.UUID, actor_id: uuid.UUID | None,
             created_by: str) -> Ticket:
    return _transition(
        session, ticket_id, expected_statuses=("triaged",), new_status="in_progress", event_type="dispatched",
        actor_id=actor_id, created_by=created_by,
        extra_fields={"assignee_id": assignee_id, "dispatched_at": datetime.now(UTC)},
    )


def accept(session: Session, ticket_id: uuid.UUID, *, actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    """也承接状态机里"已升级 → 处理中：上级接单"，同一个动作从 escalated 回到 in_progress。"""
    ticket = _get_or_raise(session, ticket_id)
    now = datetime.now(UTC)
    response_seconds = None
    if ticket.dispatched_at is not None:
        response_seconds = int((now - ticket.dispatched_at).total_seconds())
    return _transition(
        session, ticket_id, expected_statuses=("in_progress", "escalated"), new_status="in_progress",
        event_type="accepted", actor_id=actor_id, created_by=created_by,
        extra_fields={"accepted_at": now, "response_seconds": response_seconds},
    )


def submit_fix(session: Session, ticket_id: uuid.UUID, *, actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    return _transition(
        session, ticket_id, expected_statuses=("in_progress",), new_status="pending_acceptance",
        event_type="resubmitted", actor_id=actor_id, created_by=created_by,
    )


def close(session: Session, ticket_id: uuid.UUID, *, actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    ticket = _get_or_raise(session, ticket_id)
    now = datetime.now(UTC)
    resolution_seconds = int((now - ticket.reported_at).total_seconds())
    ticket = _transition(
        session, ticket_id, expected_statuses=("pending_acceptance",), new_status="closed",
        event_type="acceptance_passed", actor_id=actor_id, created_by=created_by,
        extra_fields={"resolved_at": now, "closed_at": now, "resolution_seconds": resolution_seconds},
    )
    session.add(TicketEvent(ticket_id=ticket_id, event_type="closed", actor_id=actor_id, created_by=created_by))
    session.commit()
    return ticket


def reject(session: Session, ticket_id: uuid.UUID, *, actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    return _transition(
        session, ticket_id, expected_statuses=("pending_acceptance",), new_status="in_progress",
        event_type="acceptance_rejected", actor_id=actor_id, created_by=created_by,
    )


def escalate(session: Session, ticket_id: uuid.UUID, *, actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    return _transition(
        session, ticket_id, expected_statuses=("in_progress",), new_status="escalated", event_type="escalated",
        actor_id=actor_id, created_by=created_by,
    )


def self_resolve(session: Session, ticket_id: uuid.UUID, *, actor_id: uuid.UUID | None, created_by: str) -> Ticket:
    ticket = _get_or_raise(session, ticket_id)
    now = datetime.now(UTC)
    resolution_seconds = int((now - ticket.reported_at).total_seconds())
    return _transition(
        session, ticket_id, expected_statuses=("reported",), new_status="closed", event_type="closed",
        actor_id=actor_id, created_by=created_by,
        extra_fields={
            "self_resolved": True, "resolved_at": now, "closed_at": now, "resolution_seconds": resolution_seconds,
        },
    )


def export_tickets(session: Session, station_id: uuid.UUID | None = None, status: str | None = None) -> list[Ticket]:
    """TODO: 导出格式（CSV/XLSX）未定，目前直接返回明细行，由调用方决定序列化格式。"""
    statement = select(Ticket).where(Ticket.deleted_at.is_(None)).order_by(Ticket.reported_at.desc())
    if station_id:
        statement = statement.where(Ticket.station_id == station_id)
    if status:
        statement = statement.where(Ticket.status == status)
    return session.exec(statement).all()
