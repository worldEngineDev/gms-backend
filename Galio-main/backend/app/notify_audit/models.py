"""通知与审计：notification / audit_log。对照 docs/database-schema.md 「11. 定时作业与通知」「12. 审计日志」。

`job` 表（定时作业调度框架）没有对外接口，模型放在 app/jobs/models.py，不在这里。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from app.common import UTC_DATETIME, created_at_field, created_by_field, id_field


class Notification(SQLModel, table=True):
    __tablename__ = "notification"

    id: uuid.UUID = id_field()
    channel: str  # feishu_group|feishu_dm|feishu_urgent_call|web|kiosk（urgent_sms 仅为旧数据兼容）
    target: str  # 群 id / 用户 id 等，弱关联无 FK
    template: str
    payload: dict = Field(sa_column=Column(JSON))
    priority: str = "normal"  # p0|p1|p2|normal
    status: str = "pending"  # pending|sending|sent|failed
    attempt_count: int = 0
    last_error: str | None = None
    claimed_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    sent_at: datetime | None = Field(default=None, sa_type=UTC_DATETIME)
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()


class AuditLog(SQLModel, table=True):
    """不可变日志，不设 deleted_at。"""

    __tablename__ = "audit_log"

    id: uuid.UUID = id_field()
    actor: str
    action: str  # 'release.publish' / 'ticket.transition' / 'config.push' ...
    entity_type: str
    entity_id: uuid.UUID | None = None  # 弱关联，无 FK
    request_id: str | None = None
    detail: dict | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = created_at_field()
