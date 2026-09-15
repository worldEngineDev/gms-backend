/**
 * ===================================================================
 *  Yunwei RealTime Engine — 微信级实时双向数据引擎
 *
 *  设计目标:
 *    - 消息延迟 < 50ms (局域网内)
 *    - 双通道传输: WebSocket (双向) + SSE (服务端推送)
 *    - 500 并发连接稳定
 *    - 自动重连 + 离线消息队列
 *    - 心跳保活 + 断线检测
 *
 *  传输通道:
 *    WebSocket (/ws)   → 双向实时 (客户端↔服务端)
 *    SSE (/api/sse)    → 服务端单向推送 (兼容旧客户端)
 *
 *  事件类型:
 *    - data:changed      — 数据变更通知 (立即刷新)
 *    - tech:submit       — 新技术支持请求 (运维立即看到)
 *    - tech:respond      — 已响应 (运营立即看到)
 *    - tech:complete     — 维修完成
 *    - user:online       — 用户上线
 *    - user:offline      — 用户下线
 *    - notify:info       — 系统通知
 *    - heartbeat         — 心跳
 * ===================================================================
 */

const { Server: WebSocketServer } = require('ws');
const crypto = require('crypto');
const url = require('url');

// ==================== STATE ====================
let wss = null;
const clients = new Map();          // wsId → clientInfo
const userSockets = new Map();     // userId → Set<ws>
const sseClients = new Set();      // HTTP response objects
const sseUsers = new Map();        // response → authenticated user
const offlineQueue = new Map();    // userId → [{event, data, ts}]

const MAX_OFFLINE_QUEUE = 100;     // 每用户最多缓存 100 条离线消息
const HEARTBEAT_INTERVAL = 15000;  // 15秒心跳
const STALE_TIMEOUT = 45000;       // 45秒无心跳→断开

// S5.2: validateToken injected via init(deps). Null until then — cookie auth
// (authenticateConnection) and message auth (handleAuth) both degrade to
// "wait for client" / "auth unavailable" when not injected (e.g. in tests).
let _validateToken = null;

// S5.2: minimal cookie parser (same logic as server.js parseCookies).
// Duplicated here to keep realtime.js dependency-free (no require of server.js
// — which would create a circular dependency since server.js requires realtime).
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) cookies[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
  });
  return cookies;
}

// ==================== INIT ====================
function init(httpServer, redisModule, deps = {}) {
  // S5.2: inject validateToken for cookie-based WS auth (design A — web path).
  // When injected, wss.on('connection') reads gms_token from the upgrade request
  // cookie and authenticates immediately; mobile clients still send a
  // {type:'auth', token} message as fallback.
  if (deps && deps.validateToken) _validateToken = deps.validateToken;
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,       // 实时消息小, 关闭压缩降低延迟
  });
  // 手动分发升级请求：只接管应用实时通道 /ws。
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

    // 发送握手确认
    safeSend(ws, { type: 'connected', wsId, ts: Date.now() });

    // S5.2: try cookie-based auth first (web primary path — design A).
    // If the upgrade request carries a valid gms_token cookie, authenticate
    // immediately. On failure (no cookie / invalid token), keep
    // info.authenticated=false and wait for the client to send a
    // {type:'auth', token} message (mobile fallback) in handleMessage.
    authenticateConnection(ws, info, req.headers.cookie).catch(() => {});

    // 消息处理
    ws.on('message', (raw) => handleMessage(ws, info, raw));
    ws.on('close', () => handleDisconnect(ws, info));
    ws.on('error', () => {});
    ws.on('pong', () => { ws._alive = true; info.lastHeartbeat = Date.now(); });
  });

  // 心跳检测
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

  // 订阅 Redis Pub/Sub (跨 Worker 广播)
  if (redisModule && redisModule.isConnected()) {
    redisModule.subscribe('realtime:broadcast', (msg) => {
      // 转发给本 Worker 的所有 WebSocket + SSE 客户端
      deliverToAll(msg);
    }).catch(() => {});
  }

  console.log(`[Realtime] ✅ WebSocket + SSE 双通道引擎就绪 (heartbeat: ${HEARTBEAT_INTERVAL}ms)`);
  return wss;
}

