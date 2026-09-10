"""直连单机的 SSH 执行封装（不经 Ansible），用于单机重试/紧急场景/node_exporter 抓取以外的即时探测。

密钥托管方案见 docs/database-schema.md 设计评审 Q5：先读本地文件路径（settings.ssh_private_key_path），
后续可扩展为 Vault/云 Secret Manager。探针只读、可被采集软件抢占——SSH 不会长时间占用端口。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import paramiko

from app.settings import settings

logger = logging.getLogger("galio.ssh")

# 默认 SSH 用户名——工位统一使用同一用户（见 docs/architecture.md「端侧执行机制」）
_DEFAULT_USER = "galio"


@dataclass
class SshResult:
    ok: bool
    stdout: str
    stderr: str
    exit_status: int


def run_command(
    host: str,
    command: str,
    *,
    timeout_seconds: int = 30,
    user: str = _DEFAULT_USER,
    key_path: str | None = None,
) -> SshResult:
    """用 paramiko 执行单条 SSH 命令，返回 stdout/stderr/exit_status。

    密钥路径优先用参数传入，否则用 settings.ssh_private_key_path。
    连接失败时返回 ok=False + stderr 带异常信息，不抛异常——调用方按 SshResult.ok 判断。
    """
    resolved_key = key_path or settings.ssh_private_key_path
    client = paramiko.SSHClient()
    # 首次连接自动接受 host key（局域网内部工位，不做严格 host key 校验）
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        connect_kwargs = {
            "hostname": host,
            "username": user,
            "timeout": timeout_seconds,
        }
        key_file = Path(resolved_key)
        if key_file.exists():
            connect_kwargs["key_filename"] = str(key_file)
        else:
            logger.warning("SSH key %s not found, trying default agent/keys", resolved_key)
        client.connect(**connect_kwargs)

        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout_seconds)
        exit_status = stdout.channel.recv_exit_status()
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return SshResult(ok=exit_status == 0, stdout=out, stderr=err, exit_status=exit_status)

    except paramiko.AuthenticationException as exc:
        msg = f"SSH auth failed for {user}@{host}: {exc}"
        logger.error(msg)
        return SshResult(ok=False, stdout="", stderr=msg, exit_status=-1)
    except paramiko.SSHException as exc:
        msg = f"SSH connection failed to {host}: {exc}"
        logger.error(msg)
        return SshResult(ok=False, stdout="", stderr=msg, exit_status=-1)
    except OSError as exc:
        msg = f"SSH network error to {host}: {exc}"
        logger.error(msg)
        return SshResult(ok=False, stdout="", stderr=msg, exit_status=-1)
    finally:
        client.close()


def run_commands(
    host: str,
    commands: list[str],
    *,
    timeout_seconds: int = 30,
    user: str = _DEFAULT_USER,
    key_path: str | None = None,
) -> list[SshResult]:
    """用同一个 SSH 会话执行多条命令（减少握手开销）。"""
    resolved_key = key_path or settings.ssh_private_key_path
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    results: list[SshResult] = []
    try:
        connect_kwargs = {"hostname": host, "username": user, "timeout": timeout_seconds}
        key_file = Path(resolved_key)
        if key_file.exists():
            connect_kwargs["key_filename"] = str(key_file)
        client.connect(**connect_kwargs)

        for command in commands:
            _stdin, stdout, stderr = client.exec_command(command, timeout=timeout_seconds)
            exit_status = stdout.channel.recv_exit_status()
            out = stdout.read().decode("utf-8", errors="replace")
            err = stderr.read().decode("utf-8", errors="replace")
            results.append(SshResult(ok=exit_status == 0, stdout=out, stderr=err, exit_status=exit_status))

    except (paramiko.AuthenticationException, paramiko.SSHException, OSError) as exc:
        msg = f"SSH connection failed to {host}: {exc}"
        logger.error(msg)
        # 所有命令标记失败
        for _ in commands:
            results.append(SshResult(ok=False, stdout="", stderr=msg, exit_status=-1))
    finally:
        client.close()

    return results
