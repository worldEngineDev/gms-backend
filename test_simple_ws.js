#!/usr/bin/env node
/**
 * 简单的 WebSocket 连接测试
 */

const WebSocket = require('ws');

console.log('测试 WebSocket 连接到 ws://127.0.0.1:8765/ws');
console.log('');

const ws = new WebSocket('ws://127.0.0.1:8765/ws', {
  perMessageDeflate: false
});

let connected = false;
let authenticated = false;
const startTime = Date.now();
let heartbeatCount = 0;
const heartbeats = [];
let lastHeartbeat = 0;

ws.on('open', () => {
  console.log('✅ WebSocket 连接成功');
  connected = true;
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const now = Date.now();

  console.log(`[${now - startTime}ms] 收到消息:`, msg.type);

  switch (msg.type) {
    case 'connected':
      console.log('  → 握手确认, wsId:', msg.wsId);
      break;

    case 'auth_ok':
      console.log('  → 认证成功');
      authenticated = true;
      break;

    case 'pong':
      const latency = now - lastHeartbeat;
      console.log(`  → Pong 延迟: ${latency}ms`);
      heartbeats.push(latency);
      break;
  }
});

ws.on('error', (err) => {
  console.error('❌ 错误:', err.message);
});

ws.on('close', () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('连接已关闭');
  console.log('='.repeat(60));

  if (heartbeats.length > 0) {
    const avg = heartbeats.reduce((s, v) => s + v, 0) / heartbeats.length;
    console.log(`心跳次数: ${heartbeats.length}`);
    console.log(`平均延迟: ${avg.toFixed(1)}ms`);
    console.log(`最小延迟: ${Math.min(...heartbeats)}ms`);
    console.log(`最大延迟: ${Math.max(...heartbeats)}ms`);
  }

  process.exit(0);
});

// 每 2 秒发送一次 ping
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    lastHeartbeat = Date.now();
    ws.send(JSON.stringify({ type: 'ping' }));
    console.log(`[${Date.now() - startTime}ms] 发送 ping`);
  }
}, 2000);

// 10 秒后关闭
setTimeout(() => {
  console.log('');
  console.log('测试完成，关闭连接...');
  ws.close();
}, 10000);
