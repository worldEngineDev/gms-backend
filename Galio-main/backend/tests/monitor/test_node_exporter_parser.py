"""node_exporter 文本解析器的单元测试——不依赖数据库。"""
from __future__ import annotations

from app.monitor.node_exporter_parser import derive_simple_metrics, parse


SAMPLE_TEXT = """\
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} 12345.67
node_cpu_seconds_total{cpu="0",mode="user"} 6789.0
node_cpu_seconds_total{cpu="1",mode="idle"} 11111.0
node_cpu_seconds_total{cpu="1",mode="user"} 2222.0
# HELP node_load1 Load average 1m.
# TYPE node_load1 gauge
node_load1 0.42
node_load5 0.51
node_load15 0.63
# HELP node_memory_MemTotal_bytes Memory total.
# TYPE node_memory_MemTotal_bytes gauge
node_memory_MemTotal_bytes 1.6e+10
node_memory_MemAvailable_bytes 8e+09
node_memory_MemFree_bytes 7.5e+09
# HELP node_filesystem_size_bytes Filesystem size.
# TYPE node_filesystem_size_bytes gauge
node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 1e+11
node_filesystem_avail_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 4e+10
node_filesystem_size_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/tmp"} 1e+09
node_filesystem_avail_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/tmp"} 5e+08
# HELP node_network_receive_bytes_total Network receive bytes.
# TYPE node_network_receive_bytes_total counter
node_network_receive_bytes_total{device="eth0"} 1e+08
node_network_receive_bytes_total{device="lo"} 1e+06
node_network_transmit_bytes_total{device="eth0"} 2e+08
node_network_transmit_bytes_total{device="lo"} 5e+05
# HELP node_exporter_build_info Build info.
# TYPE node_exporter_build_info gauge
node_exporter_build_info{version="1.8.2"} 1
# 这行是中文注释，应被跳过
node_unwanted_metric 42
"""


def test_parse_skips_comments_and_unknown_metrics() -> None:
    parsed = parse(SAMPLE_TEXT)
    names = {m.metric_name for m in parsed}
    # 只保留 WANTED_METRIC_NAMES 子集
    assert "node_exporter_build_info" not in names
    assert "node_unwanted_metric" not in names
    assert "node_cpu_seconds_total" in names
    assert "node_load1" in names


def test_parse_extracts_labels() -> None:
    parsed = parse(SAMPLE_TEXT)
    cpu_lines = [m for m in parsed if m.metric_name == "node_cpu_seconds_total"]
    assert len(cpu_lines) == 4
    idle = [m for m in cpu_lines if m.labels.get("mode") == "idle"]
    assert len(idle) == 2
    assert idle[0].value == 12345.67


def test_parse_handles_no_labels() -> None:
    parsed = parse(SAMPLE_TEXT)
    load1 = [m for m in parsed if m.metric_name == "node_load1"]
    assert len(load1) == 1
    assert load1[0].labels == {}
    assert load1[0].value == 0.42


def test_parse_skips_nan_inf() -> None:
    text = 'node_load1 nan\nnode_load5 +inf\nnode_load15 0.5'
    parsed = parse(text, wanted=frozenset({"node_load1", "node_load5", "node_load15"}))
    values = [m.value for m in parsed]
    assert 0.5 in values
    assert all(v == 0.5 for v in values if v == 0.5)
    # nan 和 inf 不应出现
    import math
    assert not any(math.isnan(v) for v in values)
    assert not any(math.isinf(v) for v in values)


def test_parse_empty_text() -> None:
    assert parse("") == []
    assert parse("# only comments\n# nothing else") == []


def test_derive_cpu_used_ratio() -> None:
    parsed = parse(SAMPLE_TEXT)
    derived = derive_simple_metrics(parsed)
    # idle=12345.67+11111=23456.67, total=12345.67+6789+11111+2222=32467.67
    # used = 1 - 23456.67/32467.67 = 0.2775...
    assert "host_cpu_used_ratio" in derived
    assert 0.27 < derived["host_cpu_used_ratio"] < 0.28


def test_derive_load() -> None:
    parsed = parse(SAMPLE_TEXT)
    derived = derive_simple_metrics(parsed)
    assert derived["host_load1"] == 0.42
    assert derived["host_load5"] == 0.51
    assert derived["host_load15"] == 0.63


def test_derive_mem() -> None:
    parsed = parse(SAMPLE_TEXT)
    derived = derive_simple_metrics(parsed)
    assert derived["host_mem_total_bytes"] == 1.6e10
    assert derived["host_mem_avail_bytes"] == 8e9
    # used = 1 - 8e9/1.6e10 = 0.5
    assert derived["host_mem_used_ratio"] == 0.5


def test_derive_disk_excludes_tmpfs() -> None:
    parsed = parse(SAMPLE_TEXT)
    derived = derive_simple_metrics(parsed)
    # ext4: total=1e11, avail=4e10 → used = 1 - 4e10/1e11 = 0.6
    # tmpfs 被排除
    assert derived["host_disk_used_ratio"] == 0.6


def test_derive_network_excludes_lo() -> None:
    parsed = parse(SAMPLE_TEXT)
    derived = derive_simple_metrics(parsed)
    assert derived["host_net_rx_bytes_total"] == 1e8  # 只 eth0
    assert derived["host_net_tx_bytes_total"] == 2e8


def test_derive_missing_metrics_returns_empty() -> None:
    parsed = parse("")
    assert derive_simple_metrics(parsed) == {}
