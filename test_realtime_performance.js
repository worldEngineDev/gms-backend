#!/usr/bin/env node
/**
 * 实时通信性能测试脚本
 * 测试心跳间隔、广播延迟、吞吐量
 */

const WebSocket = require('ws');

const SERVER = 'ws://10.5.51.216:8765/ws';
const NUM_CLIENTS = 50;  // 并发客户端数量

const stats = {
  connected: 0,
  authenticated: 0,
  heartbeats: [],
  broadcasts: [],
  pingPong: [],
  errors: 0,
};

// ==================== 客户端 ====================
function createClient(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER, {
      perMessageDeflate: false  // 匹配服务器设置
    });
    const client = {
      id,
      ws,
      connectedAt: 0,
      lastHeartbeat: 0,
      heartbeatCount: 0,
    };

    ws.on('open', () => {
      client.connectedAt = Date.now();
      stats.connected++;
      console.log(`[客户端 ${id}] 已连接`);
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const now = Date.now();

      switch (msg.type) {
        case 'connected':
          console.log(`[客户端 ${id}] 收到握手确认`);
          // 模拟认证（使用测试 token 或跳过）
          stats.authenticated++;
          break;

        case 'heartbeat':
        case 'pong':
          if (client.lastHeartbeat > 0) {
            const interval = now - client.lastHeartbeat;
            stats.heartbeats.push(interval);
          }
          client.lastHeartbeat = now;
          client.heartbeatCount++;
          break;

        case 'data_changed':
          // 广播消息
          const latency = now - (msg.ts || now);
          stats.broadcasts.push(latency);
          break;
      }
    });

    ws.on('error', (err) => {
      stats.errors++;
      console.error(`[客户端 ${id}] 错误:`, err.message);
    });

    ws.on('close', () => {
      console.log(`[客户端 ${id}] 断开连接`);
    });

    // 等待连接成功
    setTimeout(() => resolve(client), 1000);
  });
}

// ==================== Ping-Pong 测试 ====================
async function testPingPong(client) {
  return new Promise((resolve) => {
    const start = Date.now();
    client.ws.send(JSON.stringify({ type: 'ping' }));

    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'pong') {
        const latency = Date.now() - start;
        stats.pingPong.push(latency);
        client.ws.off('message', handler);
        resolve(latency);
      }
    };

    client.ws.on('message', handler);
    setTimeout(() => resolve(-1), 5000); // 超时
  });
}

// ==================== 统计分析 ====================
function analyze(arr, name) {
  if (arr.length === 0) {
    console.log(`\n${name}: 无数据`);
    return;
  }

  arr.sort((a, b) => a - b);
  const min = arr[0];
  const max = arr[arr.length - 1];
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  const p50 = arr[Math.floor(arr.length * 0.5)];
  const p95 = arr[Math.floor(arr.length * 0.95)];
  const p99 = arr[Math.floor(arr.length * 0.99)];

  console.log(`\n${name}:`);
  console.log(`  样本数: ${arr.length}`);
  console.log(`  最小值: ${min.toFixed(1)} ms`);
  console.log(`  最大值: ${max.toFixed(1)} ms`);
  console.log(`  平均值: ${avg.toFixed(1)} ms`);
  console.log(`  P50: ${p50.toFixed(1)} ms`);
  console.log(`  P95: ${p95.toFixed(1)} ms`);
  console.log(`  P99: ${p99.toFixed(1)} ms`);
}

// ==================== 主流程 ====================
async function main() {
  console.log('='.repeat(60));
  console.log('实时通信性能测试');
  console.log('='.repeat(60));
  console.log(`服务器: ${SERVER}`);
  console.log(`并发客户端: ${NUM_CLIENTS}`);
  console.log();

  // 1. 创建客户端
  console.log('[阶段 1] 创建客户端连接...');
  const clients = [];
  for (let i = 0; i < NUM_CLIENTS; i++) {
    clients.push(await createClient(i));
    await new Promise(r => setTimeout(r, 50)); // 避免瞬时压力
  }
  console.log(`✅ ${stats.connected} 个客户端已连接`);
  console.log(`✅ ${stats.authenticated} 个客户端已认证`);

  // 2. 等待心跳
  console.log('\n[阶段 2] 测试心跳间隔（等待 30 秒）...');
  await new Promise(r => setTimeout(r, 30000));
  console.log(`✅ 收到 ${stats.heartbeats.length} 个心跳`);

  // 3. Ping-Pong 延迟测试
  console.log('\n[阶段 3] 测试 Ping-Pong 延迟...');
  for (const client of clients) {
    const latency = await testPingPong(client);
    if (latency > 0) {
      console.log(`  客户端 ${client.id}: ${latency} ms`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 4. 广播测试（需要手动触发一次数据变更）
  console.log('\n[阶段 4] 广播延迟测试');
  console.log('  提示: 请在另一个终端执行以下命令触发广播:');
  console.log('  curl -X POST http://localhost:8765/api/inventory/glove_left \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"warehouseId":"main","delta":1,"reason":"性能测试"}\'');
  console.log('  等待 10 秒...');
  await new Promise(r => setTimeout(r, 10000));

  // 5. 关闭连接
  console.log('\n[阶段 5] 关闭连接...');
  clients.forEach(c => c.ws.close());
  await new Promise(r => setTimeout(r, 1000));

  // 6. 结果分析
  console.log('\n' + '='.repeat(60));
  console.log('性能测试结果');
  console.log('='.repeat(60));

  analyze(stats.heartbeats, '心跳间隔');
  analyze(stats.pingPong, 'Ping-Pong 延迟');
  analyze(stats.broadcasts, '广播接收延迟');

  console.log(`\n连接成功率: ${(stats.connected / NUM_CLIENTS * 100).toFixed(1)}%`);
  console.log(`认证成功率: ${(stats.authenticated / NUM_CLIENTS * 100).toFixed(1)}%`);
  console.log(`错误数: ${stats.errors}`);

  // 7. 性能评估
  console.log('\n' + '='.repeat(60));
  console.log('性能评估');
  console.log('='.repeat(60));

  const avgHeartbeat = stats.heartbeats.length > 0
    ? stats.heartbeats.reduce((s, v) => s + v, 0) / stats.heartbeats.length
    : 0;
  const avgPingPong = stats.pingPong.length > 0
    ? stats.pingPong.reduce((s, v) => s + v, 0) / stats.pingPong.length
    : 0;

  if (avgHeartbeat < 6000 && avgHeartbeat > 4000) {
    console.log('✅ 心跳间隔符合优化版预期 (5秒)');
  } else if (avgHeartbeat > 14000) {
    console.log('⚠️  心跳间隔符合原版预期 (15秒)，建议升级到优化版');
  } else {
    console.log('⚠️  心跳间隔异常:', avgHeartbeat.toFixed(0), 'ms');
  }

  if (avgPingPong < 10) {
    console.log('✅ Ping-Pong 延迟优秀 (<10ms)');
  } else if (avgPingPong < 20) {
    console.log('✅ Ping-Pong 延迟良好 (10-20ms)');
  } else {
    console.log('⚠️  Ping-Pong 延迟较高 (>20ms)，请检查网络');
  }

  console.log('\n测试完成');
  process.exit(0);
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
