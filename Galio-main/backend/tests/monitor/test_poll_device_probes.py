"""poll_device_probes stdout 解析逻辑的单元测试——不依赖数据库。

只测 _parse_probe_stdout 和 _index_devices_by_type 等纯函数。
"""
from __future__ import annotations

import uuid

from app.jobs.handlers.poll_device_probes import (
    PROBE_TO_DEVICE_TYPE,
    _index_devices_by_type,
    _parse_probe_stdout,
)


# 模拟 ansible playbook debug 输出（带缩进、前缀、空行、非 JSON 行）
SAMPLE_STDOUT = """\
PLAY [Poll device probes] *******************************************

TASK [Copy probe scripts] **********
ok: [10.0.0.1]

TASK [Run each probe collect and capture stdout] **********
ok: [10.0.0.1] => (item=arm)
ok: [10.0.0.1] => (item=hand)

TASK [Emit JSONL to stdout for server to parse] **********
ok: [10.0.0.1] => {
    \"msg\": \"{\\\"probe\\\":\\\"arm\\\",\\\"result\\\":{\\\"status\\\":\\\"ok\\\",\\\"metrics\\\":{\\\"arm_status\\\":1,\\\"drag_mode\\\":0}}}{\\\"probe\\\":\\\"hand\\\",\\\"result\\\":{\\\"status\\\":\\\"unknown\\\",\\\"metrics\\\":{}}}\"
}

PLAY RECAP ***
10.0.0.1 : ok=4 changed=0 unreachable=0 failed=0
"""

# 另一种格式：每个 debug 行单独一个 JSON
SAMPLE_STDOUT_MULTI_LINE = """\
ok: [10.0.0.1] => {
    \"msg\": \"{\\\"probe\\\":\\\"arm\\\",\\\"result\\\":{\\\"status\\\":\\\"ok\\\",\\\"metrics\\\":{\\\"arm_status\\\":1}}}\"
}
ok: [10.0.0.1] => {
    \"msg\": \"{\\\"probe\\\":\\\"hand\\\",\\\"result\\\":{\\\"status\\\":\\\"fail\\\",\\\"metrics\\\":{\\\"sdk_error_count\\\":3}}}\"
}
"""


def test_parse_probe_stdout_extracts_arm_and_hand() -> None:
    results = _parse_probe_stdout(SAMPLE_STDOUT)
    probes = [r["probe"] for r in results]
    assert "arm" in probes
    assert "hand" in probes


def test_parse_probe_stdout_extracts_metrics() -> None:
    results = _parse_probe_stdout(SAMPLE_STDOUT)
    arm_result = next(r for r in results if r["probe"] == "arm")
    assert arm_result["result"]["status"] == "ok"
    assert arm_result["result"]["metrics"]["arm_status"] == 1
    assert arm_result["result"]["metrics"]["drag_mode"] == 0


def test_parse_probe_stdout_handles_empty() -> None:
    assert _parse_probe_stdout("") == []
    assert _parse_probe_stdout("no json here\\njust text") == []


def test_parse_probe_stdout_multi_line() -> None:
    results = _parse_probe_stdout(SAMPLE_STDOUT_MULTI_LINE)
    assert len(results) == 2
    hand_result = next(r for r in results if r["probe"] == "hand")
    assert hand_result["result"]["status"] == "fail"
    assert hand_result["result"]["metrics"]["sdk_error_count"] == 3


def test_parse_probe_stdout_skips_non_probe_json() -> None:
    stdout = '{\"foo\": \"bar\"}\\n{\"probe\": \"svc\", \"result\": {\"status\": \"ok\", \"metrics\": {}}}'
    results = _parse_probe_stdout(stdout)
    assert len(results) == 1
    assert results[0]["probe"] == "svc"


def test_probe_to_device_type_mapping() -> None:
    # 6 个设备类型探针都有映射
    for probe in ("arm", "hand", "glove", "quest", "camera", "link"):
        assert probe in PROBE_TO_DEVICE_TYPE
        assert PROBE_TO_DEVICE_TYPE[probe] == probe


def test_index_devices_by_type() -> None:
    # 用简单的 dataclass-like mock 代替 Device（避免 DB 依赖）
    class MockDevice:
        def __init__(self, dev_type: str):
            self.id = uuid.uuid4()
            self.type = dev_type

    devices = [MockDevice("arm"), MockDevice("hand"), MockDevice("arm")]
    index = _index_devices_by_type(devices)
    assert "arm" in index
    assert "hand" in index
    # 同类型多台只取第一台
    assert index["arm"].id == devices[0].id


def test_index_devices_by_type_empty() -> None:
    assert _index_devices_by_type([]) == {}
