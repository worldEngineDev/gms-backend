#!/usr/bin/env python3
"""主机环境探针：内核版本、依赖包清单、镜像一致性。

磁盘/CPU/内存已由 node_exporter 覆盖，这里不重复采（见 docs/architecture.md「主机基础指标」）。
内核版本用标准库 platform 真实读取；依赖包清单/镜像一致性核验留到实现阶段接线。
"""
from __future__ import annotations

import platform

from _probe_protocol import main


def describe() -> dict:
    return {
        "device_type": "env",
        "metrics": ["kernel_version", "image_checksum_match"],
        "check_items": ["env_image_consistent"],
    }


def collect() -> dict:
    return {"status": "ok", "metrics": {"kernel_version": platform.release()}}


def check(item_id: str) -> dict:
    # TODO: 镜像一致性核验需要目标 checksum（发布流程下发），当前先返回 unknown。
    return {"result": "unknown", "evidence": {"kernel_version": platform.release()}, "suggestion": None}


if __name__ == "__main__":
    main(describe, collect, check)
