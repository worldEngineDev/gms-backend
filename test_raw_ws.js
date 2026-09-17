#!/usr/bin/env node
/**
 * 使用 wscat 风格的原始测试
 */

const net = require('net');
const crypto = require('crypto');

const host = '172.18.0.3';
const port = 8765;

console.log(`连接到 ${host}:${port}`);

const client = net.createConnection({ host, port }, () => {
  console.log('TCP 连接成功');

  // 发送 WebSocket 握手
  const key = crypto.randomBytes(16).toString('base64');
  const handshake = [
    `GET /ws HTTP/1.1`,
    `Host: ${host}:${port}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: 13`,
    ``,
    ``
  ].join('\r\n');

  console.log('发送握手...\n');
  client.write(handshake);
});

let buffer = Buffer.alloc(0);
let handshakeComplete = false;

client.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);

  if (!handshakeComplete) {
    const str = buffer.toString();
    if (str.includes('\r\n\r\n')) {
      console.log('收到握手响应:');
      const headers = str.split('\r\n\r\n')[0];
      console.log(headers);

      // 检查 Sec-WebSocket-Extensions
      if (headers.includes('Sec-WebSocket-Extensions')) {
        const extLine = headers.split('\n').find(l => l.includes('Sec-WebSocket-Extensions'));
        console.log('\n⚠️  服务器返回了扩展:', extLine);
      } else {
        console.log('\n✅ 没有压缩扩展');
      }

      handshakeComplete = true;
      buffer = buffer.slice(str.indexOf('\r\n\r\n') + 4);

      console.log('\n等待 WebSocket 帧...');
    }
  } else {
    // 解析 WebSocket 帧
    if (buffer.length >= 2) {
      const byte0 = buffer[0];
      const byte1 = buffer[1];

      const fin = (byte0 & 0x80) !== 0;
      const rsv1 = (byte0 & 0x40) !== 0;
      const rsv2 = (byte0 & 0x20) !== 0;
      const rsv3 = (byte0 & 0x10) !== 0;
      const opcode = byte0 & 0x0F;

      console.log('\n收到 WebSocket 帧:');
      console.log(`  FIN: ${fin}, RSV1: ${rsv1}, RSV2: ${rsv2}, RSV3: ${rsv3}`);
      console.log(`  Opcode: ${opcode} (${opcode === 1 ? 'Text' : opcode === 2 ? 'Binary' : opcode === 9 ? 'Ping' : 'Other'})`);

      if (rsv1) {
        console.log('\n❌ 问题确认: RSV1=1 表示启用了压缩');
        console.log('   但服务器配置了 perMessageDeflate: false');
        console.log('   这可能是 ws 库的 bug');
      } else {
        console.log('\n✅ RSV1=0, 没有压缩');
      }

      client.end();
      process.exit(0);
    }
  }
});

client.on('error', (err) => {
  console.error('错误:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('\n超时');
  client.end();
  process.exit(1);
}, 5000);
