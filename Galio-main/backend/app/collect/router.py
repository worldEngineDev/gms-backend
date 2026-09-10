"""采集业务与班次交接接口，对照 docs/api-design.md 「6. 采集业务与班次交接」（10 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.collect import service
from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.pagination import Pagination, pagination_params

router = APIRouter(tags=["collect"])


class CollectTaskStart(BaseModel):
    station_id: uuid.UUID
    person_id: uuid.UUID
    task_name: str
    created_by: str


class CollectTaskEvent(BaseModel):
    event_type: str
    created_by: str
    convert_to_ticket: bool = False
    detail: dict | None = None


class HandoverCreate(BaseModel):
    zone_id: uuid.UUID
    from_shift_id: uuid.UUID
    created_by: str
    to_shift_id: uuid.UUID | None = None


class HandoverConfirm(BaseModel):
    confirmed_by: uuid.UUID


# ---- collect_task ----


@router.get("/collect-tasks")
def list_collect_tasks(request: Request, station_id: uuid.UUID | None = None, person_id: uuid.UUID | None = None,
                        pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_collect_tasks(session, pagination, station_id=station_id, person_id=person_id)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/collect-tasks")
def start_collect_task(request: Request, body: CollectTaskStart, session: Session = Depends(get_session)):
    task = service.start_collect_task(session, **body.model_dump())
    return envelope(task, request_id=request_id(request))


@router.post("/collect-tasks/{task_id}/end")
def end_collect_task(request: Request, task_id: uuid.UUID, session: Session = Depends(get_session)):
    task = service.end_collect_task(session, task_id)
    if task is None:
        raise ApiError(40401, "collect task not found", 404)
    return envelope(task, request_id=request_id(request))


@router.post("/collect-tasks/{task_id}/events")
def report_collect_task_event(request: Request, task_id: uuid.UUID, body: CollectTaskEvent,
                               session: Session = Depends(get_session)):
    result = service.report_collect_task_event(session, task_id, **body.model_dump())
    if result["task"] is None:
        raise ApiError(40401, "collect task not found", 404)
    return envelope(result, request_id=request_id(request))


# ---- handover ----


@router.get("/handovers")
def list_handovers(request: Request, zone_id: uuid.UUID | None = None,
                    pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_handovers(session, pagination, zone_id=zone_id)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/handovers/{handover_id}")
def get_handover(request: Request, handover_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_handover_detail(session, handover_id)
    if detail is None:
        raise ApiError(40401, "handover not found", 404)
    return envelope(detail, request_id=request_id(request))


@router.post("/handovers")
def create_handover(request: Request, body: HandoverCreate, session: Session = Depends(get_session)):
    handover = service.create_handover(session, **body.model_dump())
    return envelope(handover, request_id=request_id(request))


@router.post("/handovers/{handover_id}/items/{station_id}/confirm")
def confirm_handover_item(request: Request, handover_id: uuid.UUID, station_id: uuid.UUID,
                           session: Session = Depends(get_session)):
    item = service.confirm_handover_item(session, handover_id, station_id)
    if item is None:
        raise ApiError(40401, "handover item not found", 404)
    return envelope(item, request_id=request_id(request))


@router.post("/handovers/{handover_id}/confirm")
def confirm_handover(request: Request, handover_id: uuid.UUID, body: HandoverConfirm,
                      session: Session = Depends(get_session)):
    handover = service.confirm_handover(session, handover_id, body.confirmed_by)
    if handover is None:
        raise ApiError(40401, "handover not found", 404)
    return envelope(handover, request_id=request_id(request))


@router.post("/handovers/{handover_id}/escalate")
def escalate_handover(request: Request, handover_id: uuid.UUID, session: Session = Depends(get_session)):
    handover = service.escalate_handover(session, handover_id)
    if handover is None:
        raise ApiError(40401, "handover not found", 404)
    return envelope(handover, request_id=request_id(request))