// ==================== MESSAGE HANDLER ====================
async function handleMessage(ws, info, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const { type, ...payload } = msg;

  switch (type) {
    case 'auth':
      // 认证: 客户端发 token, 服务端验证
      await handleAuth(ws, info, payload.token);
      break;

    case 'ping':
      safeSend(ws, { type: 'pong', ts: Date.now() });
      break;

    case 'subscribe':
      // 订阅特定事件
      if (payload.events) info.subscriptions = new Set(payload.events);
      break;

    case 'notify':
      // 客户端主动通知 (如"正在输入...")
      if (info.authenticated) {
        deliverToSystem(info.system === 'operations' ? 'maintenance' : 'operations', {
          type: 'notify:typing',
          userId: info.userId,
          username: info.displayName || info.username,
        });
      }
      break;

    case 'chat:message':
      // 实时聊天消息转发
      if (info.authenticated && payload.toUserId) {
        // 查找接收者的 WebSocket 连接并发送
        var targetSockets = userSockets.get(payload.toUserId);
        if (targetSockets) {
          targetSockets.forEach(function(ws) {
            if (ws.readyState === 1) {
              safeSend(ws, {
                type: 'chat:message',
                data: {
                  id: payload.id,
                  senderId: info.userId,
                  senderName: info.displayName || info.username,
                  message: payload.message,
                  createdAt: payload.createdAt,
                }
              });
            }
          });
        }
        // 同时也通过 deliver 广播给接收者（SSE 备用通道也能收到）
        deliver('chat:message', {
          id: payload.id,
          senderId: info.userId,
          senderName: info.displayName || info.username,
          recipientId: payload.toUserId,
          message: payload.message,
          createdAt: payload.createdAt,
        }, { userId: payload.toUserId, force: true });
      }
      break;
  }
}

// ==================== AUTH (S5.2 refactor) ====================
// S5.2: Apply an authenticated user to a connection. Shared by the cookie-auth
// path (authenticateConnection, web) and the message-auth path (handleAuth,
// mobile fallback). Fills info, registers in userSockets, sends auth_ok,
// broadcasts user:online, and delivers queued offline messages.
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

  // 通知其他用户: 此人上线
  broadcastToAll({ type: 'user:online', userId: info.userId, username: info.displayName || info.username }, ws);

  // 投递离线消息
  deliverOfflineMessages(info.userId, ws);
}

// S5.2: cookie-based authentication at WS connection time (design A — web path).
// Reads gms_token from the upgrade request cookie and validates it via the
// injected _validateToken. Returns true on success, false if no valid cookie
// (caller keeps info.authenticated=false and waits for a client auth message).
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

// Message-based auth (mobile/legacy fallback). S5.2: now calls the injected
// _validateToken directly instead of looping back through /api/auth/verify
// (faster, no HTTP roundtrip, no dependency on the HTTP server being reachable
// from the worker). Behavior is equivalent — both paths validate the same token.
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

// ==================== DELIVERY ENGINE ====================
/**
 * 核心投递方法: 同时通过 WebSocket + SSE 双通道发送
 */
function deliver(event, data, options = {}) {
  const message = {
    type: event,
    data,
    ts: Date.now(),
    ...options,
  };

  // 1. 本地 WebSocket 广播
  const payload = JSON.stringify(message);
  wss?.clients.forEach((ws) => {
    if (ws.readyState === 1 && ws._yunweiId) {
      const info = clients.get(ws._yunweiId);
      if (!info || !info.authenticated) return;
      // 检查订阅过滤
      if (info.subscriptions && !info.subscriptions.has(event) && !options.force) return;
      // 检查系统过滤
      if (options.system && info.system !== options.system) return;
      // 检查用户过滤
      if (options.userId && info.userId !== options.userId) return;
      try { ws.send(payload); } catch {}
    }
  });

  // 2. 本地 SSE 广播
  const sseFrame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => {
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) { sseClients.delete(res); return; }
    const user = sseUsers.get(res);
    if (!user) return;
    if (options.system && user.system !== options.system) return;
    if (options.userId && user.userId !== options.userId) return;
    try { res.write(sseFrame); } catch { sseClients.delete(res); }
  });

  // 3. Redis Pub/Sub (跨 Worker)
  // 由 broadcastRealTime() 调用, 避免双重广播
}

