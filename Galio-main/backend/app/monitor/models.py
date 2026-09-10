"""监控与告警：metric / metric_hourly_agg / station_snapshot / alert_rule / alert_event。

对照 docs/database-schema.md 「10. 监控与告警」。`metric`/`metric_hourly_agg` 在数据库层面按设计
不建代理主键（见 database-schema.md 取舍 1），这里给组合列标记 primary_key=True 只是满足
SQLAlchemy ORM 映射要求，不代表数据库有对应的 PRIMARY KEY 约束——真正的 DDL 以迁移脚本为准，
不要对这两个模型调用 SQLModel.metadata.create_all()。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, deleted_at_field, id_field


class Metric(SQLModel, table=True):
    __tablename__ = "metric"

    station_id: uuid.UUID = Field(foreign_key="station.id", primary_key=True)
    device_id: uuid.UUID | None = Field(default=None, foreign_key="device.id", primary_key=True)
    metric_name: str = Field(primary_key=True)  # battery_level / link_rate / frame_drop_rate / ...
    metric_value: float
    recorded_at: datetime = Field(primary_key=True, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field(default="ingest")


class MetricHourlyAgg(SQLModel, table=True):
    __tablename__ = "metric_hourly_agg"

    station_id: uuid.UUID = Field(foreign_key="station.id", primary_key=True)
    device_id: uuid.UUID | None = Field(default=None, foreign_key="device.id", primary_key=True)
    metric_name: str = Field(primary_key=True)
    hour_bucket: datetime = Field(primary_key=True, sa_type=UTC_DATETIME)
    avg_value: float
    min_value: float
    max_value: float
    sample_count: int


class StationSnapshot(SQLModel, table=True):
    """每工位一行的实时状态快照，UPSERT 更新。"""

    __tablename__ = "station_snapshot"

    station_id: uuid.UUID = Field(foreign_key="station.id", primary_key=True)
    status: str = "offline"  # online|offline|degraded
    last_polled_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    last_poll_status: str | None = None  # ok|unreachable
    last_poll_error: str | None = None
    health: dict = Field(default_factory=dict, sa_column=Column(JSON))
    active_ticket_count: int = 0
    updated_at: datetime = created_at_field()


class AlertRule(SQLModel, table=True):
    __tablename__ = "alert_rule"

    id: uuid.UUID = id_field()
    name: str
    rule_type: str  # threshold|status_change|heartbeat_lost|frame_drop_rate
    scope_device_type: str | None = None
    config: dict = Field(sa_column=Column(JSON))
    severity: str  # p0|p1|p2|p3
    enabled: bool = True
    auto_create_ticket: bool = False
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class AlertEvent(SQLModel, table=True):
    __tablename__ = "alert_event"

    id: uuid.UUID = id_field()
    alert_rule_id: uuid.UUID = Field(foreign_key="alert_rule.id")
    station_id: uuid.UUID = Field(foreign_key="station.id")
    device_id: uuid.UUID | None = Field(default=None, foreign_key="device.id")
    severity: str
    status: str = "open"  # open|acked|resolved|suppressed
    occurrence_count: int = 1
    detail: dict = Field(sa_column=Column(JSON))
    ticket_id: uuid.UUID | None = Field(default=None, foreign_key="ticket.id")
    opened_at: datetime = created_at_field()
    resolved_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field(default="ingest")
    deleted_at: datetime | None = deleted_at_field()
