"""人员与组织资产接口，对照 docs/api-design.md 「1. 人员与组织资产」（27 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.pagination import Pagination, pagination_params
from app.people_assets import service

router = APIRouter(tags=["people_assets"])


# ---- 请求体 ----


class PersonCreate(BaseModel):
    name: str
    primary_role: str
    feishu_user_id: str | None = None
    created_by: str


class PersonUpdate(BaseModel):
    name: str | None = None
    primary_role: str | None = None
    status: str | None = None


class SiteCreate(BaseModel):
    code: str
    name: str
    created_by: str


class SiteUpdate(BaseModel):
    code: str | None = None
    name: str | None = None


class ZoneCreate(BaseModel):
    site_id: uuid.UUID
    code: str
    name: str
    created_by: str


class ZoneUpdate(BaseModel):
    code: str | None = None
    name: str | None = None


class ZoneOwnerCreate(BaseModel):
    person_id: uuid.UUID
    seniority: str
    created_by: str


class StationCreate(BaseModel):
    zone_id: uuid.UUID
    code: str
    name: str
    host: str | None = None
    created_by: str


class StationUpdate(BaseModel):
    name: str | None = None
    host: str | None = None
    status: str | None = None


class DeviceCreate(BaseModel):
    station_id: uuid.UUID
    sn: str
    type: str
    model: str | None = None
    created_by: str


class DeviceUpdate(BaseModel):
    model: str | None = None
    lifecycle: str | None = None


class DeviceChangeCreate(BaseModel):
    change_type: str
    from_station_id: uuid.UUID | None = None
    to_station_id: uuid.UUID | None = None
    note: str | None = None
    created_by: str


class ShiftStart(BaseModel):
    person_id: uuid.UUID
    shift_type: str
    zone_id: uuid.UUID | None = None
    created_by: str


# ---- person ----


@router.get("/persons")
def list_persons(request: Request, role: str | None = None, pagination: Pagination = Depends(pagination_params),
                  session: Session = Depends(get_session)):
    rows, total = service.list_persons(session, pagination, role=role)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/persons")
def create_person(request: Request, body: PersonCreate, session: Session = Depends(get_session)):
    person = service.create_person(session, **body.model_dump())
    return envelope(person, request_id=request_id(request))


@router.patch("/persons/{person_id}")
def update_person(request: Request, person_id: uuid.UUID, body: PersonUpdate,
                   session: Session = Depends(get_session)):
    person = service.update_person(session, person_id, **body.model_dump())
    if person is None:
        raise ApiError(40401, "person not found", 404)
    return envelope(person, request_id=request_id(request))


@router.delete("/persons/{person_id}")
def delete_person(request: Request, person_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_person(session, person_id):
        raise ApiError(40401, "person not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- site ----


@router.get("/sites")
def list_sites(request: Request, pagination: Pagination = Depends(pagination_params),
               session: Session = Depends(get_session)):
    rows, total = service.list_sites(session, pagination)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/sites")
def create_site(request: Request, body: SiteCreate, session: Session = Depends(get_session)):
    site = service.create_site(session, **body.model_dump())
    return envelope(site, request_id=request_id(request))


@router.patch("/sites/{site_id}")
def update_site(request: Request, site_id: uuid.UUID, body: SiteUpdate, session: Session = Depends(get_session)):
    site = service.update_site(session, site_id, **body.model_dump())
    if site is None:
        raise ApiError(40401, "site not found", 404)
    return envelope(site, request_id=request_id(request))


@router.delete("/sites/{site_id}")
def delete_site(request: Request, site_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_site(session, site_id):
        raise ApiError(40401, "site not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- zone ----


@router.get("/zones")
def list_zones(request: Request, site_id: uuid.UUID | None = None,
                pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_zones(session, pagination, site_id=site_id)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/zones")
def create_zone(request: Request, body: ZoneCreate, session: Session = Depends(get_session)):
    zone = service.create_zone(session, **body.model_dump())
    return envelope(zone, request_id=request_id(request))


@router.patch("/zones/{zone_id}")
def update_zone(request: Request, zone_id: uuid.UUID, body: ZoneUpdate, session: Session = Depends(get_session)):
    zone = service.update_zone(session, zone_id, **body.model_dump())
    if zone is None:
        raise ApiError(40401, "zone not found", 404)
    return envelope(zone, request_id=request_id(request))


@router.delete("/zones/{zone_id}")
def delete_zone(request: Request, zone_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_zone(session, zone_id):
        raise ApiError(40401, "zone not found", 404)
    return envelope(None, request_id=request_id(request))


@router.post("/zones/{zone_id}/owners")
def add_zone_owner(request: Request, zone_id: uuid.UUID, body: ZoneOwnerCreate,
                    session: Session = Depends(get_session)):
    owner = service.add_zone_owner(session, zone_id, body.person_id, body.seniority, body.created_by)
    return envelope(owner, request_id=request_id(request))


@router.delete("/zones/{zone_id}/owners/{person_id}")
def remove_zone_owner(request: Request, zone_id: uuid.UUID, person_id: uuid.UUID,
                       session: Session = Depends(get_session)):
    if not service.remove_zone_owner(session, zone_id, person_id):
        raise ApiError(40401, "zone owner not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- station ----


@router.get("/stations")
def list_stations(request: Request, zone_id: uuid.UUID | None = None, status: str | None = None,
                   pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_stations(session, pagination, zone_id=zone_id, status=status)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/stations/{station_id}")
def get_station(request: Request, station_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_station_detail(session, station_id)
    if detail is None:
        raise ApiError(40401, "station not found", 404)
    return envelope(detail, request_id=request_id(request))


@router.post("/stations")
def create_station(request: Request, body: StationCreate, session: Session = Depends(get_session)):
    station = service.create_station(session, **body.model_dump())
    return envelope(station, request_id=request_id(request))


@router.patch("/stations/{station_id}")
def update_station(request: Request, station_id: uuid.UUID, body: StationUpdate,
                    session: Session = Depends(get_session)):
    station = service.update_station(session, station_id, **body.model_dump())
    if station is None:
        raise ApiError(40401, "station not found", 404)
    return envelope(station, request_id=request_id(request))


@router.delete("/stations/{station_id}")
def delete_station(request: Request, station_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_station(session, station_id):
        raise ApiError(40401, "station not found", 404)
    return envelope(None, request_id=request_id(request))


# ---- device ----


@router.get("/devices")
def list_devices(request: Request, station_id: uuid.UUID | None = None, type: str | None = None,
                  lifecycle: str | None = None, pagination: Pagination = Depends(pagination_params),
                  session: Session = Depends(get_session)):
    rows, total = service.list_devices(session, pagination, station_id=station_id, type_=type, lifecycle=lifecycle)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/devices/{device_id}")
def get_device(request: Request, device_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_device_detail(session, device_id)
    if detail is None:
        raise ApiError(40401, "device not found", 404)
    return envelope(detail, request_id=request_id(request))


@router.post("/devices")
def create_device(request: Request, body: DeviceCreate, session: Session = Depends(get_session)):
    payload = body.model_dump()
    payload["type_"] = payload.pop("type")
    device = service.create_device(session, **payload)
    return envelope(device, request_id=request_id(request))


@router.patch("/devices/{device_id}")
def update_device(request: Request, device_id: uuid.UUID, body: DeviceUpdate,
                   session: Session = Depends(get_session)):
    device = service.update_device(session, device_id, **body.model_dump())
    if device is None:
        raise ApiError(40401, "device not found", 404)
    return envelope(device, request_id=request_id(request))


@router.delete("/devices/{device_id}")
def delete_device(request: Request, device_id: uuid.UUID, session: Session = Depends(get_session)):
    if not service.delete_device(session, device_id):
        raise ApiError(40401, "device not found", 404)
    return envelope(None, request_id=request_id(request))


@router.post("/devices/{device_id}/changes")
def record_device_change(request: Request, device_id: uuid.UUID, body: DeviceChangeCreate,
                          session: Session = Depends(get_session)):
    change = service.record_device_change(session, device_id, **body.model_dump())
    return envelope(change, request_id=request_id(request))


# ---- shift ----


@router.get("/shifts")
def list_shifts(request: Request, person_id: uuid.UUID | None = None,
                 pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_shifts(session, pagination, person_id=person_id)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.post("/shifts")
def start_shift(request: Request, body: ShiftStart, session: Session = Depends(get_session)):
    shift = service.start_shift(session, **body.model_dump())
    return envelope(shift, request_id=request_id(request))


@router.patch("/shifts/{shift_id}/end")
def end_shift(request: Request, shift_id: uuid.UUID, session: Session = Depends(get_session)):
    shift = service.end_shift(session, shift_id)
    if shift is None:
        raise ApiError(40401, "shift not found", 404)
    return envelope(shift, request_id=request_id(request))
