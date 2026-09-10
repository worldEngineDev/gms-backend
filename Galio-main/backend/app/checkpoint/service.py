"""检测引擎的查询/触发逻辑。对照 docs/api-design.md 「2. 检测引擎」。"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import httpx
from sqlalchemy import delete as sa_delete
from sqlalchemy import text as sa_text
from sqlmodel import Session, select

from app.checkpoint.models import CheckItem, CheckRun, CheckRunResult, CheckSuite, CheckSuiteItem, FaultType
from app.common import advisory_lock_key
from app.execution import ansible_runner
from app.pagination import Pagination

# station.host 是发起探针执行的连接地址，见 docs/database-schema.md 取舍 8。
from app.people_assets.models import Station


def _soft_delete(session: Session, obj) -> None:
    obj.deleted_at = datetime.now(UTC)
    session.add(obj)
    session.commit()


# ---- fault_type ----


def list_fault_types(session: Session, pagination: Pagination) -> tuple[list[FaultType], int]:
    statement = select(FaultType).where(FaultType.deleted_at.is_(None))
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_fault_type(session: Session, *, code: str, name: str, category: str, created_by: str) -> FaultType:
    fault_type = FaultType(code=code, name=name, category=category, created_by=created_by)
    session.add(fault_type)
    session.commit()
    session.refresh(fault_type)
    return fault_type


def update_fault_type(session: Session, fault_type_id: uuid.UUID, **fields) -> FaultType | None:
    fault_type = session.get(FaultType, fault_type_id)
    if fault_type is None or fault_type.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(fault_type, key, value)
    session.add(fault_type)
    session.commit()
    session.refresh(fault_type)
    return fault_type


def delete_fault_type(session: Session, fault_type_id: uuid.UUID) -> bool:
    fault_type = session.get(FaultType, fault_type_id)
    if fault_type is None or fault_type.deleted_at is not None:
        return False
    _soft_delete(session, fault_type)
    return True


# ---- check_item ----


def list_check_items(session: Session, pagination: Pagination, device_type: str | None = None) -> tuple[list[CheckItem], int]:
    statement = select(CheckItem).where(CheckItem.deleted_at.is_(None))
    if device_type:
        statement = statement.where(CheckItem.device_type == device_type)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def create_check_item(session: Session, *, name: str, device_type: str, probe: str, pass_criteria: dict,
                       created_by: str, access_method: str = "ssh", params: dict | None = None,
                       fault_type_id: uuid.UUID | None = None) -> CheckItem:
    item = CheckItem(
        name=name, device_type=device_type, probe=probe, access_method=access_method, pass_criteria=pass_criteria,
        params=params or {}, fault_type_id=fault_type_id, created_by=created_by,
    )
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def update_check_item(session: Session, item_id: uuid.UUID, **fields) -> CheckItem | None:
    item = session.get(CheckItem, item_id)
    if item is None or item.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(item, key, value)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def delete_check_item(session: Session, item_id: uuid.UUID) -> bool:
    item = session.get(CheckItem, item_id)
    if item is None or item.deleted_at is not None:
        return False
    _soft_delete(session, item)
    return True


# ---- check_suite ----


def list_check_suites(session: Session, pagination: Pagination, scenario: str | None = None) -> tuple[list[CheckSuite], int]:
    statement = select(CheckSuite).where(CheckSuite.deleted_at.is_(None))
    if scenario:
        statement = statement.where(CheckSuite.scenario == scenario)
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_check_suite_detail(session: Session, suite_id: uuid.UUID) -> dict | None:
    suite = session.get(CheckSuite, suite_id)
    if suite is None or suite.deleted_at is not None:
        return None
    links = session.exec(
        select(CheckSuiteItem).where(CheckSuiteItem.check_suite_id == suite_id).order_by(CheckSuiteItem.seq)
    ).all()
    items = []
    for link in links:
        item = session.get(CheckItem, link.check_item_id)
        items.append({"seq": link.seq, "item": item})
    return {"suite": suite, "items": items}


def create_check_suite(session: Session, *, name: str, scenario: str, created_by: str,
                        device_type: str | None = None) -> CheckSuite:
    suite = CheckSuite(name=name, scenario=scenario, device_type=device_type, created_by=created_by)
    session.add(suite)
    session.commit()
    session.refresh(suite)
    return suite


def update_check_suite(session: Session, suite_id: uuid.UUID, **fields) -> CheckSuite | None:
    suite = session.get(CheckSuite, suite_id)
    if suite is None or suite.deleted_at is not None:
        return None
    for key, value in fields.items():
        if value is not None:
            setattr(suite, key, value)
    session.add(suite)
    session.commit()
    session.refresh(suite)
    return suite


def delete_check_suite(session: Session, suite_id: uuid.UUID) -> bool:
    suite = session.get(CheckSuite, suite_id)
    if suite is None or suite.deleted_at is not None:
        return False
    _soft_delete(session, suite)
    return True


def set_check_suite_items(session: Session, suite_id: uuid.UUID, item_ids: list[uuid.UUID]) -> None:
    """整体替换检测项清单（含顺序），见 docs/api-design.md 接口规划原则 5。"""
    session.execute(sa_delete(CheckSuiteItem).where(CheckSuiteItem.check_suite_id == suite_id))
    for seq, item_id in enumerate(item_ids, start=1):
        session.add(CheckSuiteItem(check_suite_id=suite_id, check_item_id=item_id, seq=seq))
    session.commit()


# ---- check_run：四场景（体检/验收/发布核验/交接）复用同一组函数 ----


def _run_http_check_item(station: Station, item: CheckItem) -> dict:
    """access_method='http' 的检测项：直接 HTTP 调用工位本机暴露的状态接口，不经 SSH。

    见 docs/architecture.md「探针脚本协议」。`params` 约定 `{"port": int, "path": str}`；
    响应体按 `pass_criteria` 逐字段相等匹配——只做最简单直接的匹配，范围/正则这类更复杂的判定
    留到实现阶段按需扩展，不在这里猜测判定规则。
    """
    port = item.params.get("port")
    path = item.params.get("path", "/")
    if not port:
        return {"result": "unknown", "evidence": {}, "suggestion": f"check_item {item.id} 缺少 params.port"}

    url = f"http://{station.host}:{port}{path}"
    try:
        response = httpx.get(url, timeout=5.0)
        response.raise_for_status()
        body = response.json()
    except httpx.HTTPError as exc:
        return {"result": "fail", "evidence": {"error": str(exc)}, "suggestion": None}

    ok = all(body.get(key) == value for key, value in (item.pass_criteria or {}).items())
    return {"result": "pass" if ok else "fail", "evidence": body, "suggestion": None}


def _parse_check_stdout(stdout: str) -> dict[str, dict]:
    """解析 run_check_suite.yml playbook 的 stdout，按 item_id 索引结果。

    playbook 用 shell 模块直接输出 JSONL，每行格式：
      {"item_id":"...","probe":"...","result":"pass|fail|unknown","evidence":{},"suggestion":"..."}
    ansible stdout 含框架行，逐行尝试 json.loads 即可。
    """
    results: dict[str, dict] = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line or "{" not in line:
            continue
        brace_start = line.index("{")
        json_fragment = line[brace_start:]
        try:
            parsed = json.loads(json_fragment)
            if isinstance(parsed, dict) and "item_id" in parsed:
                results[parsed["item_id"]] = parsed
        except json.JSONDecodeError:
            continue
    return results


def trigger_check_run(session: Session, *, check_suite_id: uuid.UUID, station_id: uuid.UUID,
                       trigger_reason: str, created_by: str, ticket_id: uuid.UUID | None = None,
                       release_id: uuid.UUID | None = None, release_target_id: uuid.UUID | None = None,
                       handover_id: uuid.UUID | None = None) -> CheckRun:
    run = CheckRun(
        check_suite_id=check_suite_id, station_id=station_id, trigger_reason=trigger_reason,
        ticket_id=ticket_id, release_id=release_id, release_target_id=release_target_id,
        handover_id=handover_id, created_by=created_by,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    station = session.get(Station, station_id)
    if station is None or not station.host:
        run.conclusion = "fail"
        run.finished_at = datetime.now(UTC)
        session.add(run)
        session.commit()
        session.refresh(run)
        return run

    # 按 access_method 分组：ssh 走 Ansible playbook，http 直接调工位本机的状态接口，
    # 同一个 check_suite 里两种检测项可以混用，见 docs/database-schema.md 设计评审「取舍 9」。
    links = session.exec(select(CheckSuiteItem).where(CheckSuiteItem.check_suite_id == check_suite_id)).all()
    items = [item for link in links if (item := session.get(CheckItem, link.check_item_id)) is not None]
    ssh_items = [item for item in items if item.access_method == "ssh"]
    http_items = [item for item in items if item.access_method == "http"]

    all_ok = True

    if ssh_items:
        # 同工位并发 SSH 互斥（Q4），与巡检/发布共享同一个 station 级锁
        session.execute(sa_text("select pg_advisory_xact_lock(hashtext(:key))"),
                        {"key": advisory_lock_key("check", str(station_id))})
        result = ansible_runner.run_playbook(
            "run_check_suite.yml",
            station_hosts=[station.host],
            extra_vars={"check_suite_id": str(check_suite_id), "check_run_id": str(run.id),
                        "check_items_json": json.dumps([
                            {"probe": item.probe, "item_id": str(item.id)} for item in ssh_items
                        ])},
        )
        # 解析 stdout 中每行 JSON，按 item_id 逐条写 CheckRunResult
        item_results = _parse_check_stdout(result.stdout) if result.ok else {}
        for item in ssh_items:
            outcome = item_results.get(str(item.id))
            if outcome is not None:
                item_result = outcome.get("result", "unknown")
                evidence = outcome.get("evidence", {})
                suggestion = outcome.get("suggestion")
            else:
                item_result = "fail"
                evidence = {"stderr": result.stderr[-2000:]} if result.stderr else {}
                suggestion = None
            all_ok = all_ok and item_result == "pass"
            session.add(CheckRunResult(
                check_run_id=run.id, check_item_id=item.id, result=item_result,
                evidence=evidence, suggestion=suggestion, created_by=created_by,
            ))

    for item in http_items:
        outcome = _run_http_check_item(station, item)
        all_ok = all_ok and outcome["result"] == "pass"
        session.add(CheckRunResult(
            check_run_id=run.id, check_item_id=item.id, result=outcome["result"],
            evidence=outcome["evidence"], suggestion=outcome["suggestion"], created_by=created_by,
        ))

    run.conclusion = "pass" if all_ok else "fail"
    run.finished_at = datetime.now(UTC)
    session.add(run)
    session.commit()
    session.refresh(run)
    return run


def list_check_runs(session: Session, pagination: Pagination, station_id: uuid.UUID | None = None,
                     scenario: str | None = None, conclusion: str | None = None) -> tuple[list[CheckRun], int]:
    statement = select(CheckRun).where(CheckRun.deleted_at.is_(None)).order_by(CheckRun.started_at.desc())
    if station_id:
        statement = statement.where(CheckRun.station_id == station_id)
    if conclusion:
        statement = statement.where(CheckRun.conclusion == conclusion)
    if scenario:
        statement = statement.join(CheckSuite, CheckSuite.id == CheckRun.check_suite_id).where(
            CheckSuite.scenario == scenario
        )
    total = len(session.exec(statement).all())
    rows = session.exec(statement.offset(pagination.offset).limit(pagination.page_size)).all()
    return rows, total


def get_check_run_detail(session: Session, run_id: uuid.UUID) -> dict | None:
    run = session.get(CheckRun, run_id)
    if run is None or run.deleted_at is not None:
        return None
    results = session.exec(select(CheckRunResult).where(CheckRunResult.check_run_id == run_id)).all()
    return {"run": run, "results": results}
