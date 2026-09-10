"""通用审计字段的可复用 Field 定义，见 docs/database-schema.md「通用约定」。

不做成 SQLModel 混入基类（多表继承在 alembic autogenerate 时容易产生意外的抽象基表）；
每个模型显式声明 id/created_at/created_by/deleted_at 三+一个字段，只是共享 Field(...) 的默认值定义，
减少重复的 sa_column_kwargs。真正的建表 DDL 以 docs/database-schema.md 为准，这些模型是给
FastAPI/SQLModel 查询用的镜像，不通过 SQLModel.metadata.create_all() 生成表——迁移脚本手写，
对照 database-schema.md 逐列核对。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, func
from sqlmodel import Field

# SQLModel 不会从纯 `datetime` 类型注解自动推出 `timestamptz`——不显式给 sa_type 的话，
# 建出来的是不带时区的 TIMESTAMP，跟应用层的 tz-aware UTC 时间做减法会直接抛
# "can't subtract offset-naive and offset-aware datetimes"。所有 datetime 字段都要带
# 这个 sa_type，不只是这几个审计字段，其余模型里的业务 datetime 字段也照此写。
UTC_DATETIME = DateTime(timezone=True)


def id_field() -> uuid.UUID:
    return Field(default_factory=uuid.uuid4, primary_key=True)


def created_at_field() -> datetime:
    return Field(
        default_factory=lambda: datetime.now(UTC),
        sa_type=UTC_DATETIME,
        sa_column_kwargs={"server_default": func.now()},
    )


def created_by_field(default: str | None = None) -> str:
    if default is None:
        return Field()
    return Field(default=default)


def deleted_at_field() -> datetime | None:
    return Field(default=None, sa_type=UTC_DATETIME)


# ---- 并发互斥 ----

# 零值 UUID，用于 alert_event 唯一索引中 coalesce(device_id) 的占位，见 database-schema.md。
# 也在 advisory lock 中用作 device_id 为空时的锁 key 占位。
NIL_UUID = "00000000-0000-0000-0000-000000000000"


def advisory_lock_key(*parts: str) -> str:
    """生成 pg_advisory_xact_lock 的 hashtext 输入。

    用冒号拼接多部分，确保不同维度组合不会 hash 碰撞——例如
    advisory_lock_key('probe', str(station_id)) 和
    advisory_lock_key('check', str(station_id)) 不会冲突。

    见 docs/database-schema.md 设计评审 Q4：同工位并发 SSH 互斥建议用
    pg_advisory_xact_lock(hashtext(...))，不建锁表。
    """
    return ":".join(parts)
