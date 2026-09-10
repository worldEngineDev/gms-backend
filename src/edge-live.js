'use strict';

// 边缘实时缓存：心跳 agent 通过 WebSocket 每 ~2s 推送采集器原始数据
// （5006/health + 5025/api/core/health），服务端存内存供 /live SSE 流消费；
// 业务落库仍走 30s HTTP 心跳，此缓存不参与持久化。

const cache = new Map();
const FRESH_MS = 8000;

function setEdgeLive(machineNumber, data) {
  if (!machineNumber) return;
  cache.set(String(machineNumber).toLowerCase(), { ...data, ts: Date.now() });
}

function getEdgeLive(machineNumber) {
  if (!machineNumber) return null;
  const e = cache.get(String(machineNumber).toLowerCase());
  return e || null;
}

function isEdgeLiveFresh(machineNumber) {
  const e = getEdgeLive(machineNumber);
  return !!(e && e.core && Date.now() - e.ts < FRESH_MS);
}

function markEdgeWsConnected(machineNumber, connected) {
  const e = getEdgeLive(machineNumber);
  if (e) e.wsConnected = !!connected;
}

module.exports = { setEdgeLive, getEdgeLive, isEdgeLiveFresh, markEdgeWsConnected };
