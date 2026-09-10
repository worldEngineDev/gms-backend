# CLAUDE.md

本文件为 Claude Code（及其他协作者）在本仓库工作时的准则。项目背景见 [README.md](README.md)，完整架构与技术选型见 [docs/architecture.md](docs/architecture.md)，数据库设计见 [docs/database-schema.md](docs/database-schema.md)。

## 核心原则：KISS（Keep It Simple and Stupid）

这是本项目高于一切的工程准则，优先级在"优雅""可扩展""面面俱到"之上。

- **先用最直接的方案解决当前问题**，不要为假设中的未来需求设计。没有需求支撑的抽象、配置项、参数化，一律不写；
- **能用一个表 + 一条 SQL 解决的，不引入新组件**。架构上已明确只用 PostgreSQL 承担状态、队列、锁、幂等（见 [docs/architecture.md](docs/architecture.md) §数据模型 / [docs/database-schema.md](docs/database-schema.md)），不要为了"更专业"引入 Redis/MinIO/消息中间件/调度框架；
- **三行重复的代码优于一个提前设计的抽象**。只有当第三处真实重复出现、且抽象边界已经清楚时才提取公共逻辑；
- **拒绝过度工程**：不加尚未发生场景的容错、重试、降级、feature flag；不做"可能以后要换数据库"式的接口层；
- **函数/模块只做一件事**，命名直接表达意图，减少读者需要在脑内维护的状态；
- 如果一个方案需要专门写文档才能让人理解"为什么这么设计",先问自己能不能改成不需要解释的写法；
- 复杂度必须用真实约束换取（性能实测、并发正确性、外部系统限制），不能用"更好的设计"作为引入复杂度的理由。

写代码前默认先问：**有没有更蠢、更直白的写法能达到同样效果？** 有就用那个。

## 项目约定（源自架构设计，实现时须遵守）

- **服务无状态**：api/worker 进程不持有业务状态；幂等、去重、互斥、任务领取全部落 PostgreSQL（唯一索引 / `ON CONFLICT` / `SELECT ... FOR UPDATE SKIP LOCKED` / `pg_advisory_xact_lock`），不要在进程内存里做这些事；
- **单一存储**：PostgreSQL 是唯一有状态组件，不引入额外的缓存层或消息队列，除非有实测数据证明 PG 顶不住；
- **通用审计字段**：新建表默认带 `created_at` / `created_by` / `deleted_at`（软删除），唯一约束用部分唯一索引 `WHERE deleted_at IS NULL`；
- **API 统一响应信封**：`{code, message, request_id, data}`，列表接口 `data = {items, page, page_size, total}`；
- **检测是核心领域对象**：体检/验收/发布核验/交接四个场景复用同一套 `CheckItem/CheckSuite/CheckRun` 模型，不要为每个场景单独建模型；
- **不部署端侧常驻 Agent，SSH/Ansible 是唯一端侧执行通道**：服务端不直连设备 SDK；状态采集、检测执行、发布下发全部由服务端 Worker 主动 SSH 到工位执行探针脚本；主机基础指标复用各机已预装的 node_exporter（HTTP 抓取，不引入 Prometheus Server）；运维处理故障直接 SSH/Ansible 上机，不经平台下发命令。

## 技术栈

| 层 | 选型 |
|-|-|
| 服务端 | Python + uv + FastAPI + SQLModel |
| 端侧执行 | Ansible + OpenSSH（服务端持有 SSH 凭据主动连接工位），探针为可执行脚本，随 SSH 会话按需执行，不常驻 |
| 数据库 | PostgreSQL 18 |
| 前端 | React 19 + TypeScript + Ant Design |
| 部署 | docker compose |

具体理由见 [docs/architecture.md](docs/architecture.md)「技术选型」章节，改变技术栈需要先更新该文档并说明理由，不要在代码里悄悄引入未经讨论的依赖。

## 提交前检查

- 改动是否引入了本任务不需要的抽象或配置项？如有，删掉；
- 能否用更少的代码/更少的新概念做到同样的事？
- 是否有未被要求的"顺手重构""顺手加的容错"？如有，拆分出去单独确认，不要混进当前改动。
