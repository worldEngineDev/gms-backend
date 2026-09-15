// PM2 Ecosystem Configuration - Single Instance
// 使用方法: pm2 start ecosystem.config.js
//
// S1 安全加固: 密钥不再硬编码，从 .env / process.env 读取。
//   - 历史泄露的密码 Wh111852 必须在部署前轮换
//   - 缺失关键密钥时 PM2 启动会报错（fail fast），避免误用空值连库
require('dotenv').config();

// 单实例公共环境
const sharedEnv = {
  NODE_ENV: 'production',
  TZ: 'Asia/Shanghai',
  DB_HOST: process.env.DB_HOST || '127.0.0.1',
  DB_PORT: process.env.DB_PORT || '3306',
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD, // 必须由 .env 提供，不再硬编码
  DB_NAME: process.env.DB_NAME || 'gms',
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: process.env.REDIS_PORT || '6379',
  EDGE_TOKEN: process.env.EDGE_TOKEN,
  // 加密密钥（encryptPassword 用，S6 批次会改用随机 IV）
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  // HTTPS 标志（控制是否下发 HSTS）
  HTTPS_ENABLED: process.env.HTTPS_ENABLED || 'false',
};

// 启动前校验关键密钥（fail fast，避免空密码误连库）
if (!sharedEnv.DB_PASSWORD) {
  console.error('[ecosystem] 致命错误: DB_PASSWORD 未设置。请在 .env 文件中配置（参考 .env.example）。');
  // PM2 加载本文件时退出，阻止启动
  process.exit(1);
}

const apps = [
  {
    name: 'yunwei-1',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    node_args: '--expose-gc',
    max_memory_restart: '2G',
    kill_timeout: 10000,
    env: { ...sharedEnv, PORT: '8765' },
    error_file: '/tmp/yunwei-1-error.log',
    out_file: '/tmp/yunwei-1-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  },
];

module.exports = { apps };
