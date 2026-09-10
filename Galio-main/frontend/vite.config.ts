import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发把 /api/* 代理到 api 进程，并去掉 /api 前缀——这跟未来 nginx/traefik
// 的路由方式一致（见 docs/api-design.md 待定问题 A1：URL 是否需要版本前缀）：
// FastAPI 路由本身不带前缀（对照 docs/api-design.md 的路径），前缀只在反向代理层加。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
