"""排程物化为行，worker 经 SKIP LOCKED 认领，不依赖进程内调度器。对照 docs/database-schema.md 「11. 定时作业与通知」。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, id_field


class Job(SQLModel, table=True):
    __tablename__ = "job"

    id: uuid.UUID = id_field()
    job_type: str  # metric_partition_maintain|alert_evaluate|notification_dispatch|
    # version_reconcile|partition_cleanup
    scheduled_for: datetime = Field(sa_type=UTC_DATETIME)
    status: str = "pending"  # pending|claimed|done|failed
    claimed_by: str | None = None
    claimed_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    finished_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    error: str | None = None
    created_at: datetime = created_at_field()
    created_by: str = created_by_field(default="ingest")
