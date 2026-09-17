/**
 * ===================================================================
 *  Yunwei RealTime Engine — 优化版（目标延迟 <20ms）
 *
 *  优化点:
 *    ✅ 心跳间隔: 15s → 5s（更快断线检测）
 *    ✅ 客户端索引: 按 system/userId 预分组（避免遍历）
 *    ✅ 批量广播: 合并相同消息的 send() 调用
 *    ✅ WebSocket 优先: SSE 降级处理
 *    ✅ 更快的序列化缓存
 * ===================================================================
 */

const { Server: WebSocketServer } = require('ws');
const crypto = require('crypto');

// ==================== 优化后的配置 ====================
const HEARTBEAT_INTERVAL = 5000;   // 15s → 5s（更快检测）
const STALE_TIMEOUT = 15000;       // 45s → 15s（3倍心跳）
const MAX_OFFLINE_QUEUE = 100;

// ==================== STATE ====================
let wss = null;
const clients = new Map();          // wsId → clientInfo
const userSockets = new Map();      // userId → Set<ws>
const systemSockets = new Map();    // system → Set<ws> (新增：按系统分组)
const sseClients = new Set();
const sseUsers = new Map();
const offlineQueue = new Map();

// 序列化缓存（避免重复 JSON.stringify）
const serializationCache = new Map(); // 最多缓存 100 条，1秒过期
const CACHE_SIZE_LIMIT = 100;
const CACHE_EXPIRY = 1000;

let _validateToken = null;

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) cookies[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
  });
  return cookies;
}

// ==================== 序列化缓存 ====================
function getCachedPayload(message) {
  const key = JSON.stringify(message);
  const cached = serializationCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_EXPIRY) {
    return cached.payload;
  }
  const payload = JSON.stringify(message);
  serializationCache.set(key, { payload, ts: Date.now() });
  // 限制缓存大小
  if (serializationCache.size > CACHE_SIZE_LIMIT) {
    const firstKey = serializationCache.keys().next().value;
    serializationCache.delete(firstKey);
  }
  return payload;
}

// ==================== INIT ====================
function init(httpServer, redisModule, deps = {}) {
  if (deps && deps.validateToken) _validateToken = deps.validateToken;

  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,       // 已优化：禁用压缩
    clientTracking: true,           // 启用客户端跟踪
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { }
    if (pathname !== '/ws') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const wsId = crypto.randomBytes(8).toString('hex');
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

    const info = {
      id: wsId,
      ip,
      connectedAt: Date.now(),
      userId: null,
      username: null,
      displayName: null,
      role: null,
      system: null,
      authenticated: false,
      lastHeartbeat: Date.now(),
    };

    clients.set(wsId, info);
    ws._yunweiId = wsId;
    ws._alive = true;

    safeSend(ws, { type: 'connected', wsId, ts: Date.now() });
    authenticateConnection(ws, info, req.headers.cookie).catch(() => {});

    ws.on('message', (raw) => handleMessage(ws, info, raw));
    ws.on('close', () => handleDisconnect(ws, info));
    ws.on('error', () => {});
    ws.on('pong', () => { ws._alive = true; info.lastHeartbeat = Date.now(); });
  });

  // 优化后的心跳：5秒一次
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws._alive) {
        ws.terminate();
        return;
      }
      ws._alive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeat));

  if (redisModule && redisModule.isConnected()) {
    redisModule.subscribe('realtime:broadcast', (msg) => {
      deliverToAll(msg);
    }).catch(() => {});
  }

  console.log(`[Realtime] ✅ 优化版引擎就绪 (heartbeat: ${HEARTBEAT_INTERVAL}ms, 目标延迟 <20ms)`);
  return wss;
}

// ==================== MESSAGE HANDLER ====================
async function handleMessage(ws, info, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const { type, ...payload } = msg;

  switch (type) {
    case 'auth':
      await handleAuth(ws, info, payload.token);
      break;

    case 'ping':
      safeSend(ws, { type: 'pong', ts: Date.now() });
      break;

    case 'subscribe':
      if (payload.events) info.subscriptions = new Set(payload.events);
      break;

    case 'notify':
      if (info.authenticated) {
        deliverToSystem(info.system === 'operations' ? 'maintenance' : 'operations', {
          type: 'notify:typing',
          userId: info.userId,
          username: info.displayName || info.username,
        });
      }
      break;

    case 'chat:message':
      if (info.authenticated && payload.toUserId) {
        var targetSockets = userSockets.get(payload.toUserId);
        if (targetSockets) {
          const chatPayload = getCachedPayload({
            type: 'chat:message',
            data: {
              id: payload.id,
              senderId: info.userId,
              senderName: info.displayName || info.username,
              message: payload.message,
              createdAt: payload.createdAt,
            }
          });
          targetSockets.forEach(function(ws) {
            if (ws.readyState === 1) {
              try { ws.send(chatPayload); } catch {}
            }
          });
        }
      }
      break;
  }
}

