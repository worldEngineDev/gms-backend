// SSE 实时通道管理器（移植自 js/api.js _listenSSE/_startPolling/_startTokenHeartbeat/_startVersionCheck）
// 事件到达后通过 invalidateForEvent 精准失效 TanStack Query 缓存
import { invalidateForEvent, queryClient } from '../query';
import { get } from '../api/http';

const BUSINESS_EVENTS = [
  'inventory_updated', 'machines_updated', 'transactions_updated',
  'settings_updated', 'equipment_config_updated', 'inventory_config_updated',
  'users_updated', 'sn_registry_updated', 'tech_support_updated',
  'group_transfer_updated', 'ops_orders_updated', 'ops_customers_updated',
  'ops_production_updated', 'audit_log_updated', 'storage_locations_updated',
  'machine_bindings_updated', 'machine_presence_updated',
  'machine_live_updated',
];

let es: EventSource | null = null;
let sseFailures = 0;
let sseLastFail = 0;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let resumeTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let versionTimer: ReturnType<typeof setInterval> | null = null;
let safetyTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
  if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
}

function startPolling() {
  if (es) { es.close(); es = null; }
  if (pollingTimer) return;
  console.log('[SSE] Falling back to polling mode');
  pollingTimer = setInterval(async () => {
    try {
      await get('/api/sync', 8000);
      queryClient.invalidateQueries();
    } catch { /* ignore */ }
  }, 15000);
  // 服务器重启/网络恢复后自动切回 SSE：每 60 秒探测一次，成功则停轮询恢复实时推送
  // （否则降级是永久的——页面不刷新就再也收不到实时事件）
  if (!resumeTimer) {
    resumeTimer = setInterval(attemptResumeSSE, 60_000);
  }
}

/** 探测 SSE 是否可用：连接成功 → 停轮询、重建正式监听；失败 → 继续等下一轮 */
function attemptResumeSSE(): void {
  try {
    const probe = new EventSource('/api/events');
    let settled = false;
    const cleanup = () => { if (!settled) { settled = true; probe.close(); } };
    probe.onopen = () => {
      cleanup();
      console.log('[SSE] Server recovered, resuming realtime mode');
      stopPolling();
      startSSE();
    };
    probe.onerror = cleanup;
    // 探测超时保护：10 秒内没连上就放弃本轮
    setTimeout(cleanup, 10_000);
  } catch { /* EventSource 不可用时忽略，等下一轮 */ }
}

export function startSSE(): void {
  stopSSE(false);
  sseFailures = 0;
  try {
    es = new EventSource('/api/events');
    const onEvent = (name: string) => (e: MessageEvent) => {
      let payload: any;
      try { payload = e.data ? JSON.parse(e.data) : undefined; } catch { payload = undefined; }
      invalidateForEvent(name, payload);
      // 转发给需要原始数据的组件（如聊天挂件）
      window.dispatchEvent(new CustomEvent(`gms_event:${name}`, { detail: payload }));
    };
    BUSINESS_EVENTS.forEach(name => es!.addEventListener(name, onEvent(name)));
    es.addEventListener('data_changed', onEvent('data_changed'));
    es.addEventListener('chat:message', (e: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      window.dispatchEvent(new CustomEvent('gms_event:chat:message', { detail: msg }));
    });
    es.onopen = () => { sseFailures = 0; sseLastFail = 0; };
    es.onerror = () => {
      const now = Date.now();
      sseFailures = now - sseLastFail < 60000 ? sseFailures + 1 : 1;
      sseLastFail = now;
      if (sseFailures >= 3) startPolling();
    };
  } catch {
    startPolling();
  }

  // token 心跳：5 分钟一次保持滑动窗口会话（401 由 http 层触发重新登录提示）
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => { get('/api/settings', 5000).catch(() => {}); }, 5 * 60 * 1000);
  }
  // 版本检测：服务器更新时提示刷新
  if (!versionTimer) {
    checkVersion();
    versionTimer = setInterval(checkVersion, 5 * 60 * 1000);
  }
  // 兜底：仅低频刷新当前活跃查询。正常情况下数据由 SSE 事件驱动，
  // 过于频繁地全量失效会让每个在线页面同时请求 /api/sync，造成前端卡顿。
  if (!safetyTimer) {
    safetyTimer = setInterval(() => { queryClient.invalidateQueries(); }, 120000);
  }
}

export function stopSSE(clearTimers = true): void {
  if (es) { es.close(); es = null; }
  if (clearTimers) {
    stopPolling();
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (versionTimer) { clearInterval(versionTimer); versionTimer = null; }
    if (safetyTimer) { clearInterval(safetyTimer); safetyTimer = null; }
  }
}

async function checkVersion(): Promise<void> {
  try {
    const data = await get<{ version: string }>('/api/version', 3000);
    const serverVersion = data.version;
    const localVersion = localStorage.getItem('gms_version');
    if (!localVersion) {
      localStorage.setItem('gms_version', serverVersion);
      return;
    }
    if (serverVersion !== localVersion) {
      window.dispatchEvent(new CustomEvent('gms_version_update', { detail: { version: serverVersion } }));
    }
  } catch { /* 忽略网络错误 */ }
}
