"""低频循环：SSH/Ansible 执行设备专属探针巡检。见 docs/architecture.md「端侧执行机制」。

由 main_worker 的独立 asyncio 循环调用，频率比 poll_node_exporter 低（默认 1 分钟）。

每工位的 stdout 格式（见 ansible/playbooks/poll_device_metrics.yml）：
  {"probe":"arm","result":{"status":"ok","metrics":{"arm_status":1}}}
  {"probe":"hand","result":{"status":"unknown","metrics":{}}}
  ...

Worker 解析后：
  - probe 对应 Device.type，按 station_id + device.type 找到对应 device_id；
  - result.metrics 的每个 key/value 写入 metric 表（带 device_id）；
  - result.status 汇总写入 station_snapshot.health[probe]。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text as sa_text
from sqlmodel import select

from app.db import new_session
from app.execution import ansible_runner
from app.monitor.models import Metric, StationSnapshot
from app.people_assets.models import Device, Station
from app.settings import settings
from app.common import advisory_lock_key

logger = logging.getLogger("galio.worker.poll_device_probes")

# 探针名 → Device.type 的映射；svc 是工位级服务状态，不对应单独设备
PROBE_TO_DEVICE_TYPE: dict[str, str] = {
    "arm": "arm",
    "hand": "hand",
    "glove": "glove",
    "quest": "quest",
    "camera": "camera",
    "link": "link",
    # svc 不映射到具体设备——属于工位级
}


async def run() -> None:
    with new_session() as session:
        stations = session.exec(
            select(Station).where(Station.deleted_at.is_(None), Station.host.is_not(None))
        ).all()

    for station in stations:
        try:
            await _poll_station_direct(station)
        except Exception:
            logger.exception("poll_device_probes failed for station %s", station.id)


async def _poll_station(station: Station) -> None:
    now = datetime.now(UTC)

    # 同工位并发 SSH 互斥（设计评审 Q4）：用 advisory lock 防止巡检/检测/发布同时 SSH 同一工位
    with new_session() as session:
        session.execute(sa_text("select pg_advisory_xact_lock(hashtext(:key))"),
                        {"key": advisory_lock_key("probe", str(station.id))})
        result = ansible_runner.run_playbook(
            "poll_device_metrics.yml",
            station_hosts=[station.host],
            timeout_seconds=settings.device_probe_poll_seconds * 2,
        )

        if not result.ok:
            _record_snapshot_error(session, station.id, result.stderr[:500], now)
            return

        # 加载工位上的设备列表，按 type 索引
        devices = session.exec(
            select(Device).where(Device.station_id == station.id, Device.deleted_at.is_(None))
        ).all()
        device_by_type = _index_devices_by_type(devices)

        probe_outputs = _parse_probe_stdout(result.stdout)
        for entry in probe_outputs:
            _persist_probe_result(session, station.id, entry, device_by_type, now)

        # 汇总写入 station_snapshot
        snapshot = session.get(StationSnapshot, station.id) or StationSnapshot(station_id=station.id)
        health = dict(snapshot.health or {})
        for entry in probe_outputs:
            probe = entry.get("probe", "")
            status = entry.get("result", {}).get("status", "unknown")
            metrics = entry.get("result", {}).get("metrics", {})
            health[probe] = {"status": status, "last_checked": now.isoformat(), "metrics": metrics}
        snapshot.health = health
        snapshot.updated_at = now
        session.add(snapshot)
        session.commit()


def _parse_probe_stdout(stdout: str) -> list[dict]:
    """从 ansible playbook 的 debug 输出中提取每行 JSON。

    playbook 用 debug msg 输出多行文本，每行是一个 JSON 对象。
    ansible 的 stdout 会带一些前缀和缩进，逐行尝试 json.loads 即可。
    """
    results: list[dict] = []

    def add_value(value: object) -> None:
        """递归展开普通 JSON、Ansible debug 的 msg 字符串和 JSONL 字符串。"""
        if isinstance(value, dict):
            if "probe" in value and "result" in value:
                results.append(value)
                return
            msg = value.get("msg")
            if isinstance(msg, str):
                add_value(msg)
            return
        if isinstance(value, str):
            # msg 可能包含多个连续 JSON 对象（JSONL）。
            decoder = json.JSONDecoder()
            pos = 0
            while pos < len(value):
                while pos < len(value) and value[pos].isspace():
                    pos += 1
                if pos >= len(value):
                    break
                try:
                    parsed, end = decoder.raw_decode(value, pos)
                except json.JSONDecodeError:
                    pos += 1
                    continue
                add_value(parsed)
                pos = end

    for line in stdout.splitlines():
        line = line.strip()
        if not line or "{" not in line:
            continue
        # 先尝试从整行首个花括号解析 Ansible debug 外层对象。
        try:
            parsed = json.loads(line[line.index("{"):])
        except json.JSONDecodeError:
            # 普通 JSONL 可能带前缀，退化为从每个花括号起点尝试。
            parsed = None
            for start, char in enumerate(line):
                if char != "{":
                    continue
                try:
                    parsed = json.loads(line[start:])
                    break
                except json.JSONDecodeError:
                    continue
        if parsed is not None:
            add_value(parsed)

    # Ansible pretty-prints debug objects over multiple lines; recover the
    # escaped ``msg`` value when the outer JSON cannot be parsed line-by-line.
    for match in re.finditer(r'"msg"\s*:\s*"((?:\\.|[^"\\])*)"', stdout, re.DOTALL):
        try:
            add_value(json.loads(f'"{match.group(1)}"'))
        except json.JSONDecodeError:
            continue
    return results


def _index_devices_by_type(devices: list[Device]) -> dict[str, Device]:
    """按 type 索引设备，同类型多台时取第一台（巡检只关心是否存在+状态）。"""
    index: dict[str, Device] = {}
    for dev in devices:
        # 同类型多台只取第一台——同类型多设备的细粒度区分留到检测阶段
        if dev.type not in index:
            index[dev.type] = dev
    return index


def _persist_probe_result(session, station_id, entry: dict,
                          device_by_type: dict[str, Device], now: datetime) -> None:
    probe = entry.get("probe", "")
    result_data = entry.get("result", {})
    if not isinstance(result_data, dict):
        return

    metrics: dict = result_data.get("metrics", {})
    device_type = PROBE_TO_DEVICE_TYPE.get(probe)
    device_id = device_by_type[device_type].id if device_type and device_type in device_by_type else None

    for metric_name, metric_value in metrics.items():
        # 只写数值型指标——探针可能返回 bool/string，统一转 float
        try:
            value = float(metric_value)
        except (TypeError, ValueError):
            continue
        session.add(Metric(
            station_id=station_id,
            device_id=device_id,
            metric_name=metric_name,
            metric_value=value,
            recorded_at=now,
        ))


def _record_snapshot_error(session, station_id, error: str, now: datetime) -> None:
    snapshot = session.get(StationSnapshot, station_id) or StationSnapshot(station_id=station_id)
    snapshot.last_poll_error = error
    snapshot.updated_at = now
    session.add(snapshot)
    session.commit()


# 探针脚本本地路径
_PROBES_DIR = Path(__file__).resolve().parents[3] / "ansible" / "roles" / "probes" / "files" / "probes"
_PROBE_NAMES = ["glove", "hand", "arm", "quest", "camera", "link", "svc", "env"]


async def _poll_station_direct(station: Station) -> None:
    """直接 SSH 执行探针，不依赖 ansible。"""
    import paramiko
    from app.settings import settings

    now = datetime.now(UTC)
    host = station.host
    key_path = settings.ssh_private_key_path
    ssh_user = "we"

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        key_file = Path(key_path)
        connect_kwargs = {"hostname": host, "username": ssh_user, "timeout": 30}
        if key_file.exists():
            connect_kwargs["key_filename"] = str(key_file)
        client.connect(**connect_kwargs)
    except Exception as exc:
        with new_session() as session:
            _record_snapshot_error(session, station.id, f"SSH connect failed: {exc}", now)
        return

    try:
        # 上传探针脚本到 /tmp/probes/
        sftp = client.open_sftp()
        try:
            sftp.mkdir("/tmp/probes")
        except IOError:
            pass
        for name in _PROBE_NAMES:
            local = _PROBES_DIR / f"{name}.py"
            if local.exists():
                sftp.put(str(local), f"/tmp/probes/{name}.py")
        # 上传共享协议文件
        proto = _PROBES_DIR / "_probe_protocol.py"
        if proto.exists():
            sftp.put(str(proto), "/tmp/probes/_probe_protocol.py")
        sftp.close()

        # 执行所有探针 collect，收集 JSON 输出
        probe_outputs: list[dict] = []
        for name in _PROBE_NAMES:
            cmd = f"cd /tmp/probes && python3 {name}.py collect 2>/dev/null"
            _stdin, stdout, _stderr = client.exec_command(cmd, timeout=30)
            stdout.channel.recv_exit_status()
            out = stdout.read().decode("utf-8", errors="replace").strip()
            # 探针输出可能包含日志行，找最后一行 JSON
            data = None
            for line in reversed(out.splitlines()):
                line = line.strip()
                if line.startswith("{"):
                    try:
                        data = json.loads(line)
                        break
                    except json.JSONDecodeError:
                        continue
            if data:
                if isinstance(data, dict) and "probe" not in data:
                    data = {"probe": name, "result": data}
                probe_outputs.append(data)
            else:
                probe_outputs.append({"probe": name, "result": {"status": "unknown", "metrics": {}}})

        # 写入 metric + station_snapshot
        with new_session() as session:
            devices = session.exec(
                select(Device).where(Device.station_id == station.id, Device.deleted_at.is_(None))
            ).all()
            device_by_type = _index_devices_by_type(devices)

            for entry in probe_outputs:
                _persist_probe_result(session, station.id, entry, device_by_type, now)

            snapshot = session.get(StationSnapshot, station.id) or StationSnapshot(station_id=station.id)
            health = dict(snapshot.health or {})
            for entry in probe_outputs:
                probe = entry.get("probe", "")
                status = entry.get("result", {}).get("status", "unknown")
                metrics = entry.get("result", {}).get("metrics", {})
                health[probe] = {"status": status, "last_checked": now.isoformat(), "metrics": metrics}
            snapshot.health = health
            snapshot.last_poll_error = None
            snapshot.updated_at = now
            session.add(snapshot)
            session.commit()

    finally:
        client.close()
