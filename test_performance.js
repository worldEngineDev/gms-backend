#!/usr/bin/env node
/**
 * 性能基准测试 - 心跳间隔和延迟
 */

const WebSocket = require('ws');

console.log('='.repeat(60));
console.log('实时通信性能测试 - 优化版');
console.log('='.repeat(60));
console.log('');

const ws = new WebSocket('ws://127.0.0.1:8765/ws', {
  perMessageDeflate: false
});

let startTime = 0;
const heartbeats = [];
const pongLatencies = [];
let lastPing = 0;

ws.on('open', () => {
  startTime = Date.now();
  console.log('✅ 连接成功');
  console.log('');
  console.log('开始测试...');
  console.log('  - 测试时长: 30秒');
  console.log('  - 期望心跳间隔: 5秒（优化版）');
  console.log('');
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const now = Date.now();
  const elapsed = ((now - startTime) / 1000).toFixed(1);

  if (msg.type === 'connected') {
    console.log(`[${elapsed}s] 收到握手确认`);
  } else if (msg.type === 'pong') {
    const latency = now - lastPing;
    pongLatencies.push(latency);
    console.log(`[${elapsed}s] Pong 延迟: ${latency}ms`);
  }
});

// 收到服务器的 ping（通过 ws.on('ping') 事件）
ws.on('ping', () => {
  const now = Date.now();
  const elapsed = ((now - startTime) / 1000).toFixed(1);

  if (heartbeats.length > 0) {
    const interval = (now - heartbeats[heartbeats.length - 1]) / 1000;
    console.log(`[${elapsed}s] 💓 心跳间隔: ${interval.toFixed(2)}秒`);
  } else {
    console.log(`[${elapsed}s] 💓 首次心跳`);
  }

  heartbeats.push(now);
});

// 每2秒发送一次 ping 测试延迟
const pingInterval = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    lastPing = Date.now();
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 2000);

// 30秒后结束测试
setTimeout(() => {
  clearInterval(pingInterval);
  ws.close();

  console.log('');
  console.log('='.repeat(60));
  console.log('测试结果');
  console.log('='.repeat(60));

  // 分析心跳间隔
  if (heartbeats.length > 1) {
    const intervals = [];
    for (let i = 1; i < heartbeats.length; i++) {
      intervals.push((heartbeats[i] - heartbeats[i-1]) / 1000);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const minInterval = Math.min(...intervals);
    const maxInterval = Math.max(...intervals);

    console.log('');
    console.log('心跳统计:');
    console.log(`  收到心跳次数: ${heartbeats.length}`);
    console.log(`  平均间隔: ${avgInterval.toFixed(2)}秒`);
    console.log(`  最小间隔: ${minInterval.toFixed(2)}秒`);
    console.log(`  最大间隔: ${maxInterval.toFixed(2)}秒`);

    if (avgInterval >= 4.5 && avgInterval <= 5.5) {
      console.log('  ✅ 心跳间隔符合优化版预期 (5秒)');
    } else if (avgInterval >= 14 && avgInterval <= 16) {
      console.log('  ⚠️  心跳间隔是原版配置 (15秒)');
    } else {
      console.log(`  ⚠️  心跳间隔异常: ${avgInterval.toFixed(2)}秒`);
    }
  }

  // 分析 Pong 延迟
  if (pongLatencies.length > 0) {
    const avgLatency = pongLatencies.reduce((s, v) => s + v, 0) / pongLatencies.length;
    const minLatency = Math.min(...pongLatencies);
    const maxLatency = Math.max(...pongLatencies);

    console.log('');
    console.log('Ping-Pong 延迟:');
    console.log(`  测试次数: ${pongLatencies.length}`);
    console.log(`  平均延迟: ${avgLatency.toFixed(1)}ms`);
    console.log(`  最小延迟: ${minLatency}ms`);
    console.log(`  最大延迟: ${maxLatency}ms`);

    if (avgLatency < 10) {
      console.log('  ✅ 延迟优秀 (<10ms)');
    } else if (avgLatency < 20) {
      console.log('  ✅ 延迟良好 (10-20ms)');
    } else {
      console.log('  ⚠️  延迟较高 (>20ms)');
    }
  }

  console.log('');
  process.exit(0);
}, 30000);

ws.on('error', (err) => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
