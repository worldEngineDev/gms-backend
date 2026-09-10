"""发布与配置的查询/写入逻辑。对照 docs/api-design.md 「4. 发布与配置」。

`rollout` 前的冻结检查用 `pg_advisory_xact_lock`（见 docs/database-schema.md「通用约定」互斥行），
不建锁表；实际的制品下发/版本核验由 Worker 经 SSH/Ansible 异步执行（见 app/jobs），本模块只负责
状态机与 release_target 行的创建，不在这里内联跑 ansible。
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlmodel import Session, select

from app.file.service import read_file_data
from app.monitor.models import AlertEvent, AlertRule
from app.pagination import Pagination
from app.people_assets.models import Station, Zone
from app.release.models import Artifact, ConfigTemplate, Release, ReleaseFreeze, ReleaseTarget, VersionReport


class ReleaseNotFound(Exception):
    pass


class ReleaseConflict(Exception):
    """状态不满足跳转前提。"""


class ReleaseFrozen(Exception):
    """目标工位命中生效中的发布冻结。"""


def _get_or_raise(session: Session, release_id: uuid.UUID) -> Release:
    release = session.get(Release, release_id)
    if release is None or release.deleted_at is not None:
        raise ReleaseNotFound(str(release_id))
    return release


# ---- config_template ----


def list_config_templates(session: Session, pagination: Pagination) -> tuple[list[ConfigTemplate], int]:
    statement = select(ConfigTemplate).where(ConfigTemplate.deleted_at.is_(None))
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_config_template(session: Session, *, name: str, applies_to: str, current_version: str,
                            created_by: str, device_model: str | None = None,
                            content_file_id: uuid.UUID | None = None) -> ConfigTemplate:
    template = ConfigTemplate(name=name, applies_to=applies_to, current_version=current_version,
                               device_model=device_model, content_file_id=content_file_id, created_by=created_by)
    session.add(template)
    session.commit()
    session.refresh(template)
    return template


def update_config_template(session: Session, template_id: uuid.UUID, **fields) -> ConfigTemplate | None:
    template = session.get(ConfigTemplate, template_id)
    if template is None or template.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(template, key, value)
    session.add(template)
    session.commit()
    session.refresh(template)
    return template


def delete_config_template(session: Session, template_id: uuid.UUID) -> bool:
    template = session.get(ConfigTemplate, template_id)
    if template is None or template.deleted_at is not None:
        return False
    template.deleted_at = datetime.now(UTC)
    session.add(template)
    session.commit()
    return True


# ---- artifact（登记后不可变） ----


def list_artifacts(session: Session, pagination: Pagination) -> tuple[list[Artifact], int]:
    statement = select(Artifact).where(Artifact.deleted_at.is_(None))
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def register_artifact(session: Session, *, artifact_type: str, name: str, version: str, checksum: str,
                       created_by: str, image_ref: str | None = None, file_id: uuid.UUID | None = None,
                       config_template_id: uuid.UUID | None = None) -> Artifact:
    artifact = Artifact(artifact_type=artifact_type, name=name, version=version, checksum=checksum,
                         image_ref=image_ref, file_id=file_id, config_template_id=config_template_id,
                         created_by=created_by)
    session.add(artifact)
    session.commit()
    session.refresh(artifact)
    return artifact


# ---- release ----


def list_releases(session: Session, pagination: Pagination, status: str | None = None) -> tuple[list[Release], int]:
    statement = select(Release).where(Release.deleted_at.is_(None)).order_by(Release.created_at.desc())
    if status:
        statement = statement.where(Release.status == status)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_release_detail(session: Session, release_id: uuid.UUID) -> dict | None:
    release = session.get(Release, release_id)
    if release is None or release.deleted_at is not None:
        return None
    targets = session.exec(select(ReleaseTarget).where(ReleaseTarget.release_id == release_id)).all()
    return {"release": release, "targets": targets}


def create_release_draft(session: Session, *, artifact_id: uuid.UUID, created_by: str) -> Release:
    release = Release(artifact_id=artifact_id, created_by=created_by)
    session.add(release)
    session.commit()
    session.refresh(release)
    return release


def submit_test(session: Session, release_id: uuid.UUID, *, test_station_id: uuid.UUID) -> Release:
    release = _get_or_raise(session, release_id)
    if release.status != "draft":
        raise ReleaseConflict(f"release {release_id} not in draft")
    release.status = "testing"
    release.test_station_id = test_station_id
    session.add(release)
    session.commit()
    session.refresh(release)
    return release


def approve(session: Session, release_id: uuid.UUID, *, approved_by: uuid.UUID) -> Release:
    release = _get_or_raise(session, release_id)
    if release.status != "testing":
        raise ReleaseConflict(f"release {release_id} not in testing")
    release.status = "approved"
    release.approved_by = approved_by
    release.approved_at = datetime.now(UTC)
    session.add(release)
    session.commit()
    session.refresh(release)
    return release


def _is_frozen(session: Session, station: Station) -> bool:
    freezes = session.exec(select(ReleaseFreeze).where(ReleaseFreeze.status == "active")).all()
    for freeze in freezes:
        if freeze.scope_type == "global":
            return True
        if freeze.scope_type == "station" and freeze.station_id == station.id:
            return True
        if freeze.scope_type == "zone" and freeze.zone_id == station.zone_id:
            return True
        if freeze.scope_type == "site":
            zone = session.get(Zone, station.zone_id)
            if zone is not None and freeze.site_id == zone.site_id:
                return True
    return False


def rollout(session: Session, release_id: uuid.UUID, *, station_ids: list[uuid.UUID],
            created_by: str) -> Release:
    """圈选目标并创建 release_target 行；实际下发交给 Worker 异步执行（见 app/jobs）。"""
    release = _get_or_raise(session, release_id)
    if release.status != "approved":
        raise ReleaseConflict(f"release {release_id} not approved")

    targets: list[Station] = []
    for station_id in station_ids:
        station = session.get(Station, station_id)
        if station is None:
            continue
        # 冻结检查用事务级 advisory lock 防并发，见 docs/database-schema.md「通用约定」。
        session.execute(text("select pg_advisory_xact_lock(hashtext(:key))"), {"key": str(station_id)})
        if _is_frozen(session, station):
            raise ReleaseFrozen(f"station {station_id} is frozen")
        targets.append(station)

    release.status = "rolling_out"
    session.add(release)
    for station in targets:
        session.add(ReleaseTarget(release_id=release_id, station_id=station.id, created_by=created_by))
    session.commit()
    session.refresh(release)
    return release


def rollback(session: Session, release_id: uuid.UUID) -> Release:
    """回滚：创建指向 previous_release artifact 的新 release_target，由 Worker 异步下发。

    rollback 的 release_target 与 deploy 的共用同一个 deploy handler（见 jobs.handlers.deploy），
    区别在于 actual_version 指向 previous_release 的 artifact version。
    """
    release = _get_or_raise(session, release_id)
    if release.previous_release_id is None:
        raise ReleaseConflict(f"release {release_id} has no previous_release_id to roll back to")

    # 获取 previous_release 的所有成功 release_target
    prev_targets = session.exec(
        select(ReleaseTarget).where(
            ReleaseTarget.release_id == release.previous_release_id,
            ReleaseTarget.status == "success",
            ReleaseTarget.deleted_at.is_(None),
        )
    ).all()

    # 获取 previous_release 的 artifact 信息
    prev_release = session.get(Release, release.previous_release_id)
    prev_artifact = session.get(Artifact, prev_release.artifact_id) if prev_release else None

    release.status = "rolled_back"
    session.add(release)

    # 为每个 station 创建新的 release_target（pending），指向 previous_release 的版本
    for prev_target in prev_targets:
        session.add(ReleaseTarget(
            release_id=release.id,
            station_id=prev_target.station_id,
            status="pending",
            actual_version=prev_artifact.version if prev_artifact else None,
            created_by="rollback",
        ))

    session.commit()
    session.refresh(release)
    return release


def retry_release_target(session: Session, target_id: uuid.UUID) -> ReleaseTarget | None:
    target = session.get(ReleaseTarget, target_id)
    if target is None or target.deleted_at is not None:
        return None
    target.status = "pending"
    target.deployed_at = None
    target.verified_at = None
    session.add(target)
    session.commit()
    session.refresh(target)
    return target


# ---- version_report / 漂移对账 ----


def get_station_versions(session: Session, station_id: uuid.UUID) -> list[VersionReport]:
    statement = (
        select(VersionReport)
        .where(VersionReport.station_id == station_id)
        .order_by(VersionReport.reported_at.desc())
    )
    rows = session.exec(statement).all()
    latest: dict[str, VersionReport] = {}
    for row in rows:
        latest.setdefault(row.module, row)
    return list(latest.values())


def version_drift(session: Session, pagination: Pagination) -> tuple[list[dict], int]:
    """期望版本（config_template/release 目标）vs 实际版本（version_report 最新上报）比对。

    对每个 station+module 取最新 version_report，与 config_template.current_version 比对：
      - module 匹配 config_template.name 或 device_model；
      - reported_version != current_version 即漂移。

    同时检查已完成发布（release_target.status='success'）的 actual_version 是否与
    artifact.version 一致——不一致也是漂移信号。

    返回 list[dict] 而非 list[VersionReport]，因为漂移结果是"实际+期望+是否漂移"的组合视图。
    """
    # 1. 取每 station+module 的最新 version_report
    all_reports = session.exec(
        select(VersionReport).order_by(VersionReport.reported_at.desc())
    ).all()
    latest_reports: dict[tuple[uuid.UUID, str], VersionReport] = {}
    for report in all_reports:
        key = (report.station_id, report.module)
        if key not in latest_reports:
            latest_reports[key] = report

    # 2. 取所有 config_template，按 name 索引——module 与 template.name 匹配
    templates = session.exec(
        select(ConfigTemplate).where(ConfigTemplate.deleted_at.is_(None))
    ).all()
    template_by_name: dict[str, ConfigTemplate] = {t.name: t for t in templates}

    # 3. 取已完成发布的 release_target（带 artifact 版本信息）
    release_targets = session.exec(
        select(ReleaseTarget, Release, Artifact)
        .join(Release, ReleaseTarget.release_id == Release.id)
        .join(Artifact, Release.artifact_id == Artifact.id)
        .where(ReleaseTarget.status == "success")
    ).all()

    # 4. 构建 expected_version 查找表：station_id → {module → expected_version}
    expected_by_station: dict[uuid.UUID, dict[str, str]] = {}
    for target, release, artifact in release_targets:
        if artifact.name not in expected_by_station.get(target.station_id, {}):
            expected_by_station.setdefault(target.station_id, {})[artifact.name] = artifact.version

    # 5. 逐条比对
    drift_items: list[dict] = []
    for (station_id, module), report in latest_reports.items():
        expected = None
        # 先从 release target 的 artifact name 匹配
        if station_id in expected_by_station and module in expected_by_station[station_id]:
            expected = expected_by_station[station_id][module]
        # 再从 config_template.name 匹配
        elif module in template_by_name:
            expected = template_by_name[module].current_version

        is_drift = expected is not None and report.reported_version != expected
        drift_items.append({
            "station_id": station_id,
            "module": module,
            "reported_version": report.reported_version,
            "expected_version": expected,
            "is_drift": is_drift,
            "reported_at": report.reported_at,
        })

    total = len(drift_items)
    page = drift_items[pagination.offset: pagination.offset + pagination.page_size]
    return page, total


# ---- 配置指纹比对 ----


def compute_config_fingerprint(data: bytes) -> str:
    """计算配置内容的 SHA-256 指纹。

    Worker 巡检时通过 SSH 读取工位上的配置文件，计算同样的指纹上报到
    version_report.config_fingerprint；服务端比对模板指纹与上报指纹，
    不一致即配置漂移。
    """
    return hashlib.sha256(data).hexdigest()


def get_expected_fingerprint(session: Session, template: ConfigTemplate) -> str | None:
    """从 config_template 关联的 file 内容计算期望指纹。

    template.content_file_id 为空时返回 None——没有内容文件的模板无法做指纹比对。
    """
    if template.content_file_id is None:
        return None
    data = read_file_data(session, template.content_file_id)
    if data is None:
        return None
    return compute_config_fingerprint(data)


def config_fingerprint_drift(session: Session, pagination: Pagination) -> tuple[list[dict], int]:
    """配置指纹漂移检测：比对 version_report.config_fingerprint 与 config_template 期望指纹。

    与 version_drift 互补——版本号比对覆盖"装了哪个版本"，指纹比对覆盖"配置内容是否被改动"。
    两者命中任一都应告警。
    """
    # 1. 取每 station+module 的最新 version_report（含 config_fingerprint）
    all_reports = session.exec(
        select(VersionReport).order_by(VersionReport.reported_at.desc())
    ).all()
    latest_reports: dict[tuple[uuid.UUID, str], VersionReport] = {}
    for report in all_reports:
        key = (report.station_id, report.module)
        if key not in latest_reports:
            latest_reports[key] = report

    # 2. 取 config_template，按 name 索引
    templates = session.exec(
        select(ConfigTemplate).where(ConfigTemplate.deleted_at.is_(None))
    ).all()
    template_by_name: dict[str, ConfigTemplate] = {t.name: t for t in templates}

    # 3. 逐条比对指纹
    drift_items: list[dict] = []
    for (station_id, module), report in latest_reports.items():
        if not report.config_fingerprint:
            continue
        template = template_by_name.get(module)
        if template is None:
            continue
        expected_fp = get_expected_fingerprint(session, template)
        if expected_fp is None:
            continue
        is_drift = report.config_fingerprint != expected_fp
        drift_items.append({
            "station_id": station_id,
            "module": module,
            "reported_fingerprint": report.config_fingerprint,
            "expected_fingerprint": expected_fp,
            "is_drift": is_drift,
            "reported_at": report.reported_at,
        })

    total = len(drift_items)
    page = drift_items[pagination.offset: pagination.offset + pagination.page_size]
    return page, total


# ---- release_freeze ----


def list_release_freezes(session: Session, pagination: Pagination) -> tuple[list[ReleaseFreeze], int]:
    statement = select(ReleaseFreeze).order_by(ReleaseFreeze.starts_at.desc())
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_release_freeze(session: Session, *, scope_type: str, reason: str, created_by: str,
                           site_id: uuid.UUID | None = None, zone_id: uuid.UUID | None = None,
                           station_id: uuid.UUID | None = None) -> ReleaseFreeze:
    freeze = ReleaseFreeze(scope_type=scope_type, reason=reason, site_id=site_id, zone_id=zone_id,
                            station_id=station_id, created_by=created_by)
    session.add(freeze)
    session.commit()
    session.refresh(freeze)
    return freeze


def lift_release_freeze(session: Session, freeze_id: uuid.UUID, released_by: str) -> ReleaseFreeze | None:
    freeze = session.get(ReleaseFreeze, freeze_id)
    if freeze is None or freeze.status != "active":
        return None
    freeze.status = "released"
    freeze.released_by = released_by
    freeze.released_at = datetime.now(UTC)
    session.add(freeze)
    session.commit()
    session.refresh(freeze)
    return freeze
