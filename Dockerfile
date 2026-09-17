FROM node:20-alpine

# dumb-init for proper SIGTERM → graceful shutdown
RUN apk add --no-cache dumb-init openssh-client sshpass

# PM2 for cluster process management
RUN npm install -g pm2

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application
COPY server.js feishu.js ./
COPY realtime.js ./
COPY lib/ ./lib/
COPY src/ ./src/
COPY index.html operations.html mobile.html mobile-ops.html ./
COPY css/ ./css/
COPY js/ ./js/
# Published Vite bundles required by the desktop and operations pages.
COPY assets/ ./assets/
COPY icons/ ./icons/
COPY manifest.json sw.js ./
COPY ecosystem.config.js ./

# Create data and uploads directories
RUN mkdir -p /app/uploads /app/data

EXPOSE 8765
ENV PORT=8765
ENV TZ=Asia/Shanghai

ENTRYPOINT ["dumb-init", "--"]
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
