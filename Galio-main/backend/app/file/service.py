"""文件上传/下载。对照 docs/api-design.md 「7. 文件」。分块是存储实现细节，不对外暴露分块级接口。"""
from __future__ import annotations

import uuid

from sqlmodel import Session, select

from app.file.models import CHUNK_SIZE_BYTES, File, FileChunk


def upload_file(session: Session, *, filename: str, content_type: str, owner_type: str, created_by: str,
                 data: bytes, owner_id: uuid.UUID | None = None) -> File:
    chunks = [data[i:i + CHUNK_SIZE_BYTES] for i in range(0, len(data), CHUNK_SIZE_BYTES)] or [b""]
    file = File(
        filename=filename, content_type=content_type, total_size_bytes=len(data), chunk_count=len(chunks),
        owner_type=owner_type, owner_id=owner_id, created_by=created_by,
    )
    session.add(file)
    session.commit()
    session.refresh(file)

    for index, chunk in enumerate(chunks):
        session.add(FileChunk(file_id=file.id, chunk_index=index, chunk_size_bytes=len(chunk), data=chunk))
    session.commit()
    return file


def get_file_meta(session: Session, file_id: uuid.UUID) -> File | None:
    file = session.get(File, file_id)
    if file is None or file.deleted_at is not None:
        return None
    return file


def read_file_data(session: Session, file_id: uuid.UUID) -> bytes | None:
    file = get_file_meta(session, file_id)
    if file is None:
        return None
    chunks = session.exec(
        select(FileChunk).where(FileChunk.file_id == file_id).order_by(FileChunk.chunk_index)
    ).all()
    return b"".join(chunk.data for chunk in chunks)
