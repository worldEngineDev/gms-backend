"""发布与配置：config_template / artifact / release / release_target / version_report / release_freeze。

对照 docs/database-schema.md 「7. 发布与配置」。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, deleted_at_field, id_field


class ConfigTemplate(SQLModel, table=True):
    __tablename__ = "config_template"

    id: uuid.UUID = id_field()
    name: str
    applies_to: str  # machine_config|importer_config
    device_model: str | None = None
    content_file_id: uuid.UUID | None = Field(default=None, foreign_key="file.id")
    current_version: str
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Artifact(SQLModel, table=True):
    """登记后不可变，没有 update/delete，见 docs/api-design.md 接口规划原则 3。"""

    __tablename__ = "artifact"

    id: uuid.UUID = id_field()
    artifact_type: str  # image|package|config_template
    name: str
    version: str
    image_ref: str | None = None  # artifact_type = image 时：registry 镜像地址
    checksum: str
    file_id: uuid.UUID | None = Field(default=None, foreign_key="file.id")
    config_template_id: uuid.UUID | None = Field(default=None, foreign_key="config_template.id")
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class Release(SQLModel, table=True):
    __tablename__ = "release"

    id: uuid.UUID = id_field()
    artifact_id: uuid.UUID = Field(foreign_key="artifact.id")
    status: str = "draft"  # draft|testing|approved|rolling_out|completed|failed|rolled_back
    test_station_id: uuid.UUID | None = Field(default=None, foreign_key="station.id")
    approved_by: uuid.UUID | None = Field(default=None, foreign_key="person.id")
    approved_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    previous_release_id: uuid.UUID | None = Field(default=None, foreign_key="release.id")  # 回滚指针
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class ReleaseTarget(SQLModel, table=True):
    __tablename__ = "release_target"

    id: uuid.UUID = id_field()
    release_id: uuid.UUID = Field(foreign_key="release.id")
    station_id: uuid.UUID = Field(foreign_key="station.id")
    status: str = "pending"  # pending|deploying|verifying|success|failed|skipped
    actual_version: str | None = None
    checksum_verified: bool = False
    deployed_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    verified_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field(default="ingest")
    deleted_at: datetime | None = deleted_at_field()


class VersionReport(SQLModel, table=True):
    """Worker 巡检/发布流程里查询并写回，不是面向用户的写接口。"""

    __tablename__ = "version_report"

    id: uuid.UUID = id_field()
    station_id: uuid.UUID = Field(foreign_key="station.id")
    module: str  # hand_sdk / capture_app / importer ...
    reported_version: str
    config_fingerprint: str | None = None
    reported_at: datetime = created_at_field()
    created_at: datetime = created_at_field()
    created_by: str = created_by_field(default="ingest")


class ReleaseFreeze(SQLModel, table=True):
    __tablename__ = "release_freeze"

    id: uuid.UUID = id_field()
    scope_type: str  # global|site|zone|station
    site_id: uuid.UUID | None = Field(default=None, foreign_key="site.id")
    zone_id: uuid.UUID | None = Field(default=None, foreign_key="zone.id")
    station_id: uuid.UUID | None = Field(default=None, foreign_key="station.id")
    reason: str
    starts_at: datetime = created_at_field()
    ends_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    status: str = "active"  # active|released
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    released_by: str | None = None
    released_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
