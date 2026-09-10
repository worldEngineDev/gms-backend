"""探针脚本 CLI 协议的公共部分：describe/collect/check 三个子命令 + JSON 输出。

见 docs/architecture.md「探针脚本协议」。8 个探针脚本（arm/hand/glove/quest/camera/env/link/svc）
共享这一个调度器，各自只实现 describe()/collect()/check(item_id) 三个函数——随 files/probes/
整体拷贝到工位，不依赖 backend/ 的任何第三方库（FastAPI/SQLModel 等），只用标准库。
"""
from __future__ import annotations

import json
import sys
from collections.abc import Callable


def main(describe: Callable[[], dict], collect: Callable[[], dict], check: Callable[[str], dict]) -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: probe.py describe|collect|check <item_id>"}), file=sys.stderr)
        sys.exit(2)

    action = sys.argv[1]
    if action == "describe":
        result = describe()
    elif action == "collect":
        result = collect()
    elif action == "check":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "check 需要传 <item_id>"}), file=sys.stderr)
            sys.exit(2)
        result = check(sys.argv[2])
    else:
        print(json.dumps({"error": f"unknown action: {action}"}), file=sys.stderr)
        sys.exit(2)

    print(json.dumps(result))
