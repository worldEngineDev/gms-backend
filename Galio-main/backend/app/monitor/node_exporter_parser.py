"""Prometheus node_exporter 文本格式解析器。

只解析 node_exporter 暴露的标准主机指标（CPU/内存/磁盘/网络），不引入 prometheus_client 库——
node_exporter 的输出格式简单（HELP/TYPE 注释行 + 数据行），标准库足够。

见 docs/architecture.md「主机基础指标：复用已预装的 node_exporter」。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass


@dataclass
class ParsedMetric:
    """解析后的一条指标行。"""
    metric_name: str  # node_exporter 原始指标名，如 node_cpu_seconds_total
    labels: dict[str, str]
    value: float


# node_exporter 指标名前缀统一是 node_，我们只关心以下子集——
# 对应架构文档「CPU/内存/磁盘/网络等指标」，按需扩展，不全部入库。
WANTED_METRIC_NAMES: frozenset[str] = frozenset({
    # CPU
    "node_cpu_seconds_total",
    "node_load1",
    "node_load5",
    "node_load15",
    # 内存
    "node_memory_MemTotal_bytes",
    "node_memory_MemAvailable_bytes",
    "node_memory_MemFree_bytes",
    # 磁盘
    "node_filesystem_size_bytes",
    "node_filesystem_free_bytes",
    "node_filesystem_avail_bytes",
    # 网络
    "node_network_receive_bytes_total",
    "node_network_transmit_bytes_total",
    "node_network_up",
})

# 数据行格式：metric_name{label1="val1",label2="val2"} 123.456
# 或无 label：metric_name 123.456
_DATA_LINE_RE = re.compile(
    r'^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*?)'
    r'(?:\{(?P<labels>[^}]*)\})?'
    r'\s+'
    r'(?P<value>[-+]?nan|[-+]?inf|[0-9.eE+-]+)'
)


def parse(text: str, *, wanted: frozenset[str] | None = None) -> list[ParsedMetric]:
    """解析 Prometheus 文本格式，返回 WANTED_METRIC_NAMES 子集。

    wanted 参数用于测试覆盖指定子集；生产路径直接用模块级 WANTED_METRIC_NAMES。
    不在的指标名直接跳过，不做全量解析——node_exporter 输出可能有上百行，
    只取关心的几项降低 worker 内存与 PG 写入压力。
    """
    names = wanted if wanted is not None else WANTED_METRIC_NAMES
    results: list[ParsedMetric] = []

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        match = _DATA_LINE_RE.match(line)
        if match is None:
            continue

        name = match.group("name")
        if name not in names:
            continue

        raw_value = match.group("value")
        try:
            value = float(raw_value)
        except ValueError:
            # nan/inf 等非有限值不写入——PG double precision 存 NaN 行为不一致
            continue
        if not math.isfinite(value):
            continue

        labels = _parse_labels(match.group("labels"))
        results.append(ParsedMetric(metric_name=name, labels=labels, value=value))

    return results


def _parse_labels(raw: str | None) -> dict[str, str]:
    """解析 `label1="val1",label2="val2"` 格式。无 label 返回空 dict。"""
    if not raw:
        return {}

    labels: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" not in pair:
            continue
        key, _, val = pair.partition("=")
        key = key.strip()
        val = val.strip()
        # 去掉首尾引号
        if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
            val = val[1:-1]
        labels[key] = val
    return labels


def derive_simple_metrics(parsed: list[ParsedMetric]) -> dict[str, float]:
    """从 node_exporter 原始指标推导出平台统一 metric_name → value 的扁平映射。

    node_exporter 的原始指标是带 label 的累加值（如 node_cpu_seconds_total 按 cpu/user 分维度），
    平台的 metric 表不需要多维度时序——主机级健康只需要派生后的标量。
    这里给出最直白的派生：取对应原始指标的汇总值（无 label 区分时取唯一行，有多维时取求和或首个 filesystem）。
    """
    derived: dict[str, float] = {}

    # CPU 使用率：1 - (idle 时间占比)，需要按 mode 聚合
    idle = _sum_by_label(parsed, "node_cpu_seconds_total", "mode", "idle")
    total = _sum_all(parsed, "node_cpu_seconds_total")
    if total > 0:
        derived["host_cpu_used_ratio"] = round(1.0 - idle / total, 4)

    # load
    for load_name, field in [("node_load1", "host_load1"),
                             ("node_load5", "host_load5"),
                             ("node_load15", "host_load15")]:
        vals = [m.value for m in parsed if m.metric_name == load_name]
        if vals:
            derived[field] = vals[0]

    # 内存使用率
    mem_total = _first_value(parsed, "node_memory_MemTotal_bytes")
    mem_avail = _first_value(parsed, "node_memory_MemAvailable_bytes")
    if mem_total and mem_avail is not None:
        derived["host_mem_used_ratio"] = round(1.0 - mem_avail / mem_total, 4)
        derived["host_mem_total_bytes"] = mem_total
        derived["host_mem_avail_bytes"] = mem_avail

    # 磁盘使用率（取根 filesystem，跳过 overlay/tmpfs）
    fs_total = _sum_by_label_match(parsed, "node_filesystem_size_bytes", "fstype",
                                   exclude=("tmpfs", "overlay", "squashfs"))
    fs_avail = _sum_by_label_match(parsed, "node_filesystem_avail_bytes", "fstype",
                                   exclude=("tmpfs", "overlay", "squashfs"))
    if fs_total > 0:
        derived["host_disk_used_ratio"] = round(1.0 - fs_avail / fs_total, 4)

    # 网络接收/发送字节：排除 lo 回环接口，其余接口累加
    # 只在存在对应原始指标时才写入，避免空文本也生成 0 值键
    rx_metrics = [m for m in parsed if m.metric_name == "node_network_receive_bytes_total"]
    if rx_metrics:
        derived["host_net_rx_bytes_total"] = _sum_excluding_label(
            rx_metrics, "device", exclude=("lo",))
    tx_metrics = [m for m in parsed if m.metric_name == "node_network_transmit_bytes_total"]
    if tx_metrics:
        derived["host_net_tx_bytes_total"] = _sum_excluding_label(
            tx_metrics, "device", exclude=("lo",))

    return derived


def _first_value(parsed: list[ParsedMetric], name: str) -> float | None:
    for m in parsed:
        if m.metric_name == name:
            return m.value
    return None


def _sum_all(parsed: list[ParsedMetric], name: str) -> float:
    return sum(m.value for m in parsed if m.metric_name == name)


def _sum_by_label(parsed: list[ParsedMetric], name: str, label: str, value: str) -> float:
    """对 name 指标的指定 label=value 求和。"""
    return sum(m.value for m in parsed
               if m.metric_name == name and m.labels.get(label) == value)


def _sum_by_label_match(parsed: list[ParsedMetric], name: str, label: str,
                        *, exclude: tuple[str, ...] = ()) -> float:
    """对 name 指标按 label 排除某些值后求和。"""
    return sum(m.value for m in parsed
               if m.metric_name == name
               and m.labels.get(label) not in exclude)


def _sum_excluding_label(metrics: list[ParsedMetric], label: str,
                         *, exclude: tuple[str, ...] = ()) -> float:
    """对已按指标名过滤后的列表，按 label 排除某些值后求和。"""
    return sum(m.value for m in metrics
               if m.labels.get(label) not in exclude)
