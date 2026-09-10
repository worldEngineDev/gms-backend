#!/usr/bin/env python3
"""Ansible 动态 inventory：从 PG station 表生成主机列表（host 取 station.host 字段）。

独立于 backend/ 的依赖（不 import app.*），保持端侧执行环境和服务端代码解耦，
见 docs/project-structure.md「ansible/ 独立于 backend/」。

用法：ansible-playbook -i inventory/dynamic_inventory.py playbooks/xxx.yml

注意：GALIO_INVENTORY_DSN 是给 psycopg 用的原生 DSN（postgresql://...），跟 backend 的
GALIO_DATABASE_URL（SQLAlchemy 风格 postgresql+psycopg://...）不是同一个格式，
部署时两边都要配置，容易忘掉其中一个，先在这里写清楚。
"""
from __future__ import annotations

import json
import os
import sys

import psycopg

DSN = os.environ.get("GALIO_INVENTORY_DSN", "postgresql://galio:galio@localhost:5432/galio")


def build_inventory() -> dict:
    inventory: dict = {"_meta": {"hostvars": {}}, "all": {"hosts": []}}
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            "select code, host from station "
            "where deleted_at is null and status = 'active' and host is not null"
        )
        for code, host in cur.fetchall():
            inventory["all"]["hosts"].append(host)
            inventory["_meta"]["hostvars"][host] = {"station_code": code}
    return inventory


def main() -> None:
    if "--host" in sys.argv:
        print(json.dumps({}))
        return
    print(json.dumps(build_inventory()))


if __name__ == "__main__":
    main()
