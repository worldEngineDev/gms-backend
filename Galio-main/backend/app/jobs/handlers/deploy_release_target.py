"""发布下发：消费 pending release_target，通过 SSH/Ansible 下发 artifact 到工位。

deploy 和 rollback 共用此 handler——区别仅在于 release_target.actual_version 指向不同版本。
见 docs/architecture.md「发布管理」。

下发方式按 artifact_type 分派：
  - image: docker pull + restart container
  - package: wget + install + restart
  - config_template: copy config file + restart service
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import text as sa_text
from sqlmodel import Session, select

from app.common import advisory_lock_key
from app.execution import ansible_runner
from app.jobs.models import Job
from app.people_assets.models import Station
from app.release.models import Artifact, Release, ReleaseTarget

logger = logging.getLogger("galio.worker.deploy")


async def run(job: Job, session: Session) -> None:
    _ = job
    # 用 SKIP LOCKED 领取 pending release_target
    targets = session.exec(
        select(ReleaseTarget)
        .where(ReleaseTarget.status == "pending", ReleaseTarget.deleted_at.is_(None))
        .order_by(ReleaseTarget.created_at)
        .with_for_update(skip_locked=True)
        .limit(10)
    ).all()

    for target in targets:
        try:
            _deploy_one(session, target)
        except Exception:
            logger.exception("deploy release_target %s failed", target.id)
            target.status = "failed"
            session.add(target)
            session.commit()


def _deploy_one(session: Session, target: ReleaseTarget) -> None:
    """下发单个 release_target。"""
    # 获取关联的 release 和 artifact
    release = session.get(Release, target.release_id)
    if release is None:
        target.status = "failed"
        session.add(target)
        session.commit()
        return

    artifact = session.get(Artifact, release.artifact_id)
    if artifact is None:
        target.status = "failed"
        session.add(target)
        session.commit()
        return

    station = session.get(Station, target.station_id)
    if station is None or station.host is None:
        target.status = "failed"
        session.add(target)
        session.commit()
        return

    # 同工位并发 SSH 互斥（Q4）
    session.execute(sa_text("select pg_advisory_xact_lock(hashtext(:key))"),
                    {"key": advisory_lock_key("deploy", str(station.id))})

    target.status = "deploying"
    session.add(target)
    session.commit()

    # 通过 Ansible 下发
    result = ansible_runner.run_playbook(
        "deploy_artifact.yml",
        station_hosts=[station.host],
        extra_vars={
            "artifact_type": artifact.artifact_type,
            "artifact_name": artifact.name,
            "artifact_version": artifact.version,
            "image_ref": artifact.image_ref or "",
            "checksum": artifact.checksum,
        },
        timeout_seconds=300,
    )

    if not result.ok:
        target.status = "failed"
        session.add(target)
        session.commit()
        return

    # 进入验证阶段
    target.status = "verifying"
    session.add(target)
    session.commit()

    # 验证：跑探针 collect 看设备是否在线
    verify_ok = _verify_deployment(station.host)
    if verify_ok:
        target.status = "success"
        target.checksum_verified = True
        target.deployed_at = datetime.now(UTC)
    else:
        target.status = "failed"

    session.add(target)
    session.commit()


def _verify_deployment(host: str) -> bool:
    """验证下发是否成功：SSH 跑探针 collect 检查设备状态。

    简化验证：只检查 SSH 可达 + 探针脚本能跑通，不做完整检测套件。
    """
    from app.execution.ssh_client import run_command

    result = run_command(
        host,
        "python3 /tmp/galio_probes/svc.py collect 2>/dev/null || echo '{\"status\":\"error\"}'",
        timeout_seconds=30,
    )
    if not result.ok:
        return False
    # 探针返回 ok 或 unknown 都算部署成功——只有 error 才算失败
    return '"error"' not in result.stdout
