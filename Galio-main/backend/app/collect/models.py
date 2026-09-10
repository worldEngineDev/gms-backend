"""采集业务与班次交接：collect_task / handover / handover_item。

对照 docs/database-schema.md 「8. 采集业务与交接」。`handover.station_snapshot`/`open_ticket_ids`
是交接时点的快照，不建 FK，见 database-schema.md「表关联关系 > 关系类型」。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ARRAY, JSON, Column
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, deleted_at_field, id_field


class CollectTask(SQLModel, table=True):
    __tablename__ = "collect_task"

    id: uuid.UUID = id_field()
    station_id: uuid.UUID = Field(foreign_key="station.id")
    person_id: uuid.UUID = Field(foreign_key="person.id")
    task_name: str
    status: str = "in_progress"  # in_progress|completed|aborted
    started_at: datetime = created_at_field()
    ended_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    frame_drop_count: int = 0
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Handover(SQLModel, table=True):
    __tablename__ = "handover"

    id: uuid.UUID = id_field()
    zone_id: uuid.UUID = Field(foreign_key="zone.id")
    from_shift_id: uuid.UUID = Field(foreign_key="shift.id")
    to_shift_id: uuid.UUID | None = Field(default=None, foreign_key="shift.id")
    station_snapshot: dict = Field(sa_column=Column(JSON))  # 交班时点的设备状态快照，历史记录
    open_ticket_ids: list[uuid.UUID] = Field(
        default_factory=list, sa_column=Column(ARRAY(PGUUID(as_uuid=True)))
    )
    status: str = "pending_confirm"  # pending_confirm|confirmed|escalated
    confirmed_by: uuid.UUID | None = Field(default=None, foreign_key="person.id")
    confirmed_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    escalated_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class HandoverItem(SQLModel, table=True):
    __tablename__ = "handover_item"

    id: uuid.UUID = id_field()
    handover_id: uuid.UUID = Field(foreign_key="handover.id")
    station_id: uuid.UUID = Field(foreign_key="station.id")
    note: str | None = None
    confirmed: bool = False
    confirmed_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
