"""SQLModel engine/session。PostgreSQL 是唯一有状态组件，见 docs/architecture.md「单一存储」。"""
from __future__ import annotations

from collections.abc import Generator

from sqlmodel import Session, create_engine

from app.settings import settings

engine = create_engine(settings.database_url, echo=settings.sql_echo)


def new_session() -> Session:
    """所有需要 Session 的地方（FastAPI 依赖、worker 循环）统一走这里，不要直接 `Session(engine)`。

    `expire_on_commit=False`：默认行为下，一次 `commit()` 之后同一个 session 里再 `commit()`
    一次（比如先写主表、再写一条事件日志各自 commit）会把第一个对象的已加载属性标记为
    "expired"——直接访问属性（`obj.status`）会触发懒加载补回来，但 Pydantic 的
    `model_dump()`/FastAPI 的 `jsonable_encoder()` 不会触发这个懒加载，会直接把它序列化成
    `{}`，返回给前端一个空对象，不报错也不好排查。这里的模型都不依赖数据库端生成的值
    （id 用 Python 端 `uuid4()`，created_at 用 Python 端 `now()`，DB 的
    `server_default`只是兜底），所以关掉 expire_on_commit 是安全的，不会读到过期数据。
    """
    return Session(engine, expire_on_commit=False)


def get_session() -> Generator[Session, None, None]:
    """FastAPI 依赖：每个请求一个 session，用完即关，进程本身不持有业务状态。"""
    with new_session() as session:
        yield session
