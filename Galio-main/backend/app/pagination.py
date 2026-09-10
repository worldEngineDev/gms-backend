"""列表接口通用分页参数，见 docs/architecture.md「API 设计约定」：默认 page=1/page_size=20，上限 100。"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Query


@dataclass
class Pagination:
    page: int
    page_size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def pagination_params(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Pagination:
    return Pagination(page=page, page_size=page_size)
