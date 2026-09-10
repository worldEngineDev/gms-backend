# api 进程：backend/ 与 worker.Dockerfile 共享同一份代码，只是 CMD 不同。见 docs/architecture.md「技术选型」。
# 也装 ansible-core：POST /check-runs 是同步执行（见 docs/api-design.md 待定问题 A3），
# 处理这个请求的正是 api 进程本身，SSH 检测项会在这里直接 subprocess 调 ansible-playbook，
# 跟 worker 需要的端侧执行工具是同一套，见 app/execution/ansible_runner.py。
FROM python:3.12-slim
WORKDIR /app

# 强制 uv 只用容器自带的系统 Python，不去发现/下载别的解释器，避免构建环境里出现的
# 其它 Python（比如宿主机装的）被误用；见 .dockerignore 关于 .venv 不进构建上下文的说明，
# 这两个问题是分开的两道保险。
ENV UV_PYTHON_PREFERENCE=only-system
ENV UV_PYTHON_DOWNLOADS=never

RUN pip install --no-cache-dir uv "ansible-core>=2.17"
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*

# 分两段 COPY：先只拷依赖清单，`uv sync` 的结果能被 Docker 缓存，改业务代码不用重装依赖。
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/ ./

EXPOSE 8000
# --no-sync：镜像构建时已经装好依赖了，容器启动不需要再联网核对/装一遍
# （默认的 `uv run` 每次启动都会尝试同步环境，生产容器不应该依赖运行时网络）。
CMD ["uv", "run", "--no-sync", "uvicorn", "app.main_api:app", "--host", "0.0.0.0", "--port", "8000"]
