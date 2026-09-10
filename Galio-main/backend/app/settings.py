"""环境变量配置。见 docs/architecture.md「技术选型」「非功能需求」。"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GALIO_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://galio:galio@localhost:5432/galio"
    sql_echo: bool = False

    # 巡检周期，见 docs/architecture.md「端侧执行机制」「非功能需求」
    node_exporter_poll_seconds: int = 30
    device_probe_poll_seconds: int = 60
    offline_after_consecutive_failures: int = 3
    node_exporter_port: int = 9100

    # SSH/Ansible，见 docs/database-schema.md 设计评审 Q5（密钥托管方案未定，先读本地路径占位）
    ssh_private_key_path: str = "/secrets/galio_station_key"
    ansible_project_dir: str = "../ansible"

    job_loop_idle_seconds: float = 2.0

    # 飞书开放平台凭据，见 feishu.js（现有 GMS 复用）
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_base_url: str = "open.feishu.cn"
    # 群机器人 Webhook（运维通知群）
    feishu_group_webhook: str = ""
    # 飞书电话加急需要开放平台加急权限，默认不启用
    feishu_urgent_enabled: bool = False


settings = Settings()
