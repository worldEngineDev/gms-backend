"""文件接口，对照 docs/api-design.md 「7. 文件」（2 个）。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Form, Request, UploadFile
from fastapi import File as FastAPIFile
from fastapi.responses import Response
from sqlmodel import Session

from app.db import get_session
from app.envelope import ApiError, envelope, request_id
from app.file import service

router = APIRouter(tags=["file"])


@router.post("/files")
async def upload_file(request: Request, owner_type: str = Form(...), created_by: str = Form(...),
                       owner_id: uuid.UUID | None = Form(default=None),
                       upload: UploadFile = FastAPIFile(...), session: Session = Depends(get_session)):
    data = await upload.read()
    file = service.upload_file(
        session, filename=upload.filename or "unnamed", content_type=upload.content_type or "application/octet-stream",
        owner_type=owner_type, owner_id=owner_id, created_by=created_by, data=data,
    )
    return envelope(file, request_id=request_id(request))


@router.get("/files/{file_id}")
def download_file(request: Request, file_id: uuid.UUID, meta_only: bool = False,
                   session: Session = Depends(get_session)):
    file = service.get_file_meta(session, file_id)
    if file is None:
        raise ApiError(40401, "file not found", 404)
    if meta_only:
        return envelope(file, request_id=request_id(request))
    data = service.read_file_data(session, file_id)
    return Response(content=data, media_type=file.content_type,
                     headers={"Content-Disposition": f'attachment; filename="{file.filename}"'})
