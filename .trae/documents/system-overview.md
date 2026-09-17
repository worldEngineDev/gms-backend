# GMS-Backend + Galio 系统全景与运行时底层逻辑

> 生成时间：2026-09-15
> 适用版本：GMS-Backend（Node.js，44 张 MySQL 表）/ Galio（Python+FastAPI，39 张 PostgreSQL 表）
> 文档定位：把两套系统"是什么、怎么跑起来、业务闭环怎么走完"讲清楚

---

## 目录

- [一、系统定位](#一系统定位)
- [二、GMS-Backend：库存与机器台账系统](#二gms-backend库存与机器台账系统)
  - [2.1 进程模型与启动](#21-进程模型与启动)
  - [2.2 路由分发](#22-路由分发)
  - [2.3 实时通信底层](#23-实时通信底层)
  - [2.4 鉴权与权限模型](#24-鉴权与权限模型)
  - [2.5 库存 FIFO 出库](#25-库存-fifo-出库)
  - [2.6 机器绑定与左右手套约束](#26-机器绑定与左右手套约束)
  - [2.7 飞书集成](#27-飞书集成)
  - [2.8 前端架构](#28-前端架构)
  - [2.9 安全防护](#29-安全防护)
- [三、Galio：采集工位运维平台](#三galio采集工位运维平台)
  - [3.1 双进程模型](#31-双进程模型)
  - [3.2 统一响应信封](#32-统一响应信封)
  - [3.3 数据库会话与正确性模式](#33-数据库会话与正确性模式)
  - [3.4 Job 调度底层](#34-job-调度底层)
  - [3.5 监控告警闭环](#35-监控告警闭环)
  - [3.6 检测引擎执行流](#36-检测引擎执行流)
  - [3.7 工单状态机](#37-工单状态机)
  - [3.8 发布管理闭环](#38-发布管理闭环)
  - [3.9 版本对账与配置指纹](#39-版本对账与配置指纹)
  - [3.10 通知分级路由](#310-通知分级路由)
  - [3.11 端侧执行通道](#311-端侧执行通道)
- [四、两套系统关系与协作](#四两套系统关系与协作)
- [五、端侧 Agent（machine-heartbeat-agent）](#五端侧-agentmachine-heartbeat-agent)
- [六、关键文件索引](#六关键文件索引)

---

## 一、系统定位

仓库 `/home/we/gms-backend` 实际包含两个独立子系统：

| 子系统 | 路径 | 技术栈 | 业务定位 |
|-|-|-|-|
| **GMS-Backend** | 仓库根目录 | Node.js + MySQL + Redis + WS/SSE | 手套/灵巧手/夹爪**库存台账**、机器绑定、SN 注册、技术支持工单、加权排行 |
| **Galio** | `/Galio-main/` | Python + FastAPI + SQLModel + PostgreSQL | 上百个采集工位的**运维闭环**：监控告警、检测、工单、发布、班次交接 |

两者关系：
- GMS 是稳定运行的老系统，**专注资产台账**
- Galio 是新系统，目标覆盖 Overwatch 全部运维能力
- 两套无强依赖，但 Galio [main_api.py:24](file:///home/we/gms-backend/Galio-main/backend/app/main_api.py#L24) 的 CORS 已显式允许 `localhost:8765`（GMS 端口）
- GMS 移动端 [js/mobile.js:4278](file:///home/we/gms-backend/js/mobile.js#L4278) 已经在调 Galio `/stations/by-code/{code}/latest-metrics` 做工位主机状态展示

---

## 二、GMS-Backend：库存与机器台账系统

### 2.1 进程模型与启动

**启动方式**（[package.json:6-20](file:///home/we/gms-backend/package.json#L6)）：
- `npm start` / `npm run dev` → `node server.js`
- 生产：`pm2 start ecosystem.config.js`

**PM2 配置**（[ecosystem.config.js:10-48](file:///home/we/gms-backend/ecosystem.config.js#L10)）：
- 应用名 `yunwei-1`，`script: server.js`
- `exec_mode: fork`（单实例而非 cluster，实时通信依赖 Redis Pub/Sub 跨实例广播）
- `max_memory_restart: 2G`
- 注入环境变量：DB_HOST/DB_USER/DB_PASSWORD/REDIS_URL/HTTPS 等

**启动顺序**（[server.js](file:///home/we/gms-backend/server.js)）：
1. 加载配置（环境变量 + settings 表）
2. 初始化 MySQL 连接池（[L175-252](file:///home/we/gms-backend/server.js#L175)）：`mysql2/promise`，charset UTF-8，connectionLimit 10，connectTimeout 10s，启用健康检查与自动恢复
3. 初始化 Redis 客户端（Pub/Sub + 缓存）
4. 注册路由表（[src/router.js](file:///home/we/gms-backend/src/router.js)）
5. 启动 HTTP server，监听 8765
6. 启动定时任务（飞书同步、库存告警检查等）

### 2.2 路由分发

**核心**：[src/router.js:40-210](file:///home/we/gms-backend/src/router.js#L40)

- 维护两个路由表：
  - `staticRoutes: Map<string, handler>` —— 精确匹配
  - `regexRoutes: [{pattern, handler}]` —— 正则匹配（如 `/api/machines/:machineNumber/...`）
- `dispatch(req, res)` 按 method + path 查找：
  1. 先精确匹配 staticRoutes
  2. 不命中再遍历 regexRoutes
  3. 都不命中返回 404
- 中间件链：
  - 鉴权（`requireAuth` / `requireRole`）
  - 请求体校验（`bodySchema`）
  - 参数校验（`querySchema`）
  - 业务 handler

**主要 router 文件**：
- [src/handlers/auth.js](file:///home/we/gms-backend/src/handlers/auth.js) - 登录/JWT/权限校验
- [src/handlers/inventory.js](file:///home/we/gms-backend/src/handlers/inventory.js) - 库存/批次/审计
- [src/handlers/sn-registry.js](file:///home/we/gms-backend/src/handlers/sn-registry.js) - SN 全生命周期
- [src/handlers/machines.js](file:///home/we/gms-backend/src/handlers/machines.js) - 机器绑定/手套绑定/状态推算
- [src/handlers/tech-support.js](file:///home/we/gms-backend/src/handlers/tech-support.js) - 技术支持工单
- [src/handlers/users.js](file:///home/we/gms-backend/src/handlers/users.js) - 用户管理
- [src/handlers/stocktakes.js](file:///home/we/gms-backend/src/handlers/stocktakes.js) - 盘点
- [src/handlers/warehouse-transfers.js](file:///home/we/gms-backend/src/handlers/warehouse-transfers.js) - 仓库调拨

### 2.3 实时通信底层

**核心**：[src/realtime.js](file:///home/we/gms-backend/src/realtime.js) + [server.js:1167-1195](file:///home/we/gms-backend/server.js#L1167)

**双通道并存**：
- **WebSocket**：双向通信，用于实时状态同步（机器在线状态、库存数）
- **SSE (Server-Sent Events)**：单向推送，用于列表数据流（盘点进度、工单状态）

**跨实例广播**：
- PM2 多实例环境下，一个实例接收的 WS 连接和另一个实例持有的订阅可能不一致
- 通过 Redis Pub/Sub 解决：`broadcastChange(channel, payload)` 先 `redis.publish(channel, JSON)`，所有实例订阅后投递给本地持有的 WS 客户端
- 延迟 < 50ms

**核心 API**：
- `realtime.deliver(event, payload, {force: true})` - 投递事件到 SSE/WS（[server.js:1167](file:///home/we/gms-backend/server.js#L1167)）
- `broadcastSSE(event, payload)` - 仅 SSE 推送
- `broadcastChange(event, payload)` - SSE + WS 双发，并原子化失效相关缓存

**事件源**：
- inventory.js：库存调整后广播 `inventory/update`
- machines.js：机器绑定/状态变更后广播 `machines/update`、`sn_registry/update`、`transactions/update`
- tech-support.js：工单状态变更后广播 `tech_support/update`

### 2.4 鉴权与权限模型

**登录流程**（[src/handlers/auth.js:59-112](file:///home/we/gms-backend/src/handlers/auth.js#L59)）：
1. 查询 `users` 表，取 passwordHash
2. 用 scrypt 校验密码
3. 检查 status='active'，禁用账户拒绝
4. 清理该用户的旧 token
5. 生成 JWT + Session token，写入内存 token 表 + Redis（双写）
6. 返回 token + 用户上下文（role/system/customRole）

**Token 管理**（[server.js:1053-1167](file:///home/we/gms-backend/server.js#L1053)）：
- 内存 token 表与 Redis 双写
- `createToken` / `validateToken` / `invalidateUserTokens`
- 支持多端隔离、登出清理、刷新

**权限矩阵**：
- 三级内置角色：superadmin / admin / user
- 自定义角色：roles 表，data JSON 存权限定义（模块×动作×仓库范围）
- 校验方式：`requireRole('admin')` / `requirePermission('inventory', 'write', 'wh-001')`

**硬约束**（来自项目记忆）：
- 开发者界面仅 superadmin 可用
- 数据库查询只读，禁止 DROP/TRUNCATE/DELETE/UPDATE/ALTER/INSERT
- 智能助手已通过 CSS 隐藏禁用
- 密码查看：普通用户查自己，admin 查自己组员，superadmin 查所有非 superadmin
- 隐藏加权排行榜仅 yunying/tianruyu 账户可见（密码 112233）

### 2.5 库存 FIFO 出库

**双模式切换**（[src/handlers/inventory.js:106-171](file:///home/we/gms-backend/src/handlers/inventory.js#L106)）：
- `handleAdjustInventory` 根据 `categoryTrackingMode` 切换 quantity / sn 模式
- **quantity 模式**：数量台账，按批次 FIFO 扣减
- **sn 模式**：SN 全生命周期，每个 SN 独立追踪

**FIFO 批次扣减**（[src/handlers/batches.js:116-137](file:///home/we/gms-backend/src/handlers/batches.js#L116)）：
```javascript
// consumeBatchesFIFO - 按 received_at ASC, id ASC 选择最早批次
// 使用 FOR UPDATE 行锁防止并发扣减
// 扣减后写 transactions 表审计
```

**事务保证**：
- 整个出库流程在单个事务内
- 扣减 batches → 更新 inventory → 写 transactions → 写 inventory_audit → 广播 SSE
- 任一步失败整体回滚

### 2.6 机器绑定与左右手套约束

**核心**：[src/handlers/machines.js:512-660](file:///home/we/gms-backend/src/handlers/machines.js#L512) `handleSyncMachineState`

**硬约束实现**：
- 一台机器绑定一只左手（J）+ 一只右手（K）手套，缺一不可上线
- SN 第 4 位字符判断左右：J=左手，K=右手（[sn_registry](file:///home/we/gms-backend/src/handlers/sn-registry.js) 查询时解析）
- 不满足条件时返回明确错误（如"需绑定左右手各一只手套"）

**状态自动推算**：
- 离线机器 + 绑定左右两只手套 → 自动变在线
- 在线机器 + 解绑任一只手套 → 自动变离线
- 通过 `machines.status` 字段持久化

**操作流**：
1. 校验在线/离线 SN 操作合法性
2. 禁止重复绑定或异常状态 SN
3. 更新 `sn_registry`（status: available→in_use 等）
4. 同步 inventory 和 transactions 表
5. 广播 `machines/sn_registry/inventory/transactions` 事件

### 2.7 飞书集成

**文件**：[feishu.js](file:///home/we/gms-backend/feishu.js)

**能力**：
1. **多维表格同步**：把 GMS 数据定时同步到飞书多维表格（运营看板用）
2. **群机器人通知**：业务事件推送到飞书群
3. **审批回调**：接收飞书审批 webhook

**触发事件**：
- 技术支持工单创建/响应/完成 → 群机器人推卡片消息
- 机器状态异常变化 → 群机器人告警
- 库存低于阈值 → 群机器人库存预警
- 班次交接 → 飞书任务通知

### 2.8 前端架构

**目录**：[web/](file:///home/we/gms-backend/web)

**技术栈**：
- 原生 Web Components（非 React/Vue）+ TypeScript + Vite
- PWA：可安装到桌面
- TWA（Trusted Web Activity）：打包成 Android APK

**约束**：
- 个人资料页面不显示解释性提示文字（如 `<span class='form-hint'>`）
- 表单不留多余说明
- 代码风格：避免 AI 编程风（过度注释、冗余 UI 文本）

### 2.9 安全防护

- **安全响应头**：CSP / X-Frame-Options / X-Content-Type-Options 等
- **速率限制**：登录接口、API 调用频率限制
- **输入校验**：bodySchema / querySchema 强校验
- **CSRF**：双重 Cookie 模式
- **XSS**：输入转义 + 输出编码
- **密码**：scrypt（自动从 SHA-256 升级）
- **审计日志**：所有敏感操作写 audit_log

---

## 三、Galio：采集工位运维平台

### 3.1 双进程模型

Galio 是两个独立进程，共享 `app/` 下同一份代码，都不持有跨请求/跨轮次的业务状态。

**API 进程**（[app/main_api.py](file:///home/we/gms-backend/Galio-main/backend/app/main_api.py)）：
- 启动：`uvicorn app.main_api:app`
- 职责：处理 HTTP 请求，CRUD 业务对象
- 挂载 9 个 router（[L32-40](file:///home/we/gms-backend/Galio-main/backend/app/main_api.py#L32)）：
  - auth / people_assets / checkpoint / ticket / release / monitor / collect / file / notify_audit
- `/healthz` 健康检查（[L43](file:///home/we/gms-backend/Galio-main/backend/app/main_api.py#L43)）
- CORS 允许所有 origin（开发期宽松，生产应收紧）

**Worker 进程**（[app/main_worker.py](file:///home/we/gms-backend/Galio-main/backend/app/main_worker.py)）：
- 启动：`python -m app.main_worker`
- 职责：定时作业 + 巡检循环
- 三条 asyncio 循环并发（[L75-79](file:///home/we/gms-backend/Galio-main/backend/app/main_worker.py#L75)）：

| 循环 | 频率 | 职责 |
|-|-|-|
| `job_loop` | 空闲轮询（job_loop_idle_seconds） | 从 job 表 SKIP LOCKED 认领定时作业，分派到 handler |
| `node_exporter_poll_loop` | 高频（node_exporter_poll_seconds，默认 30s） | HTTP GET 工位 :9100/metrics，写主机 CPU/内存/磁盘/负载 |
| `device_probe_poll_loop` | 低频（device_probe_poll_seconds，默认 60s） | SSH/Ansible 跑设备探针，写设备状态到 station_snapshot |

**关键容错**（[L46-50](file:///home/we/gms-backend/Galio-main/backend/app/main_worker.py#L46)）：
- `job_loop` 单次迭代失败（如 PG 连接瞬断）不会拖垮整个 worker——
- `asyncio.gather` 里一个任务抛出未捕获异常会连累其它两条巡检循环一起退出，所以每条循环都包了 `try/except` + `asyncio.sleep` 重试

### 3.2 统一响应信封

**文件**：[app/envelope.py](file:///home/we/gms-backend/Galio-main/backend/app/envelope.py)

**信封结构**：
```json
{
  "code": 0,
  "message": "ok",
  "request_id": "req_xxxxxxxxxxxx",
  "data": {...}  // 或 {items, page, page_size, total} 列表
}
```

**关键 API**：
- `envelope(data, code=0, message='ok', request_id)` —— 生成信封
- `paginated(items, page, page_size, total)` —— 列表 data 形状
- `request_id(request)` —— 优先取 `X-Request-ID` 头，否则生成
- `install_error_handlers(app)` —— 把 FastAPI 默认错误也套进统一信封（[L37-64](file:///home/we/gms-backend/Galio-main/backend/app/envelope.py#L37)）：
  - `ApiError` → 业务错误信封
  - `RequestValidationError` → 422 参数校验失败
  - `StarletteHTTPException` → HTTP 异常

业务代码只需 `raise ApiError(40401, "station not found", 404)`，自动套进信封。

### 3.3 数据库会话与正确性模式

**文件**：[app/db.py](file:///home/we/gms-backend/Galio-main/backend/app/db.py)

**Session 工厂**：
- `new_session()` —— 所有需要 Session 的地方统一走这里，不直接 `Session(engine)`
- `expire_on_commit=False` —— **关键**：commit 后不把对象标记为 expired，避免 Pydantic 序列化返回空对象
- `get_session()` —— FastAPI 依赖，每请求一个 session，用完即关

**正确性模式**（PostgreSQL 原生）：
- `FOR UPDATE SKIP LOCKED` —— Job 并发认领（[scheduler.py:18](file:///home/we/gms-backend/Galio-main/backend/app/jobs/scheduler.py#L18)）
- `ON CONFLICT ... DO UPDATE` —— station_snapshot UPSERT
- `pg_advisory_xact_lock` —— 同工位发布/巡检并发互斥
- 部分唯一索引（`WHERE deleted_at IS NULL`）—— 软删后业务码可重用

**单一存储原则**：PostgreSQL 是唯一有状态组件，不引入 Redis/MinIO/MQ，api/worker 都无状态。

### 3.4 Job 调度底层

**文件**：[app/jobs/scheduler.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/scheduler.py)

**认领机制**（[L11-29](file:///home/we/gms-backend/Galio-main/backend/app/jobs/scheduler.py#L11)）：
```python
# claim_one_job
select(Job)
  .where(Job.status == "pending", Job.scheduled_for <= now)
  .order_by(Job.scheduled_for)
  .limit(1)
  .with_for_update(skip_locked=True)  # 跳过被其他 worker 锁住的行
```

- 多 worker 副本并发认领不会重复（SKIP LOCKED 跳过已锁行）
- 认领后 status='claimed'，claimed_by=worker_id（hostname + 模块名）
- handler 完成后 `finish_job` 设 status='done' 或 'failed'

**handler 分派**（[main_worker.py:20-26](file:///home/we/gms-backend/Galio-main/backend/app/main_worker.py#L20)）：

| job_type | handler | 职责 |
|-|-|-|
| `metric_partition_maintain` | [metric_partition_maintain.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/metric_partition_maintain.py) | 提前建未来月分区 |
| `alert_evaluate` | [alert_evaluate.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/alert_evaluate.py) | 评估告警规则，开/收敛 alert_event |
| `notification_dispatch` | [notification_dispatch.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/notification_dispatch.py) | 投递 notification 表 |
| `version_reconcile` | [version_reconcile.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/version_reconcile.py) | 版本对账 + 配置指纹漂移 |
| `partition_cleanup` | [partition_cleanup.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/partition_cleanup.py) | 清理过期分区 |

**失败处理**：
- handler 抛异常 → `finish_job(ok=False, error=str(exc))` → job 表 status='failed'
- 不自动重试（KISS）

### 3.5 监控告警闭环

**指标采集双路径**：

| 路径 | 频率 | 数据源 | 写入 |
|-|-|-|-|
| node_exporter HTTP | 30s | 工位 `:9100/metrics` | metric 表 + station_snapshot |
| 设备探针 SSH/Ansible | 60s | 工位探针脚本 stdout | metric 表 + station_snapshot.health |

**station_snapshot UPSERT**：
- 每工位一行，是 Agent push 与 Worker pull 的汇聚点
- node_exporter 写 `status / last_poll_status / last_poll_error`
- 设备探针写 `health->'glove'|'hand'|'arm'|...` 各子键
- 二者通过 UPSERT 自然合流，不冲突

**告警评估**（[alert_evaluate.py:47-248](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/alert_evaluate.py#L47)）：

按 `rule_type` 分派 4 种评估逻辑：
- `threshold` —— 最新 metric vs 阈值（如 CPU>90%）
- `status_change` —— 设备状态变更（如在线→离线）
- `heartbeat_lost` —— 心跳超时（last_polled_at 超过阈值）
- `frame_drop_rate` —— 掉帧率超阈值（采集业务上报）

**去重收敛**：
- 唯一约束 `(alert_rule_id, station_id, COALESCE(device_id, zero-uuid))` where status='open'
- 已有 open 事件 → occurrence_count += 1，不新开
- 事件 resolved → 唯一约束失效，可再次开新事件

**auto_create_ticket**：
- alert_rule.auto_create_ticket=true 时，开 alert_event 同时创建 ticket（source='alert_auto'）

### 3.6 检测引擎执行流

**核心**：[app/checkpoint/service.py:227-301](file:///home/we/gms-backend/Galio-main/backend/app/checkpoint/service.py#L227) `trigger_check_run`

**四种场景复用同一套 CheckItem**：
- `pre_op_check` - 上机前体检
- `repair_acceptance` - 维修后验收
- `release_verify` - 发布后核验
- `handover_check` - 班次交接复检

**执行流程**：
1. 创建 CheckRun（trigger_reason: manual/ticket/release/schedule/handover）
2. 按 `access_method` 拆分 check_item：
   - `ssh_items` → Ansible playbook `run_check_suite.yml`
   - `http_items` → 直接 `httpx.get(http://{station.host}:{port}{path})`（[L180-201](file:///home/we/gms-backend/Galio-main/backend/app/checkpoint/service.py#L180)）
3. 每个 item 的 outcome 写入 CheckRunResult（result: pass/fail/unknown + evidence + suggestion）
4. 汇总 conclusion（pass/fail/partial）

**access_method=http 是 Worker pull Agent 的雏形**：
- check_item.params 约定 `{port, path}`
- 拼接 `http://{station.host}:{port}{path}` GET
- 响应体按 pass_criteria 判定

### 3.7 工单状态机

**6 态状态机**（[app/ticket/service.py:32-46](file:///home/we/gms-backend/Galio-main/backend/app/ticket/service.py#L32)）：

```
reported → triaged → in_progress → pending_acceptance → closed
                 ↓
              escalated
```

**状态迁移实现**：
- 使用乐观锁：`UPDATE Ticket WHERE status IN (...)`
- 期望的旧状态不匹配 → 抛 `TicketConflict`
- 每次迁移写 ticket_event 流水（10 种 event_type）

**派单与升级**：
- 根因判定：根据 fault_type_id + fault_category 路由到对应运维
- 派单均衡：按 zone_owner 责任区域 + 当前活跃工单数分配
- 超时跟进：response_seconds / resolution_seconds 监控
- 升级梯度：未及时响应 → p_level 提升 → escalated

**三种来源**：
- `manual_report` - 人工报修
- `alert_auto` - 告警自动开单
- `check_fail` - 检测失败自动开单

### 3.8 发布管理闭环

**状态机**（[app/release/service.py:176-241](file:///home/we/gms-backend/Galio-main/backend/app/release/service.py#L176)）：

```
draft → testing → approved → rolling_out → completed
                 ↓                          ↓
              rolled_back               failed
```

**完整流程**：
1. **draft**：创建 release，关联 artifact（image/package/config_template）
2. **testing**：在 test_station_id 工位验证
3. **approved**：approved_by 审批
4. **rolling_out**：检查 release_freeze，创建 release_target（每工位一条）
5. **逐机下发**：Worker 异步执行 deploy_release_target handler
6. **completed**：所有 release_target status=success

**发布冻结检查**（release_freeze 表）：
- 四级 scope：global / site / zone / station
- 检查约束：global 必须 NULL，station 必须 NOT NULL
- rolling_out 前检查，命中冻结则拒绝

**回滚链**：
- release.previous_release_id 自引用
- rollback 时基于 previous_release_id 创建新 release，走相同流程

### 3.9 版本对账与配置指纹

**核心**：[app/jobs/handlers/version_reconcile.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/version_reconcile.py)

**职责**：
1. 比对 `version_report` 与 `config_template` / `release` 目标版本
2. 命中漂移时开 `alert_event`（不直接开 ticket，复用告警引擎）
3. 同时跑配置指纹漂移检测

**执行流程**（[L21-50](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/version_reconcile.py#L21)）：
1. 调 `release_service.version_drift()` 拿版本漂移列表
2. 调 `release_service.config_fingerprint_drift()` 拿指纹漂移列表
3. 找 rule_type='threshold' 的 alert_rule（约定版本漂移专用）
4. 对每个漂移项调 `_fire_version_drift_event`

**去重逻辑**（[L75-90](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/version_reconcile.py#L75)）：
- 查找已有 open 事件（同 alert_rule_id + station_id + device_id IS NULL + status='open'）
- 已有 → occurrence_count += 1，detail 合并
- 没有 → 新建 AlertEvent

**降级**：没有 alert_rule 时跳过并记 warning（FK 约束不允许 nil rule_id）

### 3.10 通知分级路由

**文件**：[app/notify_audit/](file:///home/we/gms-backend/Galio-main/backend/app/notify_audit/)

**通道**（notification.channel）：
- `feishu_group` - 群机器人
- `feishu_dm` - 单聊卡片
- `feishu_urgent_call` - 电话加急
- `feishu_urgent_sms` - 短信加急
- `web` - 站内消息
- `kiosk` - 工位端弹窗

**优先级**（notification.priority）：
- p0 - 电话/加急（最高，如设备宕机）
- p1 - 加急群消息
- p2 - 群消息
- normal - 普通通知

**Worker 投递**（notification_dispatch handler）：
- SKIP LOCKED 认领 pending notification
- 按 channel + priority 路由
- 失败 attempt_count += 1，重试 N 次后 status='failed'
- 同工位同类告警合并（避免轰炸）

### 3.11 端侧执行通道

**当前**（SSH/Ansible）：
- [app/execution/ssh_client.py](file:///home/we/gms-backend/Galio-main/backend/app/execution/ssh_client.py) - paramiko 单命令/多命令
- [app/execution/ansible_runner.py](file:///home/we/gms-backend/Galio-main/backend/app/execution/ansible_runner.py) - subprocess 调 ansible-playbook
- playbook：[ansible/playbooks/](file:///home/we/gms-backend/Galio-main/ansible/playbooks/) poll_device_metrics / deploy_artifact / run_check_suite / fetch_logs
- 探针脚本：[ansible/roles/probes/files/probes/](file:///home/we/gms-backend/Galio-main/ansible/roles/probes/files/probes/) arm/hand/glove/quest/camera/env/link/svc

**计划改造**（见 [.trae/documents/galio-replace-ssh-with-agent.md](file:///home/we/gms-backend/.trae/documents/galio-replace-ssh-with-agent.md)）：
- 完全去 SSH
- 改用现有 machine-heartbeat-agent 双推 + Worker HTTP pull

---

## 四、两套系统关系与协作

### 当前协作点

**GMS 移动端 → Galio API**：
- [js/mobile.js:4278](file:///home/we/gms-backend/js/mobile.js#L4278)
- `fetch('http://10.5.51.216:8000/stations/by-code/'+num+'/latest-metrics')`
- 渲染 4 张主机状态卡片（CPU/内存/磁盘/负载），30s 轮询
- 这是 Galio 当前**唯一**的实际生产调用方

### 数据流向

```
工位 machine-heartbeat-agent (Docker)
   ↓ 30s 心跳
GMS-Backend (/api/edge/heartbeat) ← machines / edge_hosts 表更新
   ↓ 移动端弹窗
GMS Mobile (js/mobile.js)
   ↓ fetch
Galio API (:8000/stations/by-code/{code}/latest-metrics)
   ↑ 读
Galio station_snapshot + metric 表
   ↑ 写
Galio Worker (node_exporter HTTP + 设备探针 SSH)
```

### 功能重叠风险

| 功能 | GMS | Galio | 当前状态 |
|-|-|-|-|
| 工单 | tech_support 4 态 | ticket 6 态 | Galio 后端就绪，无消费方 |
| 设备/SN | sn_registry | device | 两边各一份，靠 machineNumber==station.code 软关联 |
| 机器 | machines | station | 同上 |
| 班次 | shift_inspections | shift + handover | Galio 状态机更完整 |
| 通知 | chat_messages + 飞书 | notification 分级路由 | Galio 通道更全 |

---

## 五、端侧 Agent（machine-heartbeat-agent）

**路径**：[machine-heartbeat-agent/](file:///home/we/gms-backend/machine-heartbeat-agent)

**形态**：Node.js Docker 容器，host 网络模式，已部署在工位

**已具备能力**（覆盖 Galio 探针所需的 95%）：
- 心跳 30s POST GMS-Backend `/api/edge/heartbeat`
- 摄像头掉帧监控（v4l2 + ffmpeg）
- Wuji SDK 扫描手套/灵巧手 SN
- marvin-sdk-broker.py 通过 docker cp 到 importer 容器执行，**绕开 Marvin UDP 4730 端口独占**
- ADB 调 Quest 头显（platform-tools）
- 调本地只读 API（IMPORTER_API_URL=127.0.0.1:5025, HERMES_API_URL=127.0.0.1:5006）
- HTTP server :3000，已挂 /health /info /exec /diagnose-hands /quest-control /machine-config /fix-quest /stop-collector /stop-exodus
- EDGE_TOKEN 鉴权
- docker-compose 挂载 docker.sock、/dev、/var/.rdc2，privileged

**buildPayload() 已聚合**（[heartbeat-agent.js:501-574](file:///home/we/gms-backend/machine-heartbeat-agent/heartbeat-agent.js#L501)）：
- machineNumber / host / ipAddress / agentVersion
- devices: { gloves, dexterousHands, roboticArm }
- quest / importer / hermes / cameras / cameraFps / wuji

**改造方向**（待批准的计划）：
- 加 GALIO_API_URL 环境变量，双推 GMS + Galio
- 加 4 个 HTTP 端点：/probe/collect / /probe/{name}/check / /release/pull / /logs
- Worker 改 HTTP pull Agent :3000
- 完全去 SSH

---

## 六、关键文件索引

### GMS-Backend

| 作用 | 文件 |
|-|-|
| 启动入口 | [server.js](file:///home/we/gms-backend/server.js) |
| PM2 配置 | [ecosystem.config.js](file:///home/we/gms-backend/ecosystem.config.js) |
| 路由分发 | [src/router.js](file:///home/we/gms-backend/src/router.js) |
| 实时通信 | [src/realtime.js](file:///home/we/gms-backend/src/realtime.js) |
| 鉴权 | [src/handlers/auth.js](file:///home/we/gms-backend/src/handlers/auth.js) |
| 库存 | [src/handlers/inventory.js](file:///home/we/gms-backend/src/handlers/inventory.js) |
| FIFO 批次 | [src/handlers/batches.js](file:///home/we/gms-backend/src/handlers/batches.js) |
| 机器绑定 | [src/handlers/machines.js](file:///home/we/gms-backend/src/handlers/machines.js) |
| SN 注册表 | [src/handlers/sn-registry.js](file:///home/we/gms-backend/src/handlers/sn-registry.js) |
| 技术支持 | [src/handlers/tech-support.js](file:///home/we/gms-backend/src/handlers/tech-support.js) |
| 飞书集成 | [feishu.js](file:///home/we/gms-backend/feishu.js) |
| 移动端（调 Galio）| [js/mobile.js](file:///home/we/gms-backend/js/mobile.js) |
| 前端 | [web/](file:///home/we/gms-backend/web) |

### Galio

| 作用 | 文件 |
|-|-|
| API 入口 | [app/main_api.py](file:///home/we/gms-backend/Galio-main/backend/app/main_api.py) |
| Worker 入口 | [app/main_worker.py](file:///home/we/gms-backend/Galio-main/backend/app/main_worker.py) |
| 响应信封 | [app/envelope.py](file:///home/we/gms-backend/Galio-main/backend/app/envelope.py) |
| DB Session | [app/db.py](file:///home/we/gms-backend/Galio-main/backend/app/db.py) |
| 配置 | [app/settings.py](file:///home/we/gms-backend/Galio-main/backend/app/settings.py) |
| Job 调度 | [app/jobs/scheduler.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/scheduler.py) |
| 告警评估 | [app/jobs/handlers/alert_evaluate.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/alert_evaluate.py) |
| 版本对账 | [app/jobs/handlers/version_reconcile.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/version_reconcile.py) |
| 设备探针 | [app/jobs/handlers/poll_device_probes.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/poll_device_probes.py) |
| 发布部署 | [app/jobs/handlers/deploy_release_target.py](file:///home/we/gms-backend/Galio-main/backend/app/jobs/handlers/deploy_release_target.py) |
| 检测引擎 | [app/checkpoint/service.py](file:///home/we/gms-backend/Galio-main/backend/app/checkpoint/service.py) |
| 工单状态机 | [app/ticket/service.py](file:///home/we/gms-backend/Galio-main/backend/app/ticket/service.py) |
| 发布管理 | [app/release/service.py](file:///home/we/gms-backend/Galio-main/backend/app/release/service.py) |
| 监控查询 | [app/monitor/router.py](file:///home/we/gms-backend/Galio-main/backend/app/monitor/router.py) |
| SSH 客户端 | [app/execution/ssh_client.py](file:///home/we/gms-backend/Galio-main/backend/app/execution/ssh_client.py) |
| Ansible | [app/execution/ansible_runner.py](file:///home/we/gms-backend/Galio-main/backend/app/execution/ansible_runner.py) |
| 探针脚本 | [ansible/roles/probes/files/probes/](file:///home/we/gms-backend/Galio-main/ansible/roles/probes/files/probes) |
| 架构文档 | [docs/architecture.md](file:///home/we/gms-backend/Galio-main/docs/architecture.md) |
| 项目约定 | [CLAUDE.md](file:///home/we/gms-backend/Galio-main/CLAUDE.md) |
| 数据库 schema | [docs/database-schema.md](file:///home/we/gms-backend/Galio-main/docs/database-schema.md) |
| API 设计 | [docs/api-design.md](file:///home/we/gms-backend/Galio-main/docs/api-design.md) |

### Agent

| 作用 | 文件 |
|-|-|
| Agent 入口 | [machine-heartbeat-agent/heartbeat-agent.js](file:///home/we/gms-backend/machine-heartbeat-agent/heartbeat-agent.js) |
| Dockerfile | [machine-heartbeat-agent/Dockerfile](file:///home/we/gms-backend/machine-heartbeat-agent/Dockerfile) |
| docker-compose | [machine-heartbeat-agent/docker-compose.yml](file:///home/we/gms-backend/machine-heartbeat-agent/docker-compose.yml) |
| 摄像头监控 | [machine-heartbeat-agent/camera-monitor.js](file:///home/we/gms-backend/machine-heartbeat-agent/camera-monitor.js) |
| 设备检测 | [machine-heartbeat-agent/device-detector.js](file:///home/we/gms-backend/machine-heartbeat-agent/device-detector.js) |

### 计划与对比文档

| 作用 | 文件 |
|-|-|
| 去 SSH 改造计划 | [.trae/documents/galio-replace-ssh-with-agent.md](file:///home/we/gms-backend/.trae/documents/galio-replace-ssh-with-agent.md) |
| 数据库表结构对比 | [.trae/documents/database-schema-comparison.md](file:///home/we/gms-backend/.trae/documents/database-schema-comparison.md) |
| 系统全景（本文档）| [.trae/documents/system-overview.md](file:///home/we/gms-backend/.trae/documents/system-overview.md) |
