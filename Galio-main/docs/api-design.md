# Galio API 接口规划

基于 [docs/database-schema.md](database-schema.md) 的 35 张表和 [docs/architecture.md](architecture.md)「服务端核心模块」的 8 个模块，规划一版接口清单。所有接口遵循 architecture.md 的 [API 设计约定](architecture.md#api-设计约定)（统一响应信封 `{code,message,request_id,data}`、分页 `page/page_size`、`X-Request-ID`），本文档不重复。

## 目录

- [接口规划原则](#接口规划原则)
- [按模块的接口清单](#按模块的接口清单)
- [接口数量汇总](#接口数量汇总)
- [待定问题](#待定问题)

## 接口规划原则

在给每张表机械套用"增删改查 5 件套"之前，先按 KISS 定几条规则，避免接口数量虚高：

1. **只有聚合了子资源才开 detail 接口**：`list` 接口返回的字段已经够用的资源（`site`/`zone`/`check_item`/`fault_type`/`config_template` 等字典或简单实体）不单独开 `GET /{id}`；只有 detail 需要聚合时间线/子项/看板的资源（`ticket`、`station`、`check_suite`、`release`、`handover`、`device`）才开；
2. **状态机跳转用专门的动作接口，不用通用 `PATCH status`**：`POST /tickets/{id}/dispatch`、`POST /releases/{id}/approve` 这类接口比"改一个 status 字段"更能表达每个跳转的权限校验和副作用（发通知、记 `*_event`、算时效字段），也和 database-schema.md「状态流转防并发」的乐观锁模式（`UPDATE ... WHERE status = 期望前态`）直接对应；
3. **不可变对象只开需要的方向**：`artifact`（制品登记后不可变）只有 `list` + `create`，没有 `update`/`delete`；`audit_log`/`version_report`/`metric` 这类只读事实表只有查询接口，没有任何写接口（写入是内部巡检/发布流程，不通过面向用户的 API）；
4. **检测四场景复用同一组接口**：一键体检、验收、发布核验、交接检查都调用同一个 `POST /check-runs`（`body` 里的 `trigger_reason` + 关联 id 决定场景），不为每个场景单独开接口；
5. **子资源清单优先"整体替换"而不是逐项增删**：`check_suite` 的检测项清单用 `PUT /check-suites/{id}/items` 整体提交（含顺序），不做 `POST item` + `DELETE item` 两个接口——清单一般是编辑完一次性保存，没有必要拆两步。

## 按模块的接口清单

### 1. 人员与组织资产

对应表：`person`、`site`、`zone`、`zone_owner`、`station`、`device`、`device_change_log`、`shift`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/persons` | 人员列表（筛选角色/状态） |
| POST | `/persons` | 新建人员 |
| PATCH | `/persons/{id}` | 编辑人员（含角色变更） |
| DELETE | `/persons/{id}` | 软删除（离职） |
| GET | `/sites` | 站点列表 |
| POST | `/sites` | 新建站点 |
| PATCH | `/sites/{id}` | 编辑站点 |
| DELETE | `/sites/{id}` | 软删除 |
| GET | `/zones` | 区域列表 |
| POST | `/zones` | 新建区域 |
| PATCH | `/zones/{id}` | 编辑区域 |
| DELETE | `/zones/{id}` | 软删除 |
| POST | `/zones/{id}/owners` | 绑定区域责任人（资深/新手） |
| DELETE | `/zones/{id}/owners/{personId}` | 解绑责任人 |
| GET | `/stations` | 工位列表（筛选区域/状态，含在线状态摘要，供大盘用） |
| GET | `/stations/{id}` | 工位详情（聚合 `station_snapshot` 健康矩阵、绑定设备、未闭环工单数） |
| POST | `/stations` | 新建工位 |
| PATCH | `/stations/{id}` | 编辑工位（含 `host` 连接地址） |
| DELETE | `/stations/{id}` | 软删除（停用工位） |
| GET | `/devices` | 设备列表（筛选工位/类型/生命周期） |
| GET | `/devices/{id}` | 设备详情（聚合最近变更记录） |
| POST | `/devices` | 登记设备 |
| PATCH | `/devices/{id}` | 编辑设备（型号等） |
| DELETE | `/devices/{id}` | 软删除 |
| POST | `/devices/{id}/changes` | 记录设备变更（更换/维修/报废/调机） |
| GET | `/shifts` | 班次列表（筛选人员/时间范围） |
| POST | `/shifts` | 开始班次 |
| PATCH | `/shifts/{id}/end` | 结束班次 |

小计：**27**

### 2. 检测引擎

对应表：`fault_type`、`check_item`、`check_suite`、`check_suite_item`、`check_run`、`check_run_result`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/fault-types` | 故障类型字典 |
| POST | `/fault-types` | 新建故障类型 |
| PATCH | `/fault-types/{id}` | 编辑 |
| DELETE | `/fault-types/{id}` | 软删除 |
| GET | `/check-items` | 检测项列表（筛选设备类型） |
| POST | `/check-items` | 新建检测项 |
| PATCH | `/check-items/{id}` | 编辑（含 `pass_criteria`） |
| DELETE | `/check-items/{id}` | 软删除 |
| GET | `/check-suites` | 检测集列表（筛选场景） |
| GET | `/check-suites/{id}` | 检测集详情（含检测项清单及顺序） |
| POST | `/check-suites` | 新建检测集 |
| PATCH | `/check-suites/{id}` | 编辑基本信息 |
| DELETE | `/check-suites/{id}` | 软删除 |
| PUT | `/check-suites/{id}/items` | 整体设置检测项清单（含顺序） |
| POST | `/check-runs` | 触发一次检测执行（体检/验收/发布核验/交接四场景复用；Worker 同步 SSH 执行探针脚本） |
| GET | `/check-runs` | 检测执行历史（筛选工位/场景/结论） |
| GET | `/check-runs/{id}` | 检测执行详情（含每个检测项的 `check_run_result`） |

小计：**16**

### 3. 工单调度

对应表：`ticket`、`ticket_event`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/tickets` | 工单列表（筛选工位/状态/处理人） |
| GET | `/tickets/{id}` | 工单详情（聚合 `ticket_event` 时间线） |
| POST | `/tickets` | 一键报修 |
| POST | `/tickets/{id}/triage` | 根因判定（软件/硬件+故障类型） |
| POST | `/tickets/{id}/dispatch` | 派单 |
| POST | `/tickets/{id}/accept` | 运维接单 |
| POST | `/tickets/{id}/submit-fix` | 提交修复，进入待验收 |
| POST | `/tickets/{id}/close` | 验收通过并闭环 |
| POST | `/tickets/{id}/reject` | 验收不通过，打回处理中 |
| POST | `/tickets/{id}/escalate` | 超时/自助失败，梯度升级 |
| POST | `/tickets/{id}/self-resolve` | 采集员标记自助解决，轻量闭环 |
| GET | `/tickets/export` | 导出（含处理人/响应时长/处理总时长） |

小计：**12**

### 4. 发布与配置

对应表：`config_template`、`artifact`、`release`、`release_target`、`version_report`、`release_freeze`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/config-templates` | 配置模板列表 |
| POST | `/config-templates` | 新建模板（关联 `file`） |
| PATCH | `/config-templates/{id}` | 编辑（发新版本） |
| DELETE | `/config-templates/{id}` | 软删除 |
| GET | `/artifacts` | 制品列表 |
| POST | `/artifacts` | 登记制品（镜像/包/配置模板快照） |
| GET | `/releases` | 发布列表（筛选状态） |
| GET | `/releases/{id}` | 发布详情（聚合 `release_target` 逐机结果看板） |
| POST | `/releases` | 创建发布草稿 |
| POST | `/releases/{id}/submit-test` | 提交测试机验证 |
| POST | `/releases/{id}/approve` | 审批通过 |
| POST | `/releases/{id}/rollout` | 圈选目标（区域/工位）并下发 |
| POST | `/releases/{id}/rollback` | 一键回滚到上一版本 |
| POST | `/release-targets/{id}/retry` | 单机重试 |
| GET | `/stations/{id}/versions` | 某工位当前各模块版本 |
| GET | `/version-drift` | 期望 vs 实际版本漂移列表（对账大盘） |
| GET | `/release-freezes` | 冻结记录列表 |
| POST | `/release-freezes` | 创建冻结（全局/站点/区域/工位） |
| POST | `/release-freezes/{id}/release` | 解除冻结 |

小计：**19**

### 5. 监控与告警

对应表：`metric`、`metric_hourly_agg`、`station_snapshot`（并入「1. 人员与组织资产」的工位接口）、`alert_rule`、`alert_event`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/stations/{id}/metrics` | 时序指标查询（参数 `metric_name`/`from`/`to`，明细或小时聚合） |
| GET | `/alert-rules` | 告警规则列表 |
| POST | `/alert-rules` | 新建规则 |
| PATCH | `/alert-rules/{id}` | 编辑（含启停） |
| DELETE | `/alert-rules/{id}` | 软删除 |
| GET | `/alert-events` | 告警事件列表（筛选状态/级别） |
| POST | `/alert-events/{id}/ack` | 确认告警 |
| POST | `/alert-events/{id}/resolve` | 手动标记已解决 |

小计：**8**（工位在线状态本身走 `GET /stations` / `GET /stations/{id}`，不重复开接口）

### 6. 采集业务与班次交接

对应表：`collect_task`、`handover`、`handover_item`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/collect-tasks` | 采集任务列表（筛选工位/人员） |
| POST | `/collect-tasks` | 领取任务（开始采集） |
| POST | `/collect-tasks/{id}/end` | 结束任务 |
| POST | `/collect-tasks/{id}/events` | 采集软件直接上报事件（掉帧/会话异常，可一键转报修） |
| GET | `/handovers` | 交接单列表 |
| GET | `/handovers/{id}` | 交接单详情（聚合逐工位签收清单） |
| POST | `/handovers` | 发起交接（生成设备快照+未闭环工单列表） |
| POST | `/handovers/{id}/items/{stationId}/confirm` | 逐工位签收 |
| POST | `/handovers/{id}/confirm` | 整体确认交接 |
| POST | `/handovers/{id}/escalate` | 交接异常升级 |

小计：**10**

### 7. 文件

对应表：`file`、`file_chunk`（分块是存储实现细节，不对外暴露分块级接口）。

| 方法 | 路径 | 说明 |
|-|-|-|
| POST | `/files` | 上传（multipart，服务端内部按 32MB 切块落 `file_chunk`） |
| GET | `/files/{id}` | 下载/元数据 |

小计：**2**

### 8. 通知与审计（只读为主）

对应表：`notification`、`audit_log`。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/notifications` | 站内通知列表（Web/工位端弹窗轮询） |
| PATCH | `/notifications/{id}/read` | 标记已读 |
| GET | `/audit-logs` | 审计日志查询（筛选实体/操作人/时间） |

小计：**3**（飞书通道的投递是 worker 内部走 `notification` 队列，不对外开接口）

### 9. 认证与当前用户（占位，见「待定问题」）

| 方法 | 路径 | 说明 |
|-|-|-|
| POST | `/auth/feishu-login` | 飞书登录换取平台会话 |
| GET | `/auth/me` | 当前用户信息（角色、所属区域） |
| POST | `/auth/logout` | 登出 |

小计：**3**

## 接口数量汇总

| 模块 | 接口数 |
|-|-|
| 人员与组织资产 | 27 |
| 检测引擎 | 16 |
| 工单调度 | 12 |
| 发布与配置 | 19 |
| 监控与告警 | 8 |
| 采集业务与班次交接 | 10 |
| 文件 | 2 |
| 通知与审计 | 3 |
| 认证与当前用户（占位） | 3 |
| **合计** | **100** |

按 README 的 M1/M2/M3 节奏，「监控与告警」「工单调度」「人员与组织资产」「文件」「通知与审计」「认证」（共 ~65 个）在 M1 就要落地；「检测引擎」「发布与配置」「采集业务与班次交接」（共 ~45 个）随 M2 一起上，与 [database-schema.md 建表阶段建议](database-schema.md#建表阶段建议对应-m1m2m3) 的表分批顺序一致。

## 待定问题

| # | 问题 | 说明 |
|-|-|-|
| A1 | URL 是否需要版本前缀（如 `/api/v1/...`） | architecture.md 的 API 设计约定目前没定这条，先按无版本前缀规划；一旦定下来是统一加前缀而已，不影响接口清单本身 |
| A2 | 认证方式未最终确认 | 「9. 认证与当前用户」按"飞书登录换会话"占位；如果实际走公司统一 SSO/网关鉴权（架构外部完成），这 3 个接口可能不需要 Galio 自己实现，需要和现场网络/账号体系确认 |
| A3 | `check_run` 是否需要允许调用方轮询进度 | 当前设计里 Worker 是同步 SSH 执行，`POST /check-runs` 假设是同步返回结果或短轮询 `GET /check-runs/{id}` 拿最终态；如果个别检测项耗时较长（比如整机走查），需要确认前端是同步等待还是轮询，这会影响 `POST /check-runs` 是否要支持 `Accept: async` 之类的语义，目前不展开设计 |