/**
 * 全局广播 (所有在线用户)
 */
function broadcastToAll(message, excludeWs = null) {
  const payload = JSON.stringify(message);
  wss?.clients.forEach((ws) => {
    if (ws === excludeWs || ws.readyState !== 1 || !ws._yunweiId) return;
    const info = clients.get(ws._yunweiId);
    if (!info?.authenticated) return;
    try { ws.send(payload); } catch {}
  });

  // SSE
  const sseFrame = `event: ${message.type}\ndata: ${JSON.stringify(message.data || message)}\n\n`;
  sseClients.forEach((res) => {
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) { sseClients.delete(res); sseUsers.delete(res); return; }
    if (!sseUsers.has(res)) return;
    try { res.write(sseFrame); } catch { sseClients.delete(res); }
  });
}

// Redis payloads are published by other workers as either a serialized event
// object or a serialized message. Normalize both forms before local delivery.
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
 * 发送给指定系统 (maintenance / operations)
 */
function deliverToSystem(system, message) {
  deliver(message.type, message.data || message, { system, force: true });
}

/**
 * 发送给指定用户 (所有设备)
 */
function deliverToUser(userId, event, data) {
  // WebSocket
  const sockets = userSockets.get(userId);
  if (sockets && sockets.size > 0) {
    const payload = JSON.stringify({ type: event, data, ts: Date.now() });
    sockets.forEach((ws) => {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch {}
      }
    });
    return; // 在线, 不存离线
  }

  // 离线: 存入离线队列
  if (!offlineQueue.has(userId)) offlineQueue.set(userId, []);
  const queue = offlineQueue.get(userId);
  queue.push({ event, data, ts: Date.now() });
  if (queue.length > MAX_OFFLINE_QUEUE) queue.shift();
}

/**
 * 投递离线消息
 */
function deliverOfflineMessages(userId, ws) {
  const queue = offlineQueue.get(userId);
  if (!queue || queue.length === 0) return;
  const payload = JSON.stringify({ type: 'offline:messages', messages: queue, ts: Date.now() });
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
      // 通知其他人: 用户离线
      broadcastToAll({
        type: 'user:offline',
        userId: info.userId,
        username: info.displayName || info.username,
      });
    }
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

// ==================== API: 由 server.js 调用 ====================
/**
 * 数据变更通知 — 立即推送给所有相关客户端
 * server.js 中所有 mutation 操作后调用此方法
 */
function notifyDataChanged(resource, action, payload) {
  const event = `${resource}:${action}`;  // 例如: "tech_support:created"

  // 同时通过 deliver 推送到 WS + SSE
  deliver(event, payload, { force: true });
}

/**
 * 新技术支持请求 — 运维人员立即收到通知
 */
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

/**
 * 响应通知 — 运营提交人立即看到
 */
function notifyTechResponded(item) {
  deliverToUser(item.submitterId, 'tech:responded', {
    id: item.id,
    responderName: item.responderName,
    respondedAt: item.respondedAt,
  });
}

/**
 * 完成通知 — 运营提交人立即看到
 */
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
    offlineQueues: offlineQueue.size,
    totalOfflineMessages: [...offlineQueue.values()].reduce((s, q) => s + q.length, 0),
  };
}

// ==================== EXPORTS ====================
module.exports = {
  init,
  addSSEClient,
  removeSSEClient,
  getSSEClients: () => sseClients,

  // 投递引擎
  deliver,
  deliverToUser,
  deliverToSystem,
  broadcastToAll,

  // 业务通知 API
  notifyDataChanged,
  notifyNewTechSupport,
  notifyTechResponded,
  notifyTechCompleted,

  // 指标
  getMetrics,

  // S5.2: cookie-based WS auth (exported for unit testing)
  authenticateConnection,
  // S5.2: test-only setter — inject a mock validateToken without calling init()
  // (init() requires an http server + ws lib). Production path injects via init(deps).
  _setValidateToken: (fn) => { _validateToken = fn; },
};