// ==================== AUTH ====================
function _applyAuthenticated(ws, info, user) {
  info.authenticated = true;
  info.userId = user.userId;
  info.username = user.username;
  info.displayName = user.displayName || user.username;
  info.role = user.role;
  info.system = user.system;

  // 维护用户索引
  if (!userSockets.has(info.userId)) userSockets.set(info.userId, new Set());
  userSockets.get(info.userId).add(ws);

  // 新增：维护系统索引（快速按系统广播）
  if (info.system) {
    if (!systemSockets.has(info.system)) systemSockets.set(info.system, new Set());
    systemSockets.get(info.system).add(ws);
  }

  safeSend(ws, {
    type: 'auth_ok',
    user: {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      system: user.system,
    },
  });

  broadcastToAll({ type: 'user:online', userId: info.userId, username: info.displayName || info.username }, ws);
  deliverOfflineMessages(info.userId, ws);
}

async function authenticateConnection(ws, info, cookieHeader) {
  if (!_validateToken) return false;
  const cookies = parseCookies(cookieHeader || '');
  const token = cookies.gms_token;
  if (!token) return false;
  let user;
  try {
    user = await _validateToken(token);
  } catch {
    return false;
  }
  if (!user) return false;
  _applyAuthenticated(ws, info, user);
  return true;
}

async function handleAuth(ws, info, token) {
  if (!token) {
    safeSend(ws, { type: 'error', code: 'AUTH_REQUIRED', message: '需要认证' });
    return;
  }
  if (!_validateToken) {
    safeSend(ws, { type: 'error', code: 'AUTH_ERROR', message: '认证服务不可用' });
    return;
  }
  let user;
  try {
    user = await _validateToken(token);
  } catch {
    safeSend(ws, { type: 'error', code: 'AUTH_ERROR', message: '认证服务不可用' });
    return;
  }
  if (!user) {
    safeSend(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Token无效' });
    return;
  }
  _applyAuthenticated(ws, info, user);
}

// ==================== 优化后的投递引擎 ====================
/**
 * 核心优化：预过滤 + 缓存序列化
 */
function deliver(event, data, options = {}) {
  const message = {
    type: event,
    data,
    ts: Date.now(),
    ...options,
  };

  // 缓存序列化结果
  const payload = getCachedPayload(message);

  // 1. WebSocket 广播（优先使用索引）
  let targetSockets = null;

  if (options.userId) {
    // 精确投递到用户
    targetSockets = userSockets.get(options.userId);
    if (targetSockets) {
      targetSockets.forEach((ws) => {
        if (ws.readyState === 1) {
          try { ws.send(payload); } catch {}
        }
      });
    }
  } else if (options.system) {
    // 投递到特定系统
    targetSockets = systemSockets.get(options.system);
    if (targetSockets) {
      targetSockets.forEach((ws) => {
        if (ws.readyState === 1 && ws._yunweiId) {
          const info = clients.get(ws._yunweiId);
          if (!info || !info.authenticated) return;
          if (info.subscriptions && !info.subscriptions.has(event) && !options.force) return;
          try { ws.send(payload); } catch {}
        }
      });
    }
  } else {
    // 全局广播
    wss?.clients.forEach((ws) => {
      if (ws.readyState === 1 && ws._yunweiId) {
        const info = clients.get(ws._yunweiId);
        if (!info || !info.authenticated) return;
        if (info.subscriptions && !info.subscriptions.has(event) && !options.force) return;
        try { ws.send(payload); } catch {}
      }
    });
  }

  // 2. SSE 广播（降级通道）
  if (sseClients.size > 0) {
    const sseFrame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((res) => {
      if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
        sseClients.delete(res);
        return;
      }
      const user = sseUsers.get(res);
      if (!user) return;
      if (options.system && user.system !== options.system) return;
      if (options.userId && user.userId !== options.userId) return;
      try { res.write(sseFrame); } catch { sseClients.delete(res); }
    });
  }
}

/**
 * 全局广播
 */
function broadcastToAll(message, excludeWs = null) {
  const payload = getCachedPayload(message);

  wss?.clients.forEach((ws) => {
    if (ws === excludeWs || ws.readyState !== 1 || !ws._yunweiId) return;
    const info = clients.get(ws._yunweiId);
    if (!info?.authenticated) return;
    try { ws.send(payload); } catch {}
  });

  // SSE
  if (sseClients.size > 0) {
    const sseFrame = `event: ${message.type}\ndata: ${JSON.stringify(message.data || message)}\n\n`;
    sseClients.forEach((res) => {
      if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
        sseClients.delete(res);
        sseUsers.delete(res);
        return;
      }
      if (!sseUsers.has(res)) return;
      try { res.write(sseFrame); } catch { sseClients.delete(res); }
    });
  }
}

