"""job 表 SKIP LOCKED 调度框架。对照 docs/database-schema.md「正确性保证模式 > 定时作业防多副本重复触发」。"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlmodel import Session, select

from app.jobs.models import Job


def claim_one_job(session: Session, worker_id: str) -> Job | None:
    now = datetime.now(UTC)
    statement = (
        select(Job)
        .where(Job.status == "pending", Job.scheduled_for <= now)
        .order_by(Job.scheduled_for)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    job = session.exec(statement).first()
    if job is None:
        return None
    job.status = "claimed"
    job.claimed_by = worker_id
    job.claimed_at = now
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def finish_job(session: Session, job: Job, *, ok: bool, error: str | None = None) -> None:
    job.status = "done" if ok else "failed"
    job.error = error
    job.finished_at = datetime.now(UTC)
    session.add(job)
    session.commit()


def schedule_job(session: Session, job_type: str, *, scheduled_for: datetime | None = None,
                  created_by: str = "ingest") -> Job:
    job = Job(job_type=job_type, scheduled_for=scheduled_for or datetime.now(UTC), created_by=created_by)
    session.add(job)
    session.commit()
    session.refresh(job)
    return job
