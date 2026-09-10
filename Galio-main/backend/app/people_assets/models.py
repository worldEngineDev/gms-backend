"""人员与组织资产：person / site / zone / zone_owner / station / device / device_change_log / shift。

对照 docs/database-schema.md 「1. 人员」「3. 资产」「4. 班次」。check 约束的允许值在字段注释里列出，
实际约束由数据库迁移脚本创建，这里的模型不重复声明 CheckConstraint。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, deleted_at_field, id_field


class Person(SQLModel, table=True):
    __tablename__ = "person"

    id: uuid.UUID = id_field()
    name: str
    feishu_user_id: str | None = None
    primary_role: str  # collector|operator|team_lead|admin（采集员/运维/采集组长/管理员，仅这四种）
    status: str = "active"  # active|inactive
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Site(SQLModel, table=True):
    __tablename__ = "site"

    id: uuid.UUID = id_field()
    code: str  # 栋：B / C
    name: str
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Zone(SQLModel, table=True):
    __tablename__ = "zone"

    id: uuid.UUID = id_field()
    site_id: uuid.UUID = Field(foreign_key="site.id")
    code: str
    name: str
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class ZoneOwner(SQLModel, table=True):
    __tablename__ = "zone_owner"

    id: uuid.UUID = id_field()
    zone_id: uuid.UUID = Field(foreign_key="zone.id")
    person_id: uuid.UUID = Field(foreign_key="person.id")
    seniority: str  # senior|junior，资深+新手搭配
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Station(SQLModel, table=True):
    __tablename__ = "station"

    id: uuid.UUID = id_field()
    zone_id: uuid.UUID = Field(foreign_key="zone.id")
    code: str
    name: str
    host: str | None = None  # SSH/node_exporter 连接地址；注册前可为空，见 database-schema.md 取舍 8
    status: str = "active"  # active|disabled
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Device(SQLModel, table=True):
    __tablename__ = "device"

    id: uuid.UUID = id_field()
    station_id: uuid.UUID = Field(foreign_key="station.id")
    sn: str
    type: str  # arm|hand|glove|quest|camera|link
    model: str | None = None
    lifecycle: str = "in_service"  # in_service|under_repair|retired
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class DeviceChangeLog(SQLModel, table=True):
    """台账变更全量留痕，不可变日志，不带 deleted_at。"""

    __tablename__ = "device_change_log"

    id: uuid.UUID = id_field()
    device_id: uuid.UUID = Field(foreign_key="device.id")
    change_type: str  # replace|repair|retire|reactivate|relocate
    from_station_id: uuid.UUID | None = Field(default=None, foreign_key="station.id")
    to_station_id: uuid.UUID | None = Field(default=None, foreign_key="station.id")
    note: str | None = None
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()


class Shift(SQLModel, table=True):
    __tablename__ = "shift"

    id: uuid.UUID = id_field()
    person_id: uuid.UUID = Field(foreign_key="person.id")
    zone_id: uuid.UUID | None = Field(default=None, foreign_key="zone.id")
    shift_type: str  # day|night
    starts_at: datetime = Field(sa_type=UTC_DATETIME)
    ends_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()
