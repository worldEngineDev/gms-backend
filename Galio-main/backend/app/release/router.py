"""发布与配置接口，对照 docs/api-design.md 「4. 发布与配置」（19 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.pagination import Pagination, pagination_params
from app.release import service
from app.release.service import ReleaseConflict, ReleaseFrozen, ReleaseNotFound

router = APIRouter(tags=["release"])


def _handle(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ReleaseNotFound as exc:
        raise ApiError(40401, "release not found", 404) from exc
    except ReleaseFrozen as exc:
        raise ApiError(40901, f"release frozen: {exc}", 409) from exc
    except ReleaseConflict as exc:
        raise ApiError(40901, f"release status conflict: {exc}", 409) from exc


class ConfigTemplateCreate(BaseModel):
    name: str
    applies_to: str
    current_version: str
    device_model: str | None = None
    content_file_id: uuid.UUID | None = None
    created_by: str


class ConfigTemplateUpdate(BaseModel):
    current_version: str | None = None
    content_file_id: uuid.UUID | None = None


class ArtifactCreate(BaseModel):
    artifact_type: str
    name: str
    version: str
    checksum: str
    image_ref: str | None = None
    file_id: uuid.UUID | None = None
    config_template_id: uuid.UUID | None = None
    created_by: str


class ReleaseDraftCreate(BaseModel):
    artifact_id: uuid.UUID
    created_by: str


class ReleaseSubmitTest(BaseModel):
    test_station_id: uuid.UUID


class ReleaseApprove(BaseModel):
    approved_by: uuid.UUID


class ReleaseRollout(BaseModel):
    station_ids: list[uuid.UUID]
    created_by: str


class ReleaseFreezeCreate(BaseModel):
    scope_type: str
    reason: str
    created_by: str
    site_id: uuid.UUID | None = None
    zone_id: uuid.UUID | None = None
    station_id: uuid.UUID | None = None


class ReleaseFreezeLift(BaseModel):
    released_by: str


# ---- config_template ----


@router.get("/config-templates")
def list_config_templates(request: Request, pagination: Pagination = Depends(pagination_params),
                           session: Session = Depends(get_session)):
    rows, total = service.list_config_templates(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/config-templates")
def create_config_template(request: Request, body: ConfigTemplateCreate, session: Session = Depends(get_session)):
    return envelope(service.create_config_template(session, **body.model_dump()), request_id=request_id(request))


@router.patch("/config-templates/{template_id}")
def update_config_template(request: Request, template_id: uuid.UUID, body: ConfigTemplateUpdate,
                            session: Session = Depends(get_session)):
    template = service.update_config_template(session, template_id, **body.model_dump())
    if template is None:
        raise ApiError(40401, "config template not found", 404)
    return envelope(template, request_id=request_id(request))


@router.delete("/config-templates/{template_id}")
def delete_config_template(request: Request, template_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_config_template(session, template_id):
        raise ApiError(40401, "config template not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- artifact ----


@router.get("/artifacts")
def list_artifacts(request: Request, pagination: Pagination = Depends(pagination_params),
                    session: Session = Depends(get_session)):
    rows, total = service.list_artifacts(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/artifacts")
def register_artifact(request: Request, body: ArtifactCreate, session: Session = Depends(get_session)):
    return envelope(service.register_artifact(session, **body.model_dump()), request_id=request_id(request))


# ---- release ----


@router.get("/releases")
def list_releases(request: Request, status: str | None = None,
                   pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_releases(session, pagination, status=status)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/releases/{release_id}")
def get_release(request: Request, release_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_release_detail(session, release_id)
    if detail is None:
        raise ApiError(40401, "release not found", 404)
    return envelope(detail, request_id=request_id(request))


@router.post("/releases")
def create_release_draft(request: Request, body: ReleaseDraftCreate, session: Session = Depends(get_session)):
    return envelope(service.create_release_draft(session, **body.model_dump()), request_id=request_id(request))


@router.post("/releases/{release_id}/submit-test")
def submit_test(request: Request, release_id: uuid.UUID, body: ReleaseSubmitTest,
                 session: Session = Depends(get_session)):
    release = _handle(service.submit_test, session, release_id, **body.model_dump())
    return envelope(release, request_id=request_id(request))


@router.post("/releases/{release_id}/approve")
def approve(request: Request, release_id: uuid.UUID, body: ReleaseApprove, session: Session = Depends(get_session)):
    release = _handle(service.approve, session, release_id, **body.model_dump())
    return envelope(release, request_id=request_id(request))


@router.post("/releases/{release_id}/rollout")
def rollout(request: Request, release_id: uuid.UUID, body: ReleaseRollout, session: Session = Depends(get_session)):
    release = _handle(service.rollout, session, release_id, **body.model_dump())
    return envelope(release, request_id=request_id(request))


@router.post("/releases/{release_id}/rollback")
def rollback(request: Request, release_id: uuid.UUID, session: Session = Depends(get_session)):
    release = _handle(service.rollback, session, release_id)
    return envelope(release, request_id=request_id(request))


@router.post("/release-targets/{target_id}/retry")
def retry_release_target(request: Request, target_id: uuid.UUID, session: Session = Depends(get_session)):
    target = service.retry_release_target(session, target_id)
    if target is None:
        raise ApiError(40401, "release target not found", 404)
    return envelope(target, request_id=request_id(request))


# ---- version_report / 漂移对账 ----


@router.get("/stations/{station_id}/versions")
def get_station_versions(request: Request, station_id: uuid.UUID, session: Session = Depends(get_session)):
    rows = service.get_station_versions(session, station_id)
    return envelope(rows, request_id=request_id(request))


@router.get("/version-drift")
def version_drift(request: Request, pagination: Pagination = Depends(pagination_params),
                   session: Session = Depends(get_session)):
    rows, total = service.version_drift(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


# ---- release_freeze ----


@router.get("/release-freezes")
def list_release_freezes(request: Request, pagination: Pagination = Depends(pagination_params),
                          session: Session = Depends(get_session)):
    rows, total = service.list_release_freezes(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/release-freezes")
def create_release_freeze(request: Request, body: ReleaseFreezeCreate, session: Session = Depends(get_session)):
    return envelope(service.create_release_freeze(session, **body.model_dump()), request_id=request_id(request))


@router.post("/release-freezes/{freeze_id}/release")
def lift_release_freeze(request: Request, freeze_id: uuid.UUID, body: ReleaseFreezeLift,
                         session: Session = Depends(get_session)):
    freeze = service.lift_release_freeze(session, freeze_id, body.released_by)
    if freeze is None:
        raise ApiError(40401, "release freeze not found or not active", 404)
    return envelope(freeze, request_id=request_id(request))
