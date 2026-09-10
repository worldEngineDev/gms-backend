"""检测引擎接口，对照 docs/api-design.md 「2. 检测引擎」（16 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.checkpoint import service
from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.pagination import Pagination, pagination_params

router = APIRouter(tags=["checkpoint"])


class FaultTypeCreate(BaseModel):
    code: str
    name: str
    category: str
    created_by: str


class FaultTypeUpdate(BaseModel):
    name: str | None = None
    category: str | None = None


class CheckItemCreate(BaseModel):
    name: str
    device_type: str
    probe: str
    pass_criteria: dict
    access_method: str = "ssh"  # ssh|http，见 docs/architecture.md「探针脚本协议」
    params: dict | None = None
    fault_type_id: uuid.UUID | None = None
    created_by: str


class CheckItemUpdate(BaseModel):
    name: str | None = None
    device_type: str | None = None
    probe: str | None = None
    access_method: str | None = None
    params: dict | None = None
    pass_criteria: dict | None = None
    fault_type_id: uuid.UUID | None = None
    status: str | None = None


class CheckSuiteCreate(BaseModel):
    name: str
    scenario: str
    device_type: str | None = None
    created_by: str


class CheckSuiteUpdate(BaseModel):
    name: str | None = None
    scenario: str | None = None
    device_type: str | None = None
    status: str | None = None


class CheckSuiteItemsSet(BaseModel):
    check_item_ids: list[uuid.UUID]


class CheckRunTrigger(BaseModel):
    check_suite_id: uuid.UUID
    station_id: uuid.UUID
    trigger_reason: str
    created_by: str
    ticket_id: uuid.UUID | None = None
    release_id: uuid.UUID | None = None
    release_target_id: uuid.UUID | None = None
    handover_id: uuid.UUID | None = None


# ---- fault_type ----


@router.get("/fault-types")
def list_fault_types(request: Request, pagination: Pagination = Depends(pagination_params),
                      session: Session = Depends(get_session)):
    rows, total = service.list_fault_types(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/fault-types")
def create_fault_type(request: Request, body: FaultTypeCreate, session: Session = Depends(get_session)):
    return envelope(service.create_fault_type(session, **body.model_dump()), request_id=request_id(request))


@router.patch("/fault-types/{fault_type_id}")
def update_fault_type(request: Request, fault_type_id: uuid.UUID, body: FaultTypeUpdate,
                       session: Session = Depends(get_session)):
    fault_type = service.update_fault_type(session, fault_type_id, **body.model_dump())
    if fault_type is None:
        raise ApiError(40401, "fault type not found", 404)
    return envelope(fault_type, request_id=request_id(request))


@router.delete("/fault-types/{fault_type_id}")
def delete_fault_type(request: Request, fault_type_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_fault_type(session, fault_type_id):
        raise ApiError(40401, "fault type not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- check_item ----


@router.get("/check-items")
def list_check_items(request: Request, device_type: str | None = None,
                      pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_check_items(session, pagination, device_type=device_type)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/check-items")
def create_check_item(request: Request, body: CheckItemCreate, session: Session = Depends(get_session)):
    return envelope(service.create_check_item(session, **body.model_dump()), request_id=request_id(request))


@router.patch("/check-items/{item_id}")
def update_check_item(request: Request, item_id: uuid.UUID, body: CheckItemUpdate,
                       session: Session = Depends(get_session)):
    item = service.update_check_item(session, item_id, **body.model_dump())
    if item is None:
        raise ApiError(40401, "check item not found", 404)
    return envelope(item, request_id=request_id(request))


@router.delete("/check-items/{item_id}")
def delete_check_item(request: Request, item_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_check_item(session, item_id):
        raise ApiError(40401, "check item not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- check_suite ----


@router.get("/check-suites")
def list_check_suites(request: Request, scenario: str | None = None,
                       pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_check_suites(session, pagination, scenario=scenario)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/check-suites/{suite_id}")
def get_check_suite(request: Request, suite_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_check_suite_detail(session, suite_id)
    if detail is None:
        raise ApiError(40401, "check suite not found", 404)
    return envelope(detail, request_id=request_id(request))


@router.post("/check-suites")
def create_check_suite(request: Request, body: CheckSuiteCreate, session: Session = Depends(get_session)):
    return envelope(service.create_check_suite(session, **body.model_dump()), request_id=request_id(request))


@router.patch("/check-suites/{suite_id}")
def update_check_suite(request: Request, suite_id: uuid.UUID, body: CheckSuiteUpdate,
                        session: Session = Depends(get_session)):
    suite = service.update_check_suite(session, suite_id, **body.model_dump())
    if suite is None:
        raise ApiError(40401, "check suite not found", 404)
    return envelope(suite, request_id=request_id(request))


@router.delete("/check-suites/{suite_id}")
def delete_check_suite(request: Request, suite_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_check_suite(session, suite_id):
        raise ApiError(40401, "check suite not found", 404)
    return envelope(None, request_id=request_id(request))


@router.put("/check-suites/{suite_id}/items")
def set_check_suite_items(request: Request, suite_id: uuid.UUID, body: CheckSuiteItemsSet,
                           session: Session = Depends(get_session)):
    service.set_check_suite_items(session, suite_id, body.check_item_ids)
    detail = service.get_check_suite_detail(session, suite_id)
    return envelope(detail, request_id=request_id(request))


# ---- check_run：四场景复用 ----


@router.post("/check-runs")
def trigger_check_run(request: Request, body: CheckRunTrigger, session: Session = Depends(get_session)):
    run = service.trigger_check_run(session, **body.model_dump())
    return envelope(run, request_id=request_id(request))


@router.get("/check-runs")
def list_check_runs(request: Request, station_id: uuid.UUID | None = None, scenario: str | None = None,
                     conclusion: str | None = None, pagination: Pagination = Depends(pagination_params),
                     session: Session = Depends(get_session)):
    rows, total = service.list_check_runs(session, pagination, station_id=station_id, scenario=scenario,
                                           conclusion=conclusion)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/check-runs/{run_id}")
def get_check_run(request: Request, run_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_check_run_detail(session, run_id)
    if detail is None:
        raise ApiError(40401, "check run not found", 404)
    return envelope(detail, request_id=request_id(request))
