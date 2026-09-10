"""worker 进程入口：job 表 SKIP LOCKED 认领循环 + 两条独立频率的巡检循环。

见 docs/architecture.md「端侧执行机制」「服务端核心模块」。`python -m app.main_worker` 启动；
api 进程走 main_api.py，两者共享 app/ 下同一份代码，都不持有跨请求/跨轮次的业务状态。
"""
from __future__ import annotations

import asyncio
import logging
import socket

from app.db import new_session
from app.jobs import handlers, scheduler
from app.settings import settings

logger = logging.getLogger("galio.worker")

WORKER_ID = f"{socket.gethostname()}:{__name__}"

JOB_HANDLERS = {
    "metric_partition_maintain": handlers.metric_partition_maintain.run,
    "alert_evaluate": handlers.alert_evaluate.run,
    "notification_dispatch": handlers.notification_dispatch.run,
    "version_reconcile": handlers.version_reconcile.run,
    "partition_cleanup": handlers.partition_cleanup.run,
}


async def job_loop() -> None:
    while True:
        try:
            with new_session() as session:
                job = scheduler.claim_one_job(session, WORKER_ID)
                if job is None:
                    await asyncio.sleep(settings.job_loop_idle_seconds)
                    continue
                handler = JOB_HANDLERS.get(job.job_type)
                try:
                    if handler is None:
                        raise ValueError(f"unknown job_type: {job.job_type}")
                    await handler(job, session)
                    scheduler.finish_job(session, job, ok=True)
                except Exception as exc:
                    logger.exception("job %s (%s) failed", job.id, job.job_type)
                    scheduler.finish_job(session, job, ok=False, error=str(exc))
        except Exception:
            # claim_one_job 本身失败(比如 postgres 还没起来、连接瞬断)不该拖垮整个 worker 进程——
            # asyncio.gather 里一个任务抛出未捕获异常会连累其它两条巡检循环一起退出。
            logger.exception("job_loop iteration failed (db unavailable?)")
            await asyncio.sleep(settings.job_loop_idle_seconds)


async def node_exporter_poll_loop() -> None:
    """高频：见 docs/architecture.md「主机基础指标」。"""
    while True:
        try:
            await handlers.poll_node_exporter.run()
        except Exception:
            logger.exception("node_exporter poll loop failed")
        await asyncio.sleep(settings.node_exporter_poll_seconds)


async def device_probe_poll_loop() -> None:
    """低频：SSH 执行设备探针巡检。"""
    while True:
        try:
            await handlers.poll_device_probes.run()
        except Exception:
            logger.exception("device probe poll loop failed")
        await asyncio.sleep(settings.device_probe_poll_seconds)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    await asyncio.gather(
        job_loop(),
        node_exporter_poll_loop(),
        device_probe_poll_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
