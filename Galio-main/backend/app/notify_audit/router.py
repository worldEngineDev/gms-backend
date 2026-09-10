"""通知与审计接口，对照 docs/api-design.md 「8. 通知与审计」（3 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from sqlmodel import Session

from app.db import get_session
from app.envelope import ApiError, envelope, paginated, request_id
from app.notify_audit import service
from app.pagination import Pagination, pagination_params

router = APIRouter(tags=["notify_audit"])


@router.get("/notifications")
def list_notifications(request: Request, status: str | None = None,
                        pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.list_notifications(session, pagination, status=status)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))


@router.patch("/notifications/{notification_id}/read")
def mark_notification_read(request: Request, notification_id: uuid.UUID, session: Session = Depends(get_session)):
    try:
        notification = service.mark_notification_read(session, notification_id)
    except NotImplementedError as exc:
        raise ApiError(50001, str(exc), 501) from exc
    return envelope(notification, request_id=request_id(request))


@router.get("/audit-logs")
def query_audit_logs(request: Request, entity_type: str | None = None, actor: str | None = None,
                      pagination: Pagination = Depends(pagination_params), session: Session = Depends(get_session)):
    rows, total = service.query_audit_logs(session, pagination, entity_type=entity_type, actor=actor)
    return envelope(paginated(rows, pagination.page, pagination.page_size, total), request_id=request_id(request))
