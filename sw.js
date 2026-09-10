/**
 * sw.js — Service Worker for GMS
 *
 * 功能：
 *   1. 离线缓存（App Shell 模式）—— 让 TWA / PWA 在无网络时仍可打开
 *   2. Web Push 通知—— 配合 VAPID 公钥接收服务器推送
 *   3. 后台同步—— 恢复网络时自动重试失败的请求
 *
 * 版本：v1.0.0
 */

const SW_VERSION = 'v2.202609100211';
const APP_SHELL_CACHE = `gms-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `gms-runtime-${SW_VERSION}`;

// App Shell：首屏加载所需的核心资源
const APP_SHELL = [
  '/',
  '/index.html',
  '/operations.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/AfterSalesPage-C7lLraIF.js',
  '/assets/AuditLogPage-B1I4VcG8.js',
  '/assets/BatchesPage-Da4TL5rJ.js',
  '/assets/DashboardPage-BQ9l6-z8.js',
  '/assets/DataAnalysisPage-Dma1YUfZ.js',
  '/assets/EquipmentConfigPage-U2xuH77K.js',
  '/assets/HelpPage-DvoHY8La.js',
  '/assets/InventoryAuditPage-Dfsnb_Oo.js',
  '/assets/InventoryConfigPage-DJFaznJL.js',
  '/assets/InventoryPage-CyEwLHdM.js',
  '/assets/MachineLinksPage-xs2-EufI.js',
  '/assets/MachineStatusPage-Cj2Dy1-S.js',
  '/assets/MachinesPage-CRQOnt-9.js',
  '/assets/MyActivityPage-qusqfn67.js',
  '/assets/NotificationsPage-CPCR0LSw.js',
  '/assets/OpsUsersPage-bHpiPqCF.js',
  '/assets/PageContainer-BYjkMDx7.js',
  '/assets/PersonalAnalysisPage-CBpamrVE.js',
  '/assets/PopupMessagesPage-OAZB6f-N.js',
  '/assets/ProfilePage-1S6ATlnj.js',
  '/assets/ReportsPage-BPV2vye6.js',
  '/assets/RequirementsPage-CCMpW5Km.js',
  '/assets/RolesPage-DL9hB3je.js',
  '/assets/SNCodesPage-CTfIOGq3.js',
  '/assets/SNQRCodesPage-Bq0xc97p.js',
  '/assets/SOPPage-CxXajs9B.js',
  '/assets/SettingsPage-C94WGlfl.js',
  '/assets/StocktakePage-B8LfHcTu.js',
  '/assets/StorageLocationsPage-BlF3PrKe.js',
  '/assets/TaskListPage-Cj6TjrYl.js',
  '/assets/TaskProgressPage-BHReZ6O-.js',
  '/assets/TeamMembersPage-DRktnweg.js',
  '/assets/TechSupportMyPage-CjyoUmir.js',
  '/assets/TechSupportPage--FO1F9hl.js',
  '/assets/TechSupportSubmitPage-Cx9kNp5S.js',
  '/assets/TransactionsPage-l8NuEsgv.js',
  '/assets/UsersPage-BSFSIYZt.js',
  '/assets/WarehouseTransfersPage-BncJ16nY.js',
  '/assets/WarehousesPage-U2GzvRHs.js',
  '/assets/antd-CQ220dCv.js',
  '/assets/charts-Bd8kLVyb.js',
  '/assets/format-CYlUgkqq.js',
  '/assets/global-BE0m_MgC.css',
  '/assets/global-BzdKIT3H.js',
  '/assets/index-CJ-UVWM9.js',
  '/assets/inventoryModals-nyBtIG8T.js',
  '/assets/operations-GHIM412i.js',
  '/assets/opsLocalData-BMAuBu-s.js',
  '/assets/react-B7Pwy4PW.js',
  '/assets/txActions-df5BTy0k.js',
  '/assets/useData-zz1xMsHp.js',
];

// ============== INSTALL：预缓存 App Shell ==============
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] Install failed:', err))
  );
});

// ============== ACTIVATE：清理旧缓存，立即接管所有页面 ==============
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          // 删除所有非当前版本的 gms-* 缓存（v1.0.0/v1.0.1 的旧 JS/CSS 缓存全部清除）
          .filter((k) => k.startsWith('gms-') && k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ============== FETCH：缓存优先 + 网络回退 ==============
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 跳过非 GET 请求（POST/PUT/DELETE 等走网络）
  if (req.method !== 'GET') return;

  // 跳过跨域请求（如飞书 API、外部 CDN）
  if (url.origin !== self.location.origin) return;

  // 跳过 SSE / WebSocket / 流式请求
  if (req.headers.get('accept')?.includes('text/event-stream')) return;

  // HTML 文档：网络优先（保证最新版本），失败回退缓存
  if (req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // 静态资源（JS/CSS/图片）：网络优先，保证最新版本，离线时回退缓存
  event.respondWith(
    fetch(req).then((res) => {
      // 缓存成功响应
      if (res && res.status === 200 && res.type !== 'opaque') {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((c) => c))
  );
});

// ============== PUSH：接收服务器推送 ==============
self.addEventListener('push', (event) => {
  let payload = { title: 'GMS 通知', body: '您有新消息', icon: '/icons/icon-192.png' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  const options = {
    body: payload.body,
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [100, 50, 100],
    data: { url: payload.url || '/' },
    tag: payload.tag || 'gms-notification',
    renotify: true,
    requireInteraction: payload.urgent || false,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// ============== NOTIFICATION CLICK：点击跳转 ==============
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const targetUrl = event.notification.data?.url || '/';
      // 复用已打开的窗口
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      // 否则打开新窗口
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ============== SYNC：后台同步（恢复网络后重试） ==============
self.addEventListener('sync', (event) => {
  if (event.tag === 'gms-sync-pending') {
    event.waitUntil(
      clients.matchAll({ includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((c) => c.postMessage({ type: 'RETRY_PENDING' }));
      })
    );
  }
});

// ============== MESSAGE：与页面通信 ==============
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: SW_VERSION });
  }
});
