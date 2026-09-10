"""api 进程入口：挂载各业务模块 router。对照 docs/api-design.md（~100 个接口）。

`uvicorn app.main_api:app` 启动；worker 进程走 main_worker.py，两者共享 app/ 下同一份代码。
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth.router import router as auth_router
from app.checkpoint.router import router as checkpoint_router
from app.collect.router import router as collect_router
from app.envelope import install_error_handlers
from app.file.router import router as file_router
from app.monitor.router import router as monitor_router
from app.notify_audit.router import router as notify_audit_router
from app.people_assets.router import router as people_assets_router
from app.release.router import router as release_router
from app.ticket.router import router as ticket_router

app = FastAPI(title="Galio API")
install_error_handlers(app)

# CORS：允许 GMS (localhost:8765) 和移动端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(people_assets_router)
app.include_router(checkpoint_router)
app.include_router(ticket_router)
app.include_router(release_router)
app.include_router(monitor_router)
app.include_router(collect_router)
app.include_router(file_router)
app.include_router(notify_audit_router)


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict:
    return {"status": "ok"}
