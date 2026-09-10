"""对照 docs/database-schema.md「分区与保留策略」：DROP 超期的 metric / metric_hourly_agg 分区。"""
from __future__ import annotations

from sqlmodel import Session

from app.jobs.models import Job


async def run(job: Job, session: Session) -> None:
    # TODO: 查 information_schema/pg_inherits 找出超过保留期（metric 30 天 / metric_hourly_agg 1 年）
    # 的分区表名，逐个 DROP TABLE。先占位，避免在脚手架阶段直接执行破坏性 DDL。
    return None
