# 生产构建：Vite 打包成静态文件，nginx 直接托管，SPA 路由回退 + /api 反代见 docker/nginx.conf。
FROM node:20-slim AS build
WORKDIR /app
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
