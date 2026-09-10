"""文件：file / file_chunk（bytea 分块存储）。对照 docs/database-schema.md 「2. 文件」。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import LargeBinary
from sqlmodel import Field, SQLModel

from app.common import created_at_field, created_by_field, deleted_at_field, id_field

CHUNK_SIZE_BYTES = 32 * 1024 * 1024  # 32MB，见 database-schema.md file_chunk.chunk_size_bytes 上限


class File(SQLModel, table=True):
    __tablename__ = "file"

    id: uuid.UUID = id_field()
    filename: str
    content_type: str
    total_size_bytes: int
    chunk_count: int
    owner_type: str  # ticket_evidence|check_run_evidence|log_archive|artifact_package|
    # config_template|handover_attachment
    owner_id: uuid.UUID | None = None  # 弱关联，无 FK；上传时对象可能尚未创建
    created_at: datetime = created_at_field()
    created_by: str = created_by_field()
    deleted_at: datetime | None = deleted_at_field()


class FileChunk(SQLModel, table=True):
    __tablename__ = "file_chunk"

    file_id: uuid.UUID = Field(foreign_key="file.id", primary_key=True)
    chunk_index: int = Field(primary_key=True)
    chunk_size_bytes: int
    data: bytes = Field(sa_type=LargeBinary)
