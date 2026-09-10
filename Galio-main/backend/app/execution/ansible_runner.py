"""SSH/Ansible 执行封装，供 checkpoint/release/jobs 调用。playbook 内容见顶层 ansible/ 目录。

见 docs/architecture.md「端侧执行机制」：服务端 Worker 主动连接工位，不存在端侧常驻 Agent。
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from app.settings import settings


@dataclass
class PlaybookResult:
    ok: bool
    stdout: str
    stderr: str
    return_code: int


def run_playbook(playbook: str, *, station_hosts: list[str], extra_vars: dict | None = None,
                  timeout_seconds: int = 120) -> PlaybookResult:
    """同步跑一次 ansible-playbook。

    TODO: SSH 密钥托管方案未定（见 docs/database-schema.md 设计评审 Q5），这里先假设私钥路径
    由 settings.ssh_private_key_path 给出；同工位并发会话的互斥（Q4，建议用
    pg_advisory_xact_lock）留给调用方（jobs/checkpoint/release 的 service 层）处理，
    本函数只负责单次执行，不做锁。
    """
    if not station_hosts:
        return PlaybookResult(ok=False, stdout="", stderr="no target hosts", return_code=1)

    project_dir = Path(settings.ansible_project_dir)
    inventory = ",".join(station_hosts) + ","
    cmd = [
        "ansible-playbook",
        str(project_dir / "playbooks" / playbook),
        "-i", inventory,
        "--private-key", settings.ssh_private_key_path,
    ]
    for key, value in (extra_vars or {}).items():
        cmd += ["-e", f"{key}={value}"]

    try:
        completed = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=timeout_seconds,
        )
    except OSError as exc:
        # ansible-playbook 没装/不可执行（比如跑在只装了 api 依赖、没装 ansible-core 的进程里）
        # 或 subprocess 本身起不来——按检测失败处理，不让调用方收到未捕获异常，
        # 见 docs/database-schema.md 设计评审 Q4/Q5 附近对执行环境的假设。
        return PlaybookResult(ok=False, stdout="", stderr=f"failed to launch ansible-playbook: {exc}", return_code=127)
    except subprocess.TimeoutExpired as exc:
        return PlaybookResult(ok=False, stdout=exc.stdout or "", stderr=f"timed out after {timeout_seconds}s",
                               return_code=124)

    return PlaybookResult(
        ok=completed.returncode == 0,
        stdout=completed.stdout,
        stderr=completed.stderr,
        return_code=completed.returncode,
    )
