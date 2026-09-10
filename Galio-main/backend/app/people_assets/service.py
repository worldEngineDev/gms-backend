"""人员与组织资产的查询/写入逻辑。对照 docs/api-design.md 「1. 人员与组织资产」。"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlmodel import Session, select

# monitor 模块拥有 station_snapshot 表的定义，工位详情接口跨模块读取它，
# 见 docs/project-structure.md「跨模块读取」。
from app.monitor.models import StationSnapshot
from app.pagination import Pagination
from app.people_assets.models import (
    Device,
    DeviceChangeLog,
    Person,
    Shift,
    Site,
    Station,
    Zone,
    ZoneOwner,
)

# 类型别名，避免每个 soft-delete 调用点都写 Union；仅用于内部标注，不对外暴露。
SQLModelLike = Person | Site | Zone | Station | Device | Shift | ZoneOwner


def _soft_delete(session: Session, obj: SQLModelLike) -> None:
    obj.deleted_at = datetime.now(UTC)
    session.add(obj)
    session.commit()


# ---- person ----


def list_persons(session: Session, pagination: Pagination, role: str | None = None) -> tuple[list[Person], int]:
    statement = select(Person).where(Person.deleted_at.is_(None))
    if role:
        statement = statement.where(Person.primary_role == role)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_person(session: Session, *, name: str, primary_role: str, created_by: str,
                   feishu_user_id: str | None = None) -> Person:
    person = Person(name=name, primary_role=primary_role, feishu_user_id=feishu_user_id, created_by=created_by)
    session.add(person)
    session.commit()
    session.refresh(person)
    return person


def update_person(session: Session, person_id: uuid.UUID, **fields) -> Person | None:
    person = session.get(Person, person_id)
    if person is None or person.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(person, key, value)
    session.add(person)
    session.commit()
    session.refresh(person)
    return person


def delete_person(session: Session, person_id: uuid.UUID) -> bool:
    person = session.get(Person, person_id)
    if person is None or person.deleted_at is not None:
        return False
    _soft_delete(session, person)
    return True


# ---- site ----


def list_sites(session: Session, pagination: Pagination) -> tuple[list[Site], int]:
    statement = select(Site).where(Site.deleted_at.is_(None))
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_site(session: Session, *, code: str, name: str, created_by: str) -> Site:
    site = Site(code=code, name=name, created_by=created_by)
    session.add(site)
    session.commit()
    session.refresh(site)
    return site


def update_site(session: Session, site_id: uuid.UUID, **fields) -> Site | None:
    site = session.get(Site, site_id)
    if site is None or site.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(site, key, value)
    session.add(site)
    session.commit()
    session.refresh(site)
    return site


def delete_site(session: Session, site_id: uuid.UUID) -> bool:
    site = session.get(Site, site_id)
    if site is None or site.deleted_at is not None:
        return False
    _soft_delete(session, site)
    return True


# ---- zone ----


def list_zones(session: Session, pagination: Pagination, site_id: uuid.UUID | None = None) -> tuple[list[Zone], int]:
    statement = select(Zone).where(Zone.deleted_at.is_(None))
    if site_id:
        statement = statement.where(Zone.site_id == site_id)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_zone(session: Session, *, site_id: uuid.UUID, code: str, name: str, created_by: str) -> Zone:
    zone = Zone(site_id=site_id, code=code, name=name, created_by=created_by)
    session.add(zone)
    session.commit()
    session.refresh(zone)
    return zone


def update_zone(session: Session, zone_id: uuid.UUID, **fields) -> Zone | None:
    zone = session.get(Zone, zone_id)
    if zone is None or zone.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(zone, key, value)
    session.add(zone)
    session.commit()
    session.refresh(zone)
    return zone


def delete_zone(session: Session, zone_id: uuid.UUID) -> bool:
    zone = session.get(Zone, zone_id)
    if zone is None or zone.deleted_at is not None:
        return False
    _soft_delete(session, zone)
    return True


def add_zone_owner(session: Session, zone_id: uuid.UUID, person_id: uuid.UUID, seniority: str,
                    created_by: str) -> ZoneOwner:
    owner = ZoneOwner(zone_id=zone_id, person_id=person_id, seniority=seniority, created_by=created_by)
    session.add(owner)
    session.commit()
    session.refresh(owner)
    return owner


def remove_zone_owner(session: Session, zone_id: uuid.UUID, person_id: uuid.UUID) -> bool:
    statement = select(ZoneOwner).where(
        ZoneOwner.zone_id == zone_id,
        ZoneOwner.person_id == person_id,
        ZoneOwner.deleted_at.is_(None),
    )
    owner = session.exec(statement).first()
    if owner is None:
        return False
    _soft_delete(session, owner)
    return True


# ---- station ----


def list_stations(session: Session, pagination: Pagination, zone_id: uuid.UUID | None = None,
                   status: str | None = None) -> tuple[list[Station], int]:
    statement = select(Station).where(Station.deleted_at.is_(None))
    if zone_id:
        statement = statement.where(Station.zone_id == zone_id)
    if status:
        statement = statement.where(Station.status == status)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_station_detail(session: Session, station_id: uuid.UUID) -> dict | None:
    station = session.get(Station, station_id)
    if station is None or station.deleted_at is not None:
        return None
    snapshot = session.get(StationSnapshot, station_id)
    devices = session.exec(
        select(Device).where(Device.station_id == station_id, Device.deleted_at.is_(None))
    ).all()
    return {"station": station, "snapshot": snapshot, "devices": devices}


def create_station(session: Session, *, zone_id: uuid.UUID, code: str, name: str, created_by: str,
                    host: str | None = None) -> Station:
    station = Station(zone_id=zone_id, code=code, name=name, host=host, created_by=created_by)
    session.add(station)
    session.commit()
    session.refresh(station)
    return station


def update_station(session: Session, station_id: uuid.UUID, **fields) -> Station | None:
    station = session.get(Station, station_id)
    if station is None or station.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(station, key, value)
    session.add(station)
    session.commit()
    session.refresh(station)
    return station


def delete_station(session: Session, station_id: uuid.UUID) -> bool:
    station = session.get(Station, station_id)
    if station is None or station.deleted_at is not None:
        return False
    _soft_delete(session, station)
    return True


# ---- device ----


def list_devices(session: Session, pagination: Pagination, station_id: uuid.UUID | None = None,
                  type_: str | None = None, lifecycle: str | None = None) -> tuple[list[Device], int]:
    statement = select(Device).where(Device.deleted_at.is_(None))
    if station_id:
        statement = statement.where(Device.station_id == station_id)
    if type_:
        statement = statement.where(Device.type == type_)
    if lifecycle:
        statement = statement.where(Device.lifecycle == lifecycle)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_device_detail(session: Session, device_id: uuid.UUID) -> dict | None:
    device = session.get(Device, device_id)
    if device is None or device.deleted_at is not None:
        return None
    changes = session.exec(
        select(DeviceChangeLog)
        .where(DeviceChangeLog.device_id == device_id)
        .order_by(DeviceChangeLog.created_at.desc())
        .limit(20)
    ).all()
    return {"device": device, "recent_changes": changes}


def create_device(session: Session, *, station_id: uuid.UUID, sn: str, type_: str, created_by: str,
                   model: str | None = None) -> Device:
    device = Device(station_id=station_id, sn=sn, type=type_, model=model, created_by=created_by)
    session.add(device)
    session.commit()
    session.refresh(device)
    return device


def update_device(session: Session, device_id: uuid.UUID, **fields) -> Device | None:
    device = session.get(Device, device_id)
    if device is None or device.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(device, key, value)
    session.add(device)
    session.commit()
    session.refresh(device)
    return device


def delete_device(session: Session, device_id: uuid.UUID) -> bool:
    device = session.get(Device, device_id)
    if device is None or device.deleted_at is not None:
        return False
    _soft_delete(session, device)
    return True


def record_device_change(session: Session, device_id: uuid.UUID, change_type: str, created_by: str,
                          from_station_id: uuid.UUID | None = None, to_station_id: uuid.UUID | None = None,
                          note: str | None = None) -> DeviceChangeLog:
    change = DeviceChangeLog(
        device_id=device_id,
        change_type=change_type,
        from_station_id=from_station_id,
        to_station_id=to_station_id,
        note=note,
        created_by=created_by,
    )
    session.add(change)
    if change_type == "relocate" and to_station_id is not None:
        device = session.get(Device, device_id)
        if device is not None:
            device.station_id = to_station_id
            session.add(device)
    session.commit()
    session.refresh(change)
    return change


# ---- shift ----


def list_shifts(session: Session, pagination: Pagination, person_id: uuid.UUID | None = None) -> tuple[list[Shift], int]:
    statement = select(Shift).where(Shift.deleted_at.is_(None)).order_by(Shift.starts_at.desc())
    if person_id:
        statement = statement.where(Shift.person_id == person_id)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def start_shift(session: Session, *, person_id: uuid.UUID, shift_type: str, created_by: str,
                 zone_id: uuid.UUID | None = None) -> Shift:
    shift = Shift(
        person_id=person_id,
        zone_id=zone_id,
        shift_type=shift_type,
        starts_at=datetime.now(UTC),
        created_by=created_by,
    )
    session.add(shift)
    session.commit()
    session.refresh(shift)
    return shift


def end_shift(session: Session, shift_id: uuid.UUID) -> Shift | None:
    shift = session.get(Shift, shift_id)
    if shift is None or shift.deleted_at is not None:
        return None
    shift.ends_at = datetime.now(UTC)
    session.add(shift)
    session.commit()
    session.refresh(shift)
    return shift
