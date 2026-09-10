"""采集业务与班次交接的查询/写入逻辑。对照 docs/api-design.md 「6. 采集业务与班次交接」。"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlmodel import Session, select

from app.collect.models import CollectTask, Handover, HandoverItem
from app.monitor.models import StationSnapshot
from app.pagination import Pagination
from app.people_assets.models import Station
from app.ticket import service as ticket_service
from app.ticket.models import Ticket

# ---- collect_task ----


def list_collect_tasks(session: Session, pagination: Pagination, station_id: uuid.UUID | None = None,
                        person_id: uuid.UUID | None = None) -> tuple[list[CollectTask], int]:
    statement = select(CollectTask).where(CollectTask.deleted_at.is_(None)).order_by(CollectTask.started_at.desc())
    if station_id:
        statement = statement.where(CollectTask.station_id == station_id)
    if person_id:
        statement = statement.where(CollectTask.person_id == person_id)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def start_collect_task(session: Session, *, station_id: uuid.UUID, person_id: uuid.UUID, task_name: str,
                        created_by: str) -> CollectTask:
    task = CollectTask(station_id=station_id, person_id=person_id, task_name=task_name, created_by=created_by)
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def end_collect_task(session: Session, task_id: uuid.UUID) -> CollectTask | None:
    task = session.get(CollectTask, task_id)
    if task is None or task.deleted_at is not None:
        return None
    task.status = "completed"
    task.ended_at = datetime.now(UTC)
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def report_collect_task_event(session: Session, task_id: uuid.UUID, *, event_type: str, created_by: str,
                               convert_to_ticket: bool = False, detail: dict | None = None) -> dict:
    """掉帧/会话异常事件，采集软件直接调用（见 docs/architecture.md「采集端 App 集成」）。

    event_type == 'frame_drop' 时累加 frame_drop_count；convert_to_ticket=True 时复用
    ticket.service.report_ticket 一键转报修，不重复实现报修逻辑。
    """
    task = session.get(CollectTask, task_id)
    if task is None or task.deleted_at is not None:
        return {"task": None, "ticket": None}

    if event_type == "frame_drop":
        task.frame_drop_count += 1
        session.add(task)
        session.commit()
        session.refresh(task)

    ticket = None
    if convert_to_ticket:
        ticket = ticket_service.report_ticket(
            session, station_id=task.station_id, source="manual_report", created_by=created_by,
        )
    return {"task": task, "ticket": ticket}


# ---- handover ----


def list_handovers(session: Session, pagination: Pagination, zone_id: uuid.UUID | None = None) -> tuple[list[Handover], int]:
    statement = select(Handover).where(Handover.deleted_at.is_(None)).order_by(Handover.created_at.desc())
    if zone_id:
        statement = statement.where(Handover.zone_id == zone_id)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_handover_detail(session: Session, handover_id: uuid.UUID) -> dict | None:
    handover = session.get(Handover, handover_id)
    if handover is None or handover.deleted_at is not None:
        return None
    items = session.exec(select(HandoverItem).where(HandoverItem.handover_id == handover_id)).all()
    return {"handover": handover, "items": items}


def create_handover(session: Session, *, zone_id: uuid.UUID, from_shift_id: uuid.UUID, created_by: str,
                     to_shift_id: uuid.UUID | None = None) -> Handover:
    """生成设备快照 + 未闭环工单列表，两者都是交接时点的快照，不建 FK。"""
    stations = session.exec(
        select(Station).where(Station.zone_id == zone_id, Station.deleted_at.is_(None))
    ).all()
    station_ids = [station.id for station in stations]

    snapshot: dict[str, dict] = {}
    for station in stations:
        snap = session.get(StationSnapshot, station.id)
        snapshot[str(station.id)] = {
            "status": snap.status if snap else "offline",
            "health": snap.health if snap else {},
        }

    open_tickets: list[Ticket] = []
    if station_ids:
        open_tickets = session.exec(
            select(Ticket).where(
                Ticket.station_id.in_(station_ids), Ticket.status != "closed", Ticket.deleted_at.is_(None)
            )
        ).all()

    handover = Handover(
        zone_id=zone_id, from_shift_id=from_shift_id, to_shift_id=to_shift_id,
        station_snapshot=snapshot, open_ticket_ids=[ticket.id for ticket in open_tickets], created_by=created_by,
    )
    session.add(handover)
    session.commit()
    session.refresh(handover)

    for station in stations:
        session.add(HandoverItem(handover_id=handover.id, station_id=station.id, created_by=created_by))
    session.commit()
    return handover


def confirm_handover_item(session: Session, handover_id: uuid.UUID, station_id: uuid.UUID) -> HandoverItem | None:
    statement = select(HandoverItem).where(
        HandoverItem.handover_id == handover_id, HandoverItem.station_id == station_id
    )
    item = session.exec(statement).first()
    if item is None:
        return None
    item.confirmed = True
    item.confirmed_at = datetime.now(UTC)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def confirm_handover(session: Session, handover_id: uuid.UUID, confirmed_by: uuid.UUID) -> Handover | None:
    handover = session.get(Handover, handover_id)
    if handover is None or handover.deleted_at is not None:
        return None
    handover.status = "confirmed"
    handover.confirmed_by = confirmed_by
    handover.confirmed_at = datetime.now(UTC)
    session.add(handover)
    session.commit()
    session.refresh(handover)
    return handover


def escalate_handover(session: Session, handover_id: uuid.UUID) -> Handover | None:
    handover = session.get(Handover, handover_id)
    if handover is None or handover.deleted_at is not None:
        return None
    handover.status = "escalated"
    handover.escalated_at = datetime.now(UTC)
    session.add(handover)
    session.commit()
    session.refresh(handover)
    return handover
