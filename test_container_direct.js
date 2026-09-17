#!/usr/bin/env node
/**
 * 直接连接容器内部端口测试
 */

const WebSocket = require('ws');

// 获取容器 IP
const { execSync } = require('child_process');
const containerIp = execSync('docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" yunwei-app').toString().trim();

console.log('容器 IP:', containerIp);
console.log('测试直接连接容器端口 8765...\n');

const ws = new WebSocket(`ws://${containerIp}:8765/ws`, {
  perMessageDeflate: false
});

ws.on('open', () => {
  console.log('✅ 连接成功');
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log('📩 收到:', msg.type);
  if (msg.type === 'connected') {
    console.log('   wsId:', msg.wsId);
    console.log('\n✅ 测试通过！优化版工作正常。');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});

ws.on('ping', () => {
  console.log('💓 收到心跳');
});

setTimeout(() => {
  console.log('\n⏱️  等待心跳（预期5秒）...');
}, 1000);

setTimeout(() => {
  console.log('测试完成');
  ws.close();
  process.exit(0);
}, 10000);
