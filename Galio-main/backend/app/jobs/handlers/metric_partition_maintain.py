"""对照 docs/database-schema.md「分区与保留策略」：每日提前创建 metric 未来分区。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlmodel import Session

from app.jobs.models import Job

LOOKAHEAD_DAYS = 3


async def run(job: Job, session: Session) -> None:
    today = datetime.now(UTC).date()
    for offset in range(LOOKAHEAD_DAYS):
        day = today + timedelta(days=offset)
        next_day = day + timedelta(days=1)
        partition_name = f"metric_y{day.year}m{day.month:02d}d{day.day:02d}"
        session.execute(
            text(
                f"create table if not exists {partition_name} partition of metric "
                f"for values from (:day_start) to (:day_end)"
            ),
            {"day_start": day.isoformat(), "day_end": next_day.isoformat()},
        )
    # TODO: DROP 超期分区（明细保留 30 天）留给 partition_cleanup job，这里只负责建未来分区。
    session.commit()
