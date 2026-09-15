# 运营端机器状态中心 API

## Endpoint

```http
GET /api/machines/{machineNumber}/operations-center
```

需要登录。可选查询参数 `since`、`until` 为 Unix 秒；缺省为服务端当天 00:00 到次日 00:00。

示例：

```http
GET /api/machines/szx3-105/operations-center?since=1789315200&until=1789401600
```

## 响应字段

- `login`: `loggedIn`、`idleTimeSecs`、`activity`
- `machine`: `machineId`、`computerId`、`workflow`、`collectorType`、`importerVersion`
- `task`: 当前任务；包含 `id`、`name`、`state`、`training`，以及操作员 `id`、`name`、`level`
- `processing.workers`: Worker 的忙碌数、待处理数、并行上限和利用率
- `processing.queue`: 处理队列的 `busy`、`pending`、`available_capacity`、`utilization_percent`
- `processing.workflows`: Importer 返回的 Workflow 状态
- `uploads`: 时间范围内 Episode 数量；`sizeBytes` 仅在所有或部分记录提供 `payload.size_bytes` 时计算，`sizeKnown=false` 表示容量未知
- `sessions`: 全天 `attendedSeconds`、会话列表、运行列表和操作尝试统计
- `sourceErrors`: 单个远端读取失败时记录错误名；聚合接口仍返回其它可用数据

Hermes 工作流以 `machine.workflow === "hermes"` 判断。Hermes 采集程序的实时设备状态仍由现有 `/api/machines/{machineNumber}/info` 或 `/api/machines/{machineNumber}/live` 提供。

