"""工单调度：ticket / ticket_event。对照 docs/database-schema.md 「6. 工单」。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, deleted_at_field, id_field


class Ticket(SQLModel, table=True):
    __tablename__ = "ticket"

    id: uuid.UUID = id_field()
    station_id: uuid.UUID = Field(foreign_key="station.id")
    device_id: uuid.UUID | None = Field(default=None, foreign_key="device.id")
    source: str  # manual_report|alert_auto|check_fail
    fault_type_id: uuid.UUID | None = Field(default=None, foreign_key="fault_type.id")
    fault_category: str | None = None  # hardware|software
    p_level: int | None = None  # 0-3
    p_level_set_by: uuid.UUID | None = Field(default=None, foreign_key="person.id")
    p_level_set_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    status: str = "reported"  # reported|triaged|in_progress|pending_acceptance|closed|escalated
    assignee_id: uuid.UUID | None = Field(default=None, foreign_key="person.id")
    reporter_id: uuid.UUID | None = Field(default=None, foreign_key="person.id")
    self_resolved: bool = False
    reported_at: datetime = created_at_field()
    dispatched_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    accepted_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    resolved_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    closed_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    response_seconds: int | None = None  # 派单→接单
    resolution_seconds: int | None = None  # 报修→闭环
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class TicketEvent(SQLModel, table=True):
    """工单流转记录，不可变日志，不带 deleted_at。"""

    __tablename__ = "ticket_event"

    id: uuid.UUID = id_field()
    ticket_id: uuid.UUID = Field(foreign_key="ticket.id")
    event_type: str  # reported|triaged|dispatched|accepted|resubmitted|acceptance_passed|
    # acceptance_rejected|escalated|closed|note
    actor_id: uuid.UUID | None = Field(default=None, foreign_key="person.id")
    detail: dict | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
