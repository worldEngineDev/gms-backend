# Machine Heartbeat Agent - Lightweight Docker Container
FROM node:20-alpine

WORKDIR /app

# 额外系统工具：
# - gcompat + Google platform-tools：adb fallback（容器内 daemon 扫不到 USB，实际靠挂载宿主机 adb）
# - docker-cli：docker exec importer-staging 读取 /exchange/machine.jsonc 识别手套 SN
# - v4l-utils：v4l2-ctl，用于摄像头设备检测（Linux）
# - ffmpeg：用于摄像头帧率监控
# - python3：灵巧手诊断脚本运行（wuji-sdk 从宿主机挂载，因为 SDK wheel 是 glibc only）
RUN apk add --no-cache gcompat docker-cli v4l-utils ffmpeg wget unzip python3 py3-pip \
    && wget -q https://dl.google.com/android/repository/platform-tools-latest-linux.zip -O /tmp/pt.zip \
    && unzip -q /tmp/pt.zip -d /opt && rm /tmp/pt.zip \
    && ln -sf /opt/platform-tools/adb /usr/local/bin/adb

# npm 依赖：ws（WebSocket 实时推送通道）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY *.js ./
COPY marvin-sdk-broker.py ./
# Marvin 机械臂 SDK 动态库（glibc，通过 docker cp 传入 importer 容器执行）
COPY libMarvinSDK.so ./

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3000

CMD ["node", "heartbeat-agent.js"]
