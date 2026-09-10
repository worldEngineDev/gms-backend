"""工单调度接口，对照 docs/api-design.md 「3. 工单调度」（12 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.pagination import Pagination, pagination_params
from app.ticket import service
from app.ticket.service import TicketConflict, TicketNotFound

router = APIRouter(tags=["ticket"])


class TicketReport(BaseModel):
    station_id: uuid.UUID
    source: str
    created_by: str
    device_id: uuid.UUID | None = None
    reporter_id: uuid.UUID | None = None


class TicketTriage(BaseModel):
    fault_type_id: uuid.UUID | None = None
    fault_category: str | None = None
    actor_id: uuid.UUID | None = None
    created_by: str


class TicketDispatch(BaseModel):
    assignee_id: uuid.UUID
    actor_id: uuid.UUID | None = None
    created_by: str


class TicketActorAction(BaseModel):
    actor_id: uuid.UUID | None = None
    created_by: str


def _handle(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except TicketNotFound as exc:
        raise ApiError(40401, "ticket not found", 404) from exc
    except TicketConflict as exc:
        raise ApiError(40901, f"ticket status conflict: {exc}", 409) from exc


@router.get("/tickets")
def list_tickets(request: Request, station_id: uuid.UUID | None = None, status: str | None = None,
                  assignee_id: uuid.UUID | None = None, pagination: Pagination = Depends(pagination_params),
                  session: Session = Depends(get_session)):
    rows, total = service.list_tickets(session, pagination, station_id=station_id, status=status,
                                        assignee_id=assignee_id)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.get("/tickets/export")
def export_tickets(request: Request, station_id: uuid.UUID | None = None, status: str | None = None,
                    session: Session = Depends(get_session)):
    rows = service.export_tickets(session, station_id=station_id, status=status)
    return envelope(rows, request_id=request_id(request))


@router.get("/tickets/{ticket_id}")
def get_ticket(request: Request, ticket_id: uuid.UUID, session: Session = Depends(get_session)):
    detail = service.get_ticket_detail(session, ticket_id)
    if detail is None:
        raise ApiError(40401, "ticket not found", 404)
    return envelope(detail, request_id=request_id(request))


@router.post("/tickets")
def report_ticket(request: Request, body: TicketReport, session: Session = Depends(get_session)):
    ticket = service.report_ticket(session, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/triage")
def triage(request: Request, ticket_id: uuid.UUID, body: TicketTriage, session: Session = Depends(get_session)):
    ticket = _handle(service.triage, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/dispatch")
def dispatch(request: Request, ticket_id: uuid.UUID, body: TicketDispatch, session: Session = Depends(get_session)):
    ticket = _handle(service.dispatch, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/accept")
def accept(request: Request, ticket_id: uuid.UUID, body: TicketActorAction, session: Session = Depends(get_session)):
    ticket = _handle(service.accept, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/submit-fix")
def submit_fix(request: Request, ticket_id: uuid.UUID, body: TicketActorAction,
                session: Session = Depends(get_session)):
    ticket = _handle(service.submit_fix, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/close")
def close(request: Request, ticket_id: uuid.UUID, body: TicketActorAction, session: Session = Depends(get_session)):
    ticket = _handle(service.close, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/reject")
def reject(request: Request, ticket_id: uuid.UUID, body: TicketActorAction, session: Session = Depends(get_session)):
    ticket = _handle(service.reject, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/escalate")
def escalate(request: Request, ticket_id: uuid.UUID, body: TicketActorAction,
             session: Session = Depends(get_session)):
    ticket = _handle(service.escalate, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))


@router.post("/tickets/{ticket_id}/self-resolve")
def self_resolve(request: Request, ticket_id: uuid.UUID, body: TicketActorAction,
                  session: Session = Depends(get_session)):
    ticket = _handle(service.self_resolve, session, ticket_id, **body.model_dump())
    return envelope(ticket, request_id=request_id(request))