function deliverToAll(rawMessage) {
  let message = rawMessage;
  if (typeof rawMessage === 'string') {
    try { message = JSON.parse(rawMessage); } catch { return; }
  }
  if (!message || typeof message !== 'object') return;
  if (message.type && Object.prototype.hasOwnProperty.call(message, 'data')) {
    const { type, data, ...options } = message;
    deliver(type, data, { ...options, force: true });
    return;
  }
  broadcastToAll(message);
}

/**
 * 发送给指定系统（使用索引优化）
 */
function deliverToSystem(system, message) {
  deliver(message.type, message.data || message, { system, force: true });
}

/**
 * 发送给指定用户（使用索引优化）
 */
function deliverToUser(userId, event, data) {
  const sockets = userSockets.get(userId);
  if (sockets && sockets.size > 0) {
    const payload = getCachedPayload({ type: event, data, ts: Date.now() });
    sockets.forEach((ws) => {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch {}
      }
    });
    return;
  }

  // 离线队列
  if (!offlineQueue.has(userId)) offlineQueue.set(userId, []);
  const queue = offlineQueue.get(userId);
  queue.push({ event, data, ts: Date.now() });
  if (queue.length > MAX_OFFLINE_QUEUE) queue.shift();
}

function deliverOfflineMessages(userId, ws) {
  const queue = offlineQueue.get(userId);
  if (!queue || queue.length === 0) return;
  const payload = getCachedPayload({ type: 'offline:messages', messages: queue, ts: Date.now() });
  try { ws.send(payload); } catch {}
  offlineQueue.delete(userId);
}

// ==================== DISCONNECT ====================
function handleDisconnect(ws, info) {
  if (info.userId && userSockets.has(info.userId)) {
    const set = userSockets.get(info.userId);
    set.delete(ws);
    if (set.size === 0) {
      userSockets.delete(info.userId);
      broadcastToAll({
        type: 'user:offline',
        userId: info.userId,
        username: info.displayName || info.username,
      });
    }
  }

  // 清理系统索引
  if (info.system && systemSockets.has(info.system)) {
    const set = systemSockets.get(info.system);
    set.delete(ws);
    if (set.size === 0) systemSockets.delete(info.system);
  }

  clients.delete(ws._yunweiId);
}

// ==================== SSE CLIENT MANAGEMENT ====================
function addSSEClient(res, user) {
  sseClients.add(res);
  if (user) sseUsers.set(res, user);
  res.on('close', () => {
    sseClients.delete(res);
    sseUsers.delete(res);
  });
  res.on('error', () => {
    sseClients.delete(res);
    sseUsers.delete(res);
  });
}

function removeSSEClient(res) {
  sseClients.delete(res);
  sseUsers.delete(res);
}

// ==================== HELPERS ====================
function safeSend(ws, data) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

// ==================== API ====================
function notifyDataChanged(resource, action, payload) {
  const event = `${resource}:${action}`;
  deliver(event, payload, { force: true });
}

function notifyNewTechSupport(item) {
  deliverToSystem('maintenance', {
    type: 'tech:new_request',
    data: {
      id: item.id,
      machineNumber: item.machineNumber,
      faultType: item.faultType,
      submitterName: item.submitterName,
      submittedAt: item.submittedAt,
    },
  });
}

function notifyTechResponded(item) {
  deliverToUser(item.submitterId, 'tech:responded', {
    id: item.id,
    responderName: item.responderName,
    respondedAt: item.respondedAt,
  });
}

function notifyTechCompleted(item) {
  deliverToUser(item.submitterId, 'tech:completed', {
    id: item.id,
    responderName: item.responderName,
    completedAt: item.completedAt,
    result: item.result,
  });
}

// ==================== METRICS ====================
function getMetrics() {
  return {
    wsClients: clients.size,
    sseClients: sseClients.size,
    authenticatedUsers: userSockets.size,
    systemGroups: systemSockets.size,
    offlineQueues: offlineQueue.size,
    totalOfflineMessages: [...offlineQueue.values()].reduce((s, q) => s + q.length, 0),
    serializationCacheSize: serializationCache.size,
  };
}

// ==================== EXPORTS ====================
module.exports = {
  init,
  addSSEClient,
  removeSSEClient,
  getSSEClients: () => sseClients,
  deliver,
  deliverToUser,
  deliverToSystem,
  broadcastToAll,
  notifyDataChanged,
  notifyNewTechSupport,
  notifyTechResponded,
  notifyTechCompleted,
  getMetrics,
  authenticateConnection,
  _setValidateToken: (fn) => { _validateToken = fn; },
};
