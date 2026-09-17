#!/usr/bin/env node
/**
 * 最小化测试 - 只测试心跳
 */

const WebSocket = require('ws');
const { execSync } = require('child_process');

const containerIp = execSync('docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" yunwei-app').toString().trim();

console.log('最小化心跳测试');
console.log('容器:', containerIp);
console.log('');

const ws = new WebSocket(`ws://${containerIp}:8765/ws`, {
  perMessageDeflate: false
});

let heartbeatCount = 0;
let firstHeartbeat = 0;
let lastHeartbeat = 0;

ws.on('open', () => {
  console.log('✅ 连接成功');
  console.log('等待心跳...\n');
});

ws.on('ping', () => {
  heartbeatCount++;
  const now = Date.now();

  if (firstHeartbeat === 0) {
    firstHeartbeat = now;
    lastHeartbeat = now;
    console.log(`💓 首次心跳 (#${heartbeatCount})`);
  } else {
    const interval = ((now - lastHeartbeat) / 1000).toFixed(2);
    lastHeartbeat = now;
    console.log(`💓 心跳 #${heartbeatCount}, 间隔: ${interval}秒`);
  }
});

ws.on('error', (err) => {
  console.error('❌', err.message);
});

// 20秒后结束
setTimeout(() => {
  ws.close();

  console.log('\n=== 结果 ===');
  console.log(`收到心跳: ${heartbeatCount} 次`);

  if (heartbeatCount >= 3) {
    const totalTime = (lastHeartbeat - firstHeartbeat) / 1000;
    const avgInterval = totalTime / (heartbeatCount - 1);
    console.log(`平均间隔: ${avgInterval.toFixed(2)}秒`);

    if (avgInterval >= 4.5 && avgInterval <= 5.5) {
      console.log('✅ 优化版工作正常 (5秒心跳)');
    } else if (avgInterval >= 14 && avgInterval <= 16) {
      console.log('❌ 仍是原版 (15秒心跳)');
    } else {
      console.log(`⚠️  异常间隔: ${avgInterval.toFixed(2)}秒`);
    }
  }

  process.exit(0);
}, 20000);
