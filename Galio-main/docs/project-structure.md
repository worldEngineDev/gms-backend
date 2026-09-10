# Galio 目录结构规划

基于 [docs/architecture.md](architecture.md) 的技术选型（Python + uv + FastAPI + SQLModel 模块化单体，api/worker 共享代码；Ansible + OpenSSH 端侧执行；React 19 + TypeScript + Ant Design 前端；docker compose 部署）和 [docs/api-design.md](api-design.md) 的 9 个接口模块，规划仓库目录结构。当前仓库处于设计评审阶段，本文档指导后续脚手架搭建，不代表已有代码。

## 目录

- [顶层结构](#顶层结构)
- [backend/：服务端（api + worker 共享代码库）](#backend服务端api--worker-共享代码库)
- [ansible/：端侧执行内容](#ansible端侧执行内容)
- [frontend/：Web 控制台 + 工位端](#frontendweb-控制台--工位端)
- [docker/：镜像与编排](#docker镜像与编排)
- [模块对照表](#模块对照表)

## 顶层结构

```
Galio/
├── README.md
├── CLAUDE.md
├── docs/                    # 已有：architecture.md / database-schema.md / api-design.md / project-structure.md
├── backend/                 # Python：api + worker 共享同一代码库（模块化单体）
├── ansible/                 # 端侧执行：playbook + 探针脚本，Worker 通过它连工位
├── frontend/                # React 19 + TypeScript + Ant Design：Web 控制台 + 工位端 kiosk
├── docker/                  # Dockerfile（api/worker/frontend）
├── docker-compose.yml       # nginx/traefik + api×N + worker×N + postgres + registry
└── .env.example             # compose 用到的环境变量样例（数据库连接、SSH 私钥路径等）
```

只有这 5 个一级目录（不算 docs），对应架构里明确的三个可独立部署单元（服务端代码 / 端侧执行内容 / 前端）+ 部署编排；不预留 `packages/`、`libs/`、`shared/` 这类给"未来可能拆分"用的空目录——现在没有第二个服务端项目要共享代码，就不需要 monorepo 工作区工具。

## backend/：服务端（api + worker 共享代码库）

```
backend/
├── pyproject.toml
├── uv.lock
├── alembic.ini
├── migrations/
│   └── versions/            # alembic 迁移脚本，对应 database-schema.md 的 DDL
├── app/
│   ├── main_api.py          # FastAPI 入口（api 进程），挂载各模块 router
│   ├── main_worker.py       # worker 入口：轮询 job 表 + 高频 node_exporter 抓取循环
│   ├── settings.py          # 环境变量配置
│   ├── db.py                # SQLModel engine/session
│   ├── envelope.py          # 统一响应信封 {code,message,request_id,data} 中间件/异常处理器
│   │
│   ├── auth/                # API模块9：认证与当前用户
│   ├── people_assets/       # API模块1：人员与组织资产（person/site/zone/zone_owner/station/device/device_change_log/shift）
│   ├── checkpoint/          # API模块2：检测引擎（check_item/check_suite/check_suite_item/check_run/check_run_result）
│   ├── ticket/               # API模块3：工单调度（ticket/ticket_event/fault_type）
│   ├── release/             # API模块4：发布与配置（config_template/artifact/release/release_target/version_report/release_freeze）
│   ├── monitor/             # API模块5：监控与告警（metric/metric_hourly_agg/station_snapshot/alert_rule/alert_event）
│   ├── collect/             # API模块6：采集业务与班次交接（collect_task/handover/handover_item）
│   ├── file/                 # API模块7：文件（file/file_chunk）
│   ├── notify_audit/        # API模块8：通知与审计（notification/audit_log）
│   │
│   ├── jobs/                 # 基础设施，非业务模块：job 表 SKIP LOCKED 调度框架
│   │   └── handlers/         # metric_partition_maintain / alert_evaluate / notification_dispatch /
│   │                         # version_reconcile / partition_cleanup / poll_node_exporter / poll_device_probes
│   └── execution/            # 基础设施，非业务模块：SSH/Ansible 执行封装，供 checkpoint/release/monitor 调用
│       ├── ssh_client.py
│       └── ansible_runner.py # 调用顶层 ansible/ 目录下的 playbook
│
└── tests/
    ├── people_assets/
    ├── checkpoint/
    ├── ticket/
    └── ...                   # 与 app/ 下业务模块一一对应
```

**每个业务模块内部固定三个文件**：`models.py`（SQLModel 表定义）、`router.py`（对应 api-design.md 该模块的接口）、`service.py`（业务逻辑，状态机模块另加 `state_machine.py`）。`jobs/` 和 `execution/` 不是业务模块，没有 router，只被业务模块的 `service.py` 调用。

**跨模块读取**：`station_snapshot` 表定义在 `monitor/models.py`（数据语义上属于监控），但 `GET /stations/{id}`（`people_assets` 模块的接口）需要聚合它——`people_assets/service.py` 直接 `import` `monitor/service.py` 的查询函数，不重复定义模型、不做跨服务 RPC。这是模块化单体里正常的模块间协作，不是架构问题。

## ansible/：端侧执行内容

```
ansible/
├── ansible.cfg
├── inventory/
│   └── dynamic_inventory.py   # 从 PG station 表生成 inventory（host 取 station.host 字段）
├── playbooks/
│   ├── poll_device_metrics.yml  # 巡检：执行探针 collect，写回 metric
│   ├── run_check_suite.yml      # 检测：执行探针 check，四场景复用
│   ├── deploy_release.yml       # 发布：推送/触发 docker pull + 版本核验
│   └── fetch_logs.yml           # 按需拉取指定日志文件
└── roles/
    └── probes/
        ├── tasks/main.yml
        └── files/probes/        # 探针脚本本体，遵循 describe/collect/check 协议
            ├── arm.py
            ├── hand.py
            ├── glove.py
            ├── quest.py
            ├── camera.py
            ├── env.py
            ├── link.py
            └── svc.py
```

探针脚本独立于 `backend/`（不随 api/worker 进程部署，而是被 Ansible 推到工位临时执行），单独放一个顶层目录，避免 backend 的 `pyproject.toml` 依赖（FastAPI/SQLModel 等）被不必要地带到工位主机的执行环境里。

## frontend/：Web 控制台 + 工位端

```
frontend/
├── package.json
├── src/
│   ├── api/            # 对接 docs/api-design.md 的接口客户端
│   ├── pages/
│   │   ├── console/    # Web 控制台：运维/组长/管理员
│   │   └── kiosk/      # 工位端 kiosk 模式：采集员报修/体检/指引
│   └── components/     # console 与 kiosk 共用的组件
```

"一套代码两种形态"体现在 `pages/console` 和 `pages/kiosk` 是同一构建产物里的两组路由，不是两个独立前端项目；具体状态管理/路由库选型不在当前设计阶段展开。

## docker/：镜像与编排

```
docker/
├── api.Dockerfile        # 运行 backend/app/main_api.py
├── worker.Dockerfile     # 运行 backend/app/main_worker.py（同一份 backend 代码，入口不同）
└── frontend.Dockerfile
```

`docker-compose.yml` 放在仓库根目录（不是 `docker/` 下），因为它编排的是跨目录的多个服务（api/worker 用 `backend/` 做 build context，frontend 用 `frontend/`），放根目录路径引用更直接。

## 模块对照表

三份文档 + 代码目录最容易出现"叫法不统一"的漂移——数据库叫一个名字，API 文档叫另一个名字，代码包又是第三个名字。这张表把 [database-schema.md](database-schema.md) 的 12 个 DDL 分组、[api-design.md](api-design.md) 的 9 个接口模块、`backend/app/` 的目录名对齐，后续新增表/接口/代码时按这张表找位置，不要另起名字：

| DDL 分组（database-schema.md） | API 模块（api-design.md） | backend 目录 |
|-|-|-|
| 1. 人员 / 3. 资产 / 4. 班次 | 人员与组织资产 | `people_assets/` |
| 2. 文件 | 文件 | `file/` |
| 5. 检测字典 / 9. 检测执行记录 | 检测引擎 | `checkpoint/` |
| 6. 工单 | 工单调度 | `ticket/` |
| 7. 发布与配置 | 发布与配置 | `release/` |
| 8. 采集业务与交接 | 采集业务与班次交接 | `collect/` |
| 10. 监控与告警 | 监控与告警 | `monitor/`（`station_snapshot` 被 `people_assets` 的工位详情接口跨模块读取，见上文） |
| 11. 定时作业与通知 | 通知与审计（通知部分）；`job` 本身无对外接口 | `notify_audit/`（通知）+ `jobs/`（`job` 调度框架，基础设施） |
| 12. 审计日志 | 通知与审计（审计部分） | `notify_audit/` |
| （无对应表） | 认证与当前用户 | `auth/` |
| （无对应表，SSH/Ansible 执行本身） | （无对应，内部机制） | `execution/`（基础设施） |
