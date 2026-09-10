# worker 进程：与 api.Dockerfile 共享同一份 backend/ 代码，只是 CMD 不同。
# worker 还需要能跑 ansible-playbook（见 app/execution/ansible_runner.py），
# 所以额外装 ansible-core；顶层 ansible/ 目录在 compose 里挂载到 GALIO_ANSIBLE_PROJECT_DIR。
FROM python:3.12-slim
WORKDIR /app

# 强制 uv 只用容器自带的系统 Python，原因见 api.Dockerfile 里的注释。
ENV UV_PYTHON_PREFERENCE=only-system
ENV UV_PYTHON_DOWNLOADS=never

RUN pip install --no-cache-dir uv "ansible-core>=2.17"
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*

# 分两段 COPY：先只拷依赖清单，`uv sync` 的结果能被 Docker 缓存，改业务代码不用重装依赖。
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/ ./

# --no-sync：镜像构建时已经装好依赖了，容器启动不需要再联网核对/装一遍
# （默认的 `uv run` 每次启动都会尝试同步环境，生产容器不应该依赖运行时网络）。
CMD ["uv", "run", "--no-sync", "python", "-m", "app.main_worker"]
