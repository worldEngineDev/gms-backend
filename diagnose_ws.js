#!/usr/bin/env node
/**
 * 诊断 WebSocket 压缩问题
 */

const WebSocket = require('ws');

console.log('=== WebSocket 压缩诊断 ===\n');

// 测试 1: 禁用压缩
console.log('测试 1: 客户端禁用压缩 (perMessageDeflate: false)');
const ws1 = new WebSocket('ws://127.0.0.1:8765/ws', {
  perMessageDeflate: false
});

ws1.on('open', () => {
  console.log('  ✅ 连接成功');
});

ws1.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log('  📩 收到:', msg.type);
  if (msg.type === 'connected') {
    ws1.close();

    // 测试 2: 启用压缩
    console.log('\n测试 2: 客户端启用压缩 (默认)');
    const ws2 = new WebSocket('ws://127.0.0.1:8765/ws');

    ws2.on('open', () => {
      console.log('  ✅ 连接成功');
    });

    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      console.log('  📩 收到:', msg.type);
      ws2.close();

      console.log('\n✅ 诊断完成');
      process.exit(0);
    });

    ws2.on('error', (err) => {
      console.log('  ❌ 错误:', err.message);
      console.log('\n结论: 服务器发送了压缩数据，但配置显示已禁用');
      process.exit(0);
    });
  }
});

ws1.on('error', (err) => {
  console.log('  ❌ 错误:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('\n⏱️  测试超时');
  process.exit(1);
}, 5000);
