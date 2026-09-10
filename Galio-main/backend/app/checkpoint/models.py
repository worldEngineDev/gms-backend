"""检测引擎：fault_type / check_item / check_suite / check_suite_item / check_run / check_run_result。

对照 docs/database-schema.md 「5. 检测字典」「9. 检测执行记录」。四场景（体检/验收/
发布核验/交接）复用同一套模型，见 docs/architecture.md「检测场景复用」。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, deleted_at_field, id_field


class FaultType(SQLModel, table=True):
    __tablename__ = "fault_type"

    id: uuid.UUID = id_field()
    code: str
    name: str
    category: str  # hardware|software
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class CheckItem(SQLModel, table=True):
    __tablename__ = "check_item"

    id: uuid.UUID = id_field()
    name: str
    device_type: str  # arm|hand|glove|quest|camera|link|env|svc
    probe: str  # 执行探针标识
    access_method: str = "ssh"  # ssh|http，见 docs/architecture.md「探针脚本协议」
    params: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # access_method=ssh 时是探针脚本参数；access_method=http 时约定 {"port": int, "path": str}
    pass_criteria: dict = Field(sa_column=Column(JSON))
    fault_type_id: uuid.UUID | None = Field(default=None, foreign_key="fault_type.id")
    status: str = "active"  # active|disabled
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class CheckSuite(SQLModel, table=True):
    __tablename__ = "check_suite"

    id: uuid.UUID = id_field()
    name: str
    scenario: str  # pre_op_check|repair_acceptance|release_verify|handover_check
    device_type: str | None = None  # 为空 = 跨设备类型的整机/工位级 suite
    status: str = "active"  # active|disabled
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class CheckSuiteItem(SQLModel, table=True):
    __tablename__ = "check_suite_item"

    check_suite_id: uuid.UUID = Field(foreign_key="check_suite.id", primary_key=True)
    check_item_id: uuid.UUID = Field(foreign_key="check_item.id", primary_key=True)
    seq: int


class CheckRun(SQLModel, table=True):
    __tablename__ = "check_run"

    id: uuid.UUID = id_field()
    check_suite_id: uuid.UUID = Field(foreign_key="check_suite.id")
    station_id: uuid.UUID = Field(foreign_key="station.id")
    trigger_reason: str  # manual|ticket|release|schedule|handover
    ticket_id: uuid.UUID | None = Field(default=None, foreign_key="ticket.id")
    release_id: uuid.UUID | None = Field(default=None, foreign_key="release.id")
    release_target_id: uuid.UUID | None = Field(default=None, foreign_key="release_target.id")
    handover_id: uuid.UUID | None = Field(default=None, foreign_key="handover.id")
    conclusion: str | None = None  # pass|fail|partial
    started_at: datetime = created_at_field()
    finished_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class CheckRunResult(SQLModel, table=True):
    __tablename__ = "check_run_result"

    id: uuid.UUID = id_field()
    check_run_id: uuid.UUID = Field(foreign_key="check_run.id")
    check_item_id: uuid.UUID = Field(foreign_key="check_item.id")
    result: str  # pass|fail|unknown
    evidence: dict | None = Field(default=None, sa_column=Column(JSON))
    suggestion: str | None = None
    created_at: datetime = created_at_field()
    created_by: str = created_by_field(default="ingest")
