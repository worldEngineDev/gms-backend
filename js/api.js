/**
 * API Client Layer
 * Communicates with the backend server when available, falls back to localStorage.
 * Provides the same interface as the original Storage object.
 */
const API = {
  baseURL: '',
  token: null,
  currentUser: null,
  online: false,
  eventSource: null,
  _refreshTimer: null,
  // S4.5: CSRF token (memory only — fetched from /api/csrf-token on init/login)
  csrfToken: null,

  async init() {
    // S5.3 (design A): Web auth token lives ONLY in the HttpOnly gms_token cookie.
    // Never read it from localStorage, never keep it in JS memory — XSS cannot
    // steal what isn't there. this.token stays null for web; mobile (/api/mobile/auth)
    // still sets it in-memory for Bearer auth (separate native client, no localStorage risk).
    this.token = null;
    this.currentUser = JSON.parse(localStorage.getItem('gms_user') || sessionStorage.getItem('gms_user') || 'null');

    // ========== 分布式配置初始化 ==========
    // 初始化分布式模块，选择最佳服务器
    if (typeof DistributedConfig !== 'undefined') {
      const server = DistributedConfig.init();
      if (server && server.url) {
        this.baseURL = server.url;
        console.log('[API] 分布式模式，当前服务器:', server.name, server.url);
      } else {
        this.baseURL = window.__GMS_SERVER_URL__ || window.location.origin;
      }
    } else {
      this.baseURL = window.__GMS_SERVER_URL__ || window.location.origin;
    }

    // S5.3: patch window.fetch once per page load so ALL outbound requests
    // (including 40+ direct fetch() call sites in app.js/operations.js) carry
    // credentials=same-origin (for the HttpOnly cookie) + X-CSRF-Token header.
    // Must run before any fetch below relies on the cookie.
    this._patchGlobalFetch();

    // Fast switch: system switcher set this flag — skip health check, assume online
    // S5.3: guard on online only (was `fastSwitch && this.token` — token is now null for web)
    const fastSwitch = localStorage.getItem('gms_fast_switch');
    if (fastSwitch) {
      localStorage.removeItem('gms_fast_switch');
      this.online = true;
    } else {
      this.online = await this._checkServer();
    }

    // Auto-restore currentUser from login history (same device, within 24h).
    // S5.3: token is no longer restored — the HttpOnly cookie (7-day TTL) is the
    // session authority and is sent automatically by the browser on every request.
    if (!this.currentUser) {
      const hist = this._getLoginHistory();
      if (hist) {
        this.currentUser = { username: hist.username, role: hist.role, system: hist.system };
        localStorage.setItem('gms_user', JSON.stringify(this.currentUser));
      }
    }

    // 即使 _checkServer 失败，也尝试验证 cookie — 如果有效则恢复 online 状态
    // S5.3: rely on cookie auth (no Bearer header); _fetchWithTimeout sends credentials.
    if (!this.online) {
      try {
        const res = await this._fetchWithTimeout(`${this.baseURL  }/api/settings`, {}, 3000);
        if (res.ok) {
          this.online = true;
          console.log('[API] Cookie 验证成功，恢复在线状态');
        } else if (res.status === 401) {
          this.logout('session_expired');
          return true;
        }
      } catch {}
    }

    // S5 FIX: sync online status to GMSStore/RemoteAdapter.
    // Previously only called in login(), so cookie-based auto-restore (the common
    // path when a user already has a valid HttpOnly cookie from a prior session)
    // left RemoteAdapter.online = false. This caused ALL SSE-triggered syncs
    // (silentSync → Storage._syncFromServer → GMSStore.syncFromServer) to silently
    // return null at the `if (!remote.online) return null` guard — the root cause
    // of "machine status not updating when bringing gloves online via SN code link".
    if (this.online && typeof GMSStore !== 'undefined') {
      GMSStore.setOnline(true);
    }

    // S5.3: guard on online only (was `this.online && this.token` — token is null for web)
    if (this.online) {
      const valid = await this._validateToken();
      if (!valid) {
        // Cookie session invalid (server restarted / cookie expired) — force re-login
        this.logout('session_expired');
        return true; // Still online, just need fresh login
      }
      // S4.5: Fetch CSRF token after auth — needed for non-GET requests when CSRF_ENFORCED=true
      this._fetchCSRFToken();
      this._listenSSE();
      this._setupBeforeUnload();
      this._startVersionCheck(); // 启动版本检测，服务器更新时自动刷新
    }
    return this.online;
  },

  // S4.5: Fetch CSRF token from /api/csrf-token, store in memory (this.csrfToken)
  // Also auto-refreshes before 1h expiry. Best-effort — failures logged but not blocking.
  // S5.3: guard on online (was `!this.token` — token is null for web). Auth via cookie
  // (credentials sent by _fetchWithTimeout); Bearer header only added when token exists
  // (mobile path via /api/mobile/auth keeps this.token in-memory).
  async _fetchCSRFToken() {
    if (!this.online) return;
    try {
      const headers = {};
      if (this.token) headers['Authorization'] = `Bearer ${  this.token}`;
      const res = await this._fetchWithTimeout(`${this.baseURL  }/api/csrf-token`, {
        method: 'GET',
        headers,
        credentials: 'same-origin', // S4.6: ensure cookies (gms_csrf) are sent/received
      }, 5000);
      if (res.ok) {
        const data = await res.json();
        if (data.csrfToken) {
          this.csrfToken = data.csrfToken;
          // Refresh 5 min before expiry (TTL=1h)
          if (this._csrfRefreshTimer) clearTimeout(this._csrfRefreshTimer);
          this._csrfRefreshTimer = setTimeout(() => this._fetchCSRFToken(), 55 * 60 * 1000);
        }
      }
    } catch (e) {
      console.warn('[API] Failed to fetch CSRF token:', e.message);
    }
  },

  // S4.6: Patch window.fetch to auto-inject credentials + X-CSRF-Token header on all
  // outbound requests. Done once per page load — covers the 40+ direct fetch() call
  // sites in app.js/operations.js/store/ that bypass API._fetch().
  // Safe because the system only talks to its own backend (no third-party fetch).
  _patchGlobalFetch() {
    if (typeof window === 'undefined' || window._gmsFetchPatched) return;
    const originalFetch = window.fetch;
    const self = this;
    // CSRF 403 自动恢复：cookie 为全域共享，多标签页/页面重载后内存 token 可能与
    // cookie 不一致（其他页面重新签发过）。检测到 CSRF 拒绝时重新获取 token 并重试一次。
    const isCsrfReject = async (resp) => {
      if (!resp || resp.status !== 403) return false;
      try {
        const clone = resp.clone();
        const data = await clone.json();
        return !!(data && typeof data.error === 'string' && data.error.indexOf('CSRF') >= 0);
      } catch { return false; }
    };
    window.fetch = async function(url, options = {}) {
      const doFetch = (tokenOverride) => {
        const opts = { credentials: 'same-origin', ...options };
        // Auto-inject X-CSRF-Token on non-GET requests
        const m = (opts.method || (options && options.method) || 'GET').toUpperCase();
        const tk = tokenOverride || self.csrfToken;
        if (tk && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
          opts.headers = { ...(opts.headers || {}), 'X-CSRF-Token': tk };
        }
        return originalFetch.call(this, url, opts);
      };
      let res = await doFetch();
      if (await isCsrfReject(res)) {
        await self._fetchCSRFToken();
        if (self.csrfToken) res = await doFetch(self.csrfToken);
      }
      return res;
    };
    window._gmsFetchPatched = true;
    console.log('[API] Global fetch patched with credentials=same-origin + CSRF header injection');
  },

  async _checkServer() {
    // Retry up to 2 times for LAN reliability
    for (let i = 0; i < 2; i++) {
      try {
        const res = await this._fetchWithTimeout(`${this.baseURL  }/api/health`, {}, 3000); // 缩短超时
        if (res.ok) return true;
      } catch {}
      if (i < 1) await new Promise(r => setTimeout(r, 500)); // 缩短重试间隔
    }
    return false;
  },

  async _validateToken() {
    // S5.3: rely on HttpOnly cookie auth (no Bearer header). _fetchWithTimeout
    // sends credentials=same-origin so the gms_token cookie is included.
    try {
      const res = await this._fetchWithTimeout(`${this.baseURL  }/api/settings`, {}, 3000);
      return res.ok;
    } catch { return false; }
  },

  async login(username, password, manualMachineCode = null) {
    // Always try server first, regardless of online status
    // The init() checkServer may not have completed yet when user clicks login
    try {
      let machineCode = manualMachineCode;
      if (!machineCode) {
        try {
          const mcRes = await this._fetchWithTimeout(`${this.baseURL  }/api/machine-code`, { method: 'GET' }, 3000);
          const mcData = await mcRes.json();
          machineCode = mcData.machineCode;
        } catch {}
      }
      const res = await this._fetchWithTimeout(`${this.baseURL  }/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, machineCode })
      }, 10000); // BUGFIX: 5s→10s，scrypt 验证 + DB 查询在服务器负载高时可能超时
      const data = await res.json();
      if (res.ok) {
        // S5.3 (design A): server sets the HttpOnly gms_token cookie (7-day TTL) via
        // Set-Cookie on this response — that is the sole session authority for web.
        // Do NOT store the token in localStorage or keep it in JS memory (XSS cannot
        // steal what isn't there). this.token stays null; all subsequent HTTP/WS auth
        // rides the cookie. Mobile (/api/mobile/auth) is a separate path that still
        // keeps the token in-memory for Bearer auth.
        this.token = null;
        this.currentUser = data.user;
        this.online = true;
        localStorage.setItem('gms_user', JSON.stringify(data.user));
        this._saveLoginHistory(data.user);
        // BUGFIX: 登录成功后的初始化代码（SSE/CSRF/WS等）必须独立 try-catch，
        // 否则任何异常会被外层 catch 捕获，导致 fallthrough 到离线登录路径，
        // 离线登录用 SHA-256 对比 scrypt 哈希必然失败，用户看到"用户名或密码错误"
        // 但实际上服务器已成功设置了 HttpOnly cookie（刷新即登录）
        try {
          this._listenSSE();
          this._setupBeforeUnload();
          // S4.5: Fetch CSRF token after successful login
          this._fetchCSRFToken();
          // Sync store with new credentials
          if (typeof GMSStore !== 'undefined') {
            GMSStore.setToken(null);
            GMSStore.setOnline(true);
          }
          // 记住登录态（Cookie 7天有效）
          this._setCookie('gms_logged', '1', 7);
          // 微信级实时: 启动 WebSocket 双向通信
          // S5.3: pass null — WS authenticates via the HttpOnly cookie at handshake
          // (realtime.js authenticateConnection), not via an auth message.
          if (typeof Realtime !== 'undefined') {
            Realtime.init(null);
            Realtime.requestNotificationPermission();
            this._listenWS();
          }
        } catch (initErr) {
          console.warn('[API] Post-login init error (non-fatal):', initErr.message);
        }
        return { success: true, user: data.user, token: data.token };
      }
      return { success: false, message: data.error };
    } catch (e) {
      // Server unreachable, fall through to offline
      console.warn('[API] Login request failed:', e?.message || e);
    }

    // Offline login: check against localStorage users
    const users = Storage.getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, message: '用户名或密码错误' };

    const hash = await this._hashPassword(password);
    if (hash !== user.passwordHash) return { success: false, message: '用户名或密码错误' };

    this.currentUser = { username: user.username, role: user.role, system: user.system || 'maintenance' };
    this.online = false;
    localStorage.setItem('gms_user', JSON.stringify(this.currentUser));
    localStorage.removeItem('gms_token'); sessionStorage.removeItem('gms_token');
    this._saveLoginHistory(this.currentUser);
    return { success: true, user: this.currentUser };
  },

  async _hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${password  }gms-salt`);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  logout(reason) {
    // S5.3: call /api/logout to clear the HttpOnly gms_token cookie (server sets
    // Set-Cookie: Max-Age=0) AND invalidate the server-side token. Fire-and-forget
    // (no await) so logout works instantly even if the server is unreachable — local
    // state is cleared below regardless. /api/logout is a public endpoint so it
    // succeeds even when the session cookie is already expired.
    //
    // BUGFIX: 当 reason='session_expired' 时（init() 检测到 cookie 失效调用），
    // 1) 不发送 logout POST — session 已经过期，无需服务端清除；发送反而可能与
    //    后续 login POST 竞态，导致刚设置的 cookie 被清除（刷新即登录的根因之一）
    // 2) 不设置 online=false — 服务器仍在线，仅 session 过期需要重新登录
    const isSessionExpired = reason === 'session_expired';
    if (!isSessionExpired) {
      try {
        this._fetchWithTimeout(`${this.baseURL  }/api/logout`, { method: 'POST' }, 3000).catch(() => {});
      } catch {}
    }
    this.token = null;
    this.currentUser = null;
    // session 过期时保持 online 状态，仅用户主动登出才设 offline
    if (!isSessionExpired) {
      this.online = false;
    }
    // S5.3: defensive cleanup of any stale tokens from the pre-S5 localStorage scheme.
    // New code never writes gms_token to localStorage, but old browser tabs may still
    // have one from before the migration — clear it here.
    localStorage.removeItem('gms_token'); sessionStorage.removeItem('gms_token');
    localStorage.removeItem('gms_user'); sessionStorage.removeItem('gms_user');
    localStorage.removeItem('gms_login_history');
    localStorage.removeItem('gms_login_token');
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    // S4.5: clear CSRF token + refresh timer on logout
    this.csrfToken = null;
    if (this._csrfRefreshTimer) { clearTimeout(this._csrfRefreshTimer); this._csrfRefreshTimer = null; }
    // Clear all periodic timers
    if (this._autoRefreshInterval) { clearInterval(this._autoRefreshInterval); this._autoRefreshInterval = null; }
    if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
    if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
    // Sync store: mark offline, clear token
    if (typeof GMSStore !== 'undefined') {
      GMSStore.setToken(null);
      GMSStore.setOnline(false);
    }
  },

  _setupBeforeUnload() {
    // No beacon on unload — token expires naturally after 3 min inactivity.
    // Previously caused redirect-loop because navigating index→operations
    // would delete the token before operations could validate it.
  },

  _getDeviceId() {
    let id = localStorage.getItem('gms_device_id');
    if (!id) { id = `dev-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem('gms_device_id', id); }
    return id;
  },

  _saveLoginHistory(user) {
    const history = { username: user.username, role: user.role, system: user.system || 'maintenance', deviceId: this._getDeviceId(), loginAt: Date.now() };
    localStorage.setItem('gms_login_history', JSON.stringify(history));
    // S5.3: no longer persist the token — the HttpOnly cookie (7-day TTL) is the
    // session authority and survives page refreshes. gms_login_token removed.
  },

  _getLoginHistory() {
    try {
      const data = JSON.parse(localStorage.getItem('gms_login_history'));
      if (!data) return null;
      const elapsed = Date.now() - data.loginAt;
      if (elapsed > 24 * 60 * 60 * 1000) { localStorage.removeItem('gms_login_history'); return null; }
      if (data.deviceId !== this._getDeviceId()) { localStorage.removeItem('gms_login_history'); return null; }
      return data;
    } catch { return null; }
  },

  _listenSSE() {
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
    // Start periodic auto-refresh safety net (every 30s)
    this._startAutoRefresh();
    // Start token heartbeat (every 10min to keep session alive)
    this._startTokenHeartbeat();

    this._sseFailures = 0;
    this._sseLastFail = 0;

    try {
      this.eventSource = new EventSource(`${this.baseURL  }/api/events`);
      // Helper: sync data silently, then do targeted UI patch (no innerHTML clear)
      // Uses a SINGLE shared timer so an event storm (multiple *_updated from one
      // operation) collapses into ONE /api/sync call. Phase 1.2: backend now sends
      // a single `data_changed` umbrella event for multi-side-effect operations,
      // but legacy *_updated events still arrive from non-migrated paths — the
      // shared timer dedupes both.
      const silentSync = () => {
        if (this._syncTimer) clearTimeout(this._syncTimer);
        const restoring = (typeof App !== 'undefined' && App._restoring)
                       || (typeof OpsApp !== 'undefined' && OpsApp._restoring);
        this._syncTimer = setTimeout(async () => {
          if (API.online && !restoring) {
            await Storage._syncFromServer();
            this._notifyUIUpdate();
          }
        }, 1000); // 1s 防抖：事件风暴合并为一次 /api/sync（服务端 10s 缓存兜底）
      };
      const silentSyncCfg = () => {
        if (this._syncCfgTimer) clearTimeout(this._syncCfgTimer);
        this._syncCfgTimer = setTimeout(async () => {
          if (API.online) {
            await Storage._syncFromServer();
            if (typeof App !== 'undefined' && App.refreshSidebarInventory) App.refreshSidebarInventory();
            this._notifyUIUpdate();
          }
        }, 300); // 300ms 防抖，配置变更快速生效
      };
      this.eventSource.addEventListener('inventory_updated', silentSync);
      this.eventSource.addEventListener('machines_updated', silentSync);
      this.eventSource.addEventListener('machine_presence_updated', silentSync);
      this.eventSource.addEventListener('transactions_updated', silentSync);
      this.eventSource.addEventListener('settings_updated', silentSync);
      this.eventSource.addEventListener('equipment_config_updated', silentSyncCfg);
      this.eventSource.addEventListener('inventory_config_updated', silentSyncCfg);
      this.eventSource.addEventListener('users_updated', silentSync);
      this.eventSource.addEventListener('sn_registry_updated', silentSync);
      this.eventSource.addEventListener('audit_log_updated', silentSync);
      this.eventSource.addEventListener('storage_locations_updated', silentSync);
      this.eventSource.addEventListener('ops_orders_updated', silentSync);
      this.eventSource.addEventListener('ops_customers_updated', silentSync);
      this.eventSource.addEventListener('ops_production_updated', silentSync);
      this.eventSource.addEventListener('tech_support_updated', (e) => {
        this._syncTechSupport();
      });
      // Phase 1.2: 统一伞形事件 — 后端一次操作只发一个 data_changed（main + sideEffects），
      // 替代原来一次操作连发 4 个 *_updated。前端据此做定向刷新：
      //  - main='tech_support' → 定向拉取 /api/tech-support（比 /api/sync 轻量，立即刷新工单列表）
      //  - 其他 → 走 silentSync 统一防抖同步
      // sideEffects 始终触发 silentSync（合并到一次 /api/sync，覆盖 machines/inventory 等）
      this.eventSource.addEventListener('data_changed', (e) => {
        let payload = {};
        try { payload = JSON.parse(e.data || '{}'); } catch {}
        const main = payload.main;
        const sideEffects = Array.isArray(payload.sideEffects) ? payload.sideEffects : [];
        // 主事件定向处理（仅 tech_support 有更轻量的定向接口）
        if (main === 'tech_support') {
          this._syncTechSupport();
        }
        // 副作用（含 main 自身的 machines/inventory 等数据）走统一防抖同步
        if (sideEffects.length > 0 || main !== 'tech_support') {
          silentSync();
        }
      });
      this.eventSource.addEventListener('group_transfer_updated', silentSync);
      this.eventSource.onopen = () => {
        // SSE connected — reset failure counter
        this._sseFailures = 0;
        this._sseLastFail = 0;
        console.log('[SSE] Connected successfully');
      };
      this.eventSource.onerror = () => {
        const now = Date.now();
        if (now - this._sseLastFail < 60000) {
          this._sseFailures++;
        } else {
          this._sseFailures = 1;
        }
        this._sseLastFail = now;
        console.warn('[SSE] Error, failure count:', this._sseFailures);
        // If SSE fails 3+ times within 60s, fall back to polling
        if (this._sseFailures >= 3) {
          console.log('[SSE] Falling back to polling mode');
          this._startPolling();
        }
      };
    } catch (e) {
      // SSE not supported, fall back to polling immediately
      this._startPolling();
    }
  },

  // Polling fallback when SSE is unavailable (e.g. behind CloudBase gateway)
  _startPolling() {
    if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
    if (this._pollingInterval) return; // already polling
    console.log('[API] SSE unavailable, falling back to polling every 5s');
    this._pollingInterval = setInterval(async () => {
      if (!this.online) return; // S5.3: was `!this.online || !this.token` — token is null for web (cookie auth)
      try {
        const res = await this._fetchWithTimeout(`${this.baseURL  }/api/sync`, {
          headers: this._headers()
        }, 8000);
        if (res.ok) {
          const data = await res.json();
          if (typeof Storage !== 'undefined' && Storage._applySync) {
            Storage._applySync(data);
          }
          this._notifyUIUpdate();
        }
      } catch {}
      // Retry SSE every ~5 minutes
      if (this._sseAttempts === undefined) this._sseAttempts = 0;
      this._sseAttempts++;
      if (this._sseAttempts >= 60) {
        this._sseAttempts = 0;
        if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
        this._listenSSE();
      }
    }, 15000); // WS/SSE 断开时的轮询兜底：15秒，避免请求风暴
  },

  // ==================== AUTO-REFRESH SAFETY NET ====================
  // 无感刷新：仅在 WS 断线时生效的轮询兜底，避免与实时通道重复
  _startAutoRefresh() {
    if (this._autoRefreshInterval) clearInterval(this._autoRefreshInterval);
    this._autoRefreshInterval = setInterval(async () => {
      if (!this.online) return; // S5.3: was `!this.online || !this.token` — token is null for web (cookie auth)
      // Skip if user is actively typing
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
      try {
        await Storage._syncFromServer();
        this._notifyUIUpdate();
      } catch {}
    }, 15000); // 15秒无感刷新
  },

  // ==================== WEBSOCKET LISTENER ====================
  // WebSocket 数据变更监听，确保多设备实时同步
  _listenWS() {
    if (typeof Realtime === 'undefined') return;
    
    const syncEvents = GMSUtils.BUSINESS_EVENTS;
    
    syncEvents.forEach(event => {
      Realtime.on(event, async () => {
        if (!this.online) return;
        const restoring = (typeof App !== 'undefined' && App._restoring)
                       || (typeof OpsApp !== 'undefined' && OpsApp._restoring);
        if (restoring) return;
        
        try {
          await Storage._syncFromServer();
          this._notifyUIUpdate();
        } catch (e) {
          console.warn(`[WS] Failed to sync on ${event}:`, e.message);
        }
      });
    });
    
    Realtime.on('data_changed', async (data) => {
      if (!this.online) return;
      try {
        await Storage._syncFromServer();
        this._notifyUIUpdate();
      } catch (e) {
        console.warn('[WS] Failed to sync on data_changed:', e.message);
      }
    });
  },

  // ==================== TOKEN HEARTBEAT ====================
  // Lightweight API call every 10 minutes to keep the token's sliding window alive
  // S5.3: was `!this.online || !this.token` — token is null for web. The heartbeat
  // now relies on the HttpOnly cookie (sent via credentials) to refresh the server-
  // side token's sliding-window TTL. Without this, a logged-in but idle user's
  // session would expire after TOKEN_EXPIRY (3 min) instead of the cookie's 7 days.
  _startTokenHeartbeat() {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    this._heartbeatInterval = setInterval(async () => {
      if (!this.online) return;
      try {
        // 检查需要认证的端点来验证 token 有效性
        const res = await this._fetchWithTimeout(`${this.baseURL  }/api/settings`, {
          headers: this._headers()
        }, 5000);
        
        if (res.status === 401) {
          // Token 已过期 - 触发重新登录
          console.warn('[API] Token heartbeat detected expired token');
          this._handleAuthError();
        } else if (!res.ok) {
          console.warn('[API] Token heartbeat failed, session may have expired');
        }
      } catch (e) {
        // 网络错误，不处理
      }
    }, 5 * 60 * 1000); // 5 分钟检查一次
  },

  // 无感刷新：保持滚动位置不丢失
  _preserveScroll(fn) {
    const el = document.getElementById('main-content') || document.querySelector('.main-content');
    const top = el ? el.scrollTop : 0;
    fn();
    if (el) el.scrollTop = top;
  },

  // Targeted UI update after SSE/WS data sync — renders directly without innerHTML clear, no flicker
  _notifyUIUpdate() {
    // Skip if user is typing or modal is open
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) return;
    const modal = document.getElementById('modal-overlay');
    if (modal && modal.style.display === 'flex') return;
    // Mobile modal check
    const mModal = document.getElementById('m-modal');
    if (mModal && mModal.style.display === 'flex') return;

    // Skip if waiting for machine code selection (prevents dashboard from overwriting the page)
    if (typeof App !== 'undefined' && App._waitingMachineCode) return;

    // Throttle: 全局防抖，避免一次事件风暴触发多次UI刷新
    if (this._uiUpdateThrottle) return;
    this._uiUpdateThrottle = true;
    setTimeout(() => { this._uiUpdateThrottle = false; }, 2000); // 2秒内最多刷新一次

    // 如果用户正在切换页面（switchTab 执行中），跳过本次刷新
    if (typeof App !== 'undefined' && App._switchingTab) return;

    // Always refresh sidebar inventory dropdown (lightweight, no visible flicker)
    if (typeof App !== 'undefined' && App.refreshSidebarInventory) App.refreshSidebarInventory();
    if (typeof OpsApp !== 'undefined' && OpsApp.refreshSidebarInventory) OpsApp.refreshSidebarInventory();

    // 桌面端（运维系统）：刷新所有 tab（不再限制 lightTabs 白名单）
    if (typeof App !== 'undefined' && App.refreshCurrentTab && App.currentTab) {
      this._preserveScroll(() => App.refreshCurrentTab());
    }

    // 运营端：也实时刷新（移除 NEVER auto-render 限制）
    if (typeof OpsApp !== 'undefined' && OpsApp.refreshCurrentTab && OpsApp.currentTab) {
      this._preserveScroll(() => OpsApp.refreshCurrentTab());
    }

    // 移动端
    if (typeof MobileApp !== 'undefined' && MobileApp._refreshCurrentTab) MobileApp._refreshCurrentTab();
  },

  // Targeted tech-support sync: fetches /api/tech-support (small) instead of the
  // ~1MB /api/sync, and immediately re-renders the active tech-support view.
  // Called by both the legacy `tech_support_updated` listener and the new
  // `data_changed` umbrella listener (when main === 'tech_support').
  async _syncTechSupport() {
    try {
      const data = await this._fetch('GET', '/api/tech-support');
      if (Array.isArray(data) && typeof Storage !== 'undefined') {
        // 同步写入 localStorage，确保 renderTechSupport 能立即读到最新数据
        // （原先用 requestIdleCallback/setTimeout 异步写入，导致页面重渲染时
        //   本地缓存还没写入，读到的仍是旧数据，无法实现无感刷新）
        try {
          localStorage.setItem('gms_tech_support', JSON.stringify(data));
          localStorage.setItem('gms_tech_support_ts', String(Date.now()));
        } catch(e) { console.warn('[SSE] localStorage write failed:', e.message); }
        console.log('[SSE] tech_support data updated, count:', data.length);
        // 通知运维系统刷新技术支持页面（保持筛选状态，详情态不刷新避免打断用户）
        if (typeof OpsApp !== 'undefined') {
          if (OpsApp.currentTab === 'tech-support-my') {
            OpsApp.renderTechSupportMy(OpsApp._tsViewMode);
          } else if (OpsApp.currentTab === 'tech-support-admin') {
            // 仅列表态刷新；详情态（_tsAdminDetailId）保留用户当前查看，避免中断
            if (!OpsApp._tsAdminDetailId) OpsApp.renderTechSupportAdmin(OpsApp._tsAdminViewMode);
          }
        }
        // 通知桌面端刷新技术支持页面（保持筛选状态）
        if (typeof App !== 'undefined' && App.currentTab === 'tech-support' && !App._tsDetailId) {
          // 直接注入最新数据，跳过 renderTechSupport 内部的缓存读取（防抖已同步写入，此处保证所见即所得）
          App._tsItems = data;
          App.renderTechSupport(App._tsViewMode);
        }
      }
    } catch (err) {
      console.error('[SSE] Failed to fetch tech_support:', err);
    }
    // 仍触发 UI 刷新（_notifyUIUpdate 内部 2s 节流，重复调用廉价）
    this._notifyUIUpdate();
  },

  _headers() {
    return this.token ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${  this.token}` } : { 'Content-Type': 'application/json' };
  },

  _setCookie(name, value, days) { GMSUtils.setCookie(name, value, days); },

  _getCookie(name) { return GMSUtils.getCookie(name); },

  _fetchWithTimeout(url, options, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // S4.6: always include credentials so cookies (gms_csrf, gms_token) are sent/received
    return fetch(url, { credentials: 'same-origin', ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  },

  // Auth-blocked flag: after a 401, subsequent _fetch calls short-circuit (return null) AND data-layer
  // methods return empty instead of falling back to STALE local data — so the UI shows the re-login
  // prompt rather than misleading old values. Reset on successful login.
  // (Previously _fetch returned null on 401 and callers silently fell back to localStorage, masking the error.)

  async _fetch(method, path, body, timeoutMs) {
    if (!this.online) return null;
    if (this._authErrorPending) return null; // short-circuit: token known-bad, don't spam server
    try {
      const opts = { method, headers: this._headers() };
      if (body) opts.body = JSON.stringify(body);
      // S4.6: add CSRF token header for non-GET requests (double-submit pattern)
      const m = (method || 'GET').toUpperCase();
      if (this.csrfToken && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
        opts.headers['X-CSRF-Token'] = this.csrfToken;
      }
      const res = await this._fetchWithTimeout(this.baseURL + path, opts, timeoutMs);

      // 检测 401 错误 - token 过期：置位阻塞标志，触发重新登录流程
      if (res.status === 401) {
        console.warn('[API] Token expired or unauthorized');
        this._authErrorPending = true;
        this._handleAuthError();
        return null;
      }

      const data = await res.json();
      if (!res.ok) {
        return { ...(data || {}), success: false, error: data?.error || data?.message || `请求失败（${res.status}）` };
      }
      return data;
    } catch { return null; }
  },

  // 处理认证错误 - 显示重新登录提示
  _handleAuthError() {
    // 防止重复触发
    if (this._authErrorHandled) return;
    this._authErrorHandled = true;
    
    console.warn('[API] Auth error detected, prompting re-login');
    
    // 发送全局事件
    window.dispatchEvent(new CustomEvent('gms_auth_error', {
      detail: { reason: 'token_expired' }
    }));
    
    // 2秒后重置标志
    setTimeout(() => { this._authErrorHandled = false; }, 30000);
  },

  // ==================== 版本检测（强制刷新） ====================
  _startVersionCheck() {
    // 立即检查一次
    this._checkVersion();
    // 每 5 分钟检查一次
    if (this._versionCheckInterval) clearInterval(this._versionCheckInterval);
    this._versionCheckInterval = setInterval(() => this._checkVersion(), 5 * 60 * 1000);
  },

  async _checkVersion() {
    if (!this.online) return;
    try {
      const res = await this._fetchWithTimeout(`${this.baseURL  }/api/version`, {}, 3000);
      if (!res.ok) return;
      const data = await res.json();
      const serverVersion = data.version;
      const localVersion = localStorage.getItem('gms_version');
      
      if (!localVersion) {
        // 首次访问，保存版本号
        localStorage.setItem('gms_version', serverVersion);
        return;
      }
      
      if (serverVersion !== localVersion) {
        // 版本号不同，说明服务器已重启/更新
        console.log('[API] 检测到新版本！本地:', localVersion, '服务器:', serverVersion);
        this._showVersionUpdateNotice(serverVersion);
      }
    } catch {
      // 忽略网络错误
    }
  },

  _showVersionUpdateNotice(newVersion) {
    if (this._versionNotified) return;
    this._versionNotified = true;
    
    
    // 创建覆盖层
    const overlay = document.createElement('div');
    overlay.id = 'version-update-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';
    
    overlay.innerHTML = `
      <div style="background:var(--bg-card,#fff);border-radius:16px;padding:32px;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:versionFadeIn 0.3s ease-out;">
        <div style="font-size:4rem;margin-bottom:16px;"><svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></div>
        <div style="font-size:1.4rem;font-weight:700;margin-bottom:8px;color:var(--text-primary,#333);">系统已更新</div>
        <div style="color:var(--text-secondary,#888);font-size:0.95rem;margin-bottom:24px;line-height:1.6;">
          检测到新版本，为确保数据同步正常，<br>需要刷新页面加载最新代码。
        </div>
        <div style="background:var(--bg-secondary,#f5f5f5);border-radius:8px;padding:10px 14px;font-size:0.8rem;color:var(--text-secondary,#888);margin-bottom:20px;font-family:monospace;">
          新版本号: ${newVersion}
        </div>
        <button id="version-update-btn" style="width:100%;padding:14px 24px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;transition:all 0.2s;box-shadow:0 4px 15px rgba(99,102,241,0.4);">
          立即刷新
        </button>
        <div style="margin-top:16px;font-size:0.75rem;color:var(--text-tertiary,#aaa);">
          点击刷新后将自动重新加载页面，<br>您当前的数据和登录状态不会丢失。
        </div>
      </div>
      <style>
        @keyframes versionFadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      </style>
    `;
    
    document.body.appendChild(overlay);
    
    const btn = overlay.querySelector('#version-update-btn');
    btn.addEventListener('click', () => {
      localStorage.setItem('gms_version', newVersion);
      // 使用 query 参数强制刷新，绕过浏览器缓存
      const url = new URL(window.location.href);
      url.searchParams.set('_v', newVersion);
      window.location.replace(url.toString());
    });
    
    // 禁用 ESC 关闭
    document.addEventListener('keydown', function blockEsc(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    }, { once: true });
  },

  // Inventory
  async getAllInventory() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/inventory');
    return Array.isArray(data) ? data : [];
  },

  async getInventory(type) {
    if (!this.online) return Storage._local.getInventory(type);
    const data = await this._fetch('GET', `/api/inventory/${  type}`);
    return data && !data.error ? { quantity: data.quantity, updatedAt: data.updatedAt, updatedBy: data.updatedBy } : Storage._local.getInventory(type);
  },

  async adjustInventory(type, delta, updatedBy, snCode, warehouseId) {
    if (!this.online) return Storage._local.adjustInventory(type, delta, updatedBy, snCode);
    const body = { delta, snCode, updatedBy };
    // 不传 warehouseId 时后端默认操作主仓库 main
    if (warehouseId) body.warehouseId = warehouseId;
    const data = await this._fetch('POST', `/api/inventory/${  type}`, body);
    return data && data.success ? data : { success: false, message: data?.error || '请求失败' };
  },

  async getWarehouses() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/warehouses');
    return Array.isArray(data) ? data : [];
  },

  // Machines
  async getMachines() {
    if (!this.online) return Storage._local.getMachines();
    const data = await this._fetch('GET', '/api/machines');
    return Array.isArray(data) ? data : Storage._local.getMachines();
  },

  async addMachine(machine) {
    if (!this.online) return Storage._local.addMachine(machine);
    const data = await this._fetch('POST', '/api/machines', machine);
    return data?.success ? (this.getMachines ? await this.getMachines() : []) : Storage._local.addMachine(machine);
  },

  async deleteMachine(id) {
    if (!this.online) return Storage._local.deleteMachine(id);
    await this._fetch('DELETE', `/api/machines/${  id}`);
  },

  // 机器生产状态：变更记录查询 + 人工切换（可生产/在生产/在测试；待维修由维修工单驱动）
  async getProductionHistory(machineNumber) {
    if (!this.online) return [];
    const qs = machineNumber ? '?machineNumber=' + encodeURIComponent(machineNumber) : '';
    const data = await this._fetch('GET', '/api/machines/production-history' + qs);
    return Array.isArray(data?.items) ? data.items : [];
  },

  async setProductionStatus(machineNumber, status, reason) {
    if (!this.online) return { success: false, error: '离线状态无法变更' };
    return await this._fetch('POST', '/api/machines/production-status', { machineNumber, status, reason: reason || '' });
  },

  // 采集器综合状态（机器状态信息：任务/操作员/灵巧手/手套/Quest/摄像头/系统程序/容器）
  // opts.refresh=true 时服务端跳过心跳快照，强制直连采集器实时抓取
  async getMachineInfo(machineNumber, opts) {
    return await this._fetch('GET', '/api/machines/' + encodeURIComponent(machineNumber) + '/info' + (opts && opts.refresh ? '?refresh=1' : ''));
  },

  async stopCollector(machineNumber) {
    return await this._fetch('POST', '/api/machines/' + encodeURIComponent(machineNumber) + '/stop-collector');
  },

  async stopExodus(machineNumber) {
    return await this._fetch('POST', '/api/machines/' + encodeURIComponent(machineNumber) + '/stop-exodus');
  },

  async fixQuest(machineNumber) {
    return await this._fetch('POST', '/api/machines/' + encodeURIComponent(machineNumber) + '/fix-quest', null, 170000);
  },

  async diagnoseHands(machineNumber) {
    return await this._fetch('POST', '/api/machines/' + encodeURIComponent(machineNumber) + '/diagnose-hands', null, 180000);
  },
  // 灵巧手检测实时进度（agent 侧状态，前端轮询）
  async diagnoseProgress(machineNumber) {
    return await this._fetch('GET', '/api/machines/' + encodeURIComponent(machineNumber) + '/diagnose-progress', null, 8000);
  },
  async getMachineConfig(machineNumber) {
    return await this._fetch('GET', '/api/machines/' + encodeURIComponent(machineNumber) + '/machine-config', null, 20000);
  },

  async getMachineCommands(machineNumber) {
    return await this._fetch('GET', '/api/machines/' + encodeURIComponent(machineNumber) + '/machine-commands');
  },

  async runMachineCommand(machineNumber, key) {
    return await this._fetch('POST', '/api/machines/' + encodeURIComponent(machineNumber) + '/machine-command', { key }, 40000);
  },
  // 机械臂状态切换功能暂未启用，先注释掉
  // async armControl(machineNumber, action, arm, state) {
  //   return await this._fetch('POST', '/api/machines/' + encodeURIComponent(machineNumber) + '/arm-control', { action, arm, state }, 35000);
  // },

  // 机器实时流（SSE over fetch）：服务端每 ~2s 直连采集器推送；返回 AbortController，调用方 abort() 结束
  streamMachineLive(machineNumber, onData) {
    const ctrl = new AbortController();
    const headers = { Accept: 'text/event-stream' };
    if (this.token) headers['Authorization'] = `Bearer ${  this.token}`;
    fetch(`${this.baseURL  }/api/machines/${  encodeURIComponent(machineNumber)  }/live`, {
      method: 'GET',
      credentials: 'same-origin',
      headers,
      signal: ctrl.signal,
    }).then(async (res) => {
      if (!res.ok || !res.body) throw new Error('SSE ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (data && data.success !== false) onData(data);
          } catch (e) { /* 半包忽略 */ }
        }
      }
    }).catch(() => { });
    return ctrl;
  },

  // Transactions
  async getTransactions(limit = 2000) {
    if (!this.online) return Storage._local.getTransactions();
    const data = await this._fetch('GET', `/api/transactions?limit=${  limit}`);
    return Array.isArray(data) ? data : Storage._local.getTransactions();
  },

  async addTransaction(tx) {
    if (!this.online) return Storage._local.addTransaction(tx);
    await this._fetch('POST', '/api/transactions', tx);
  },

  async deleteTransaction(id) {
    if (!this.online) return Storage._local.deleteTransaction(id);
    await this._fetch('DELETE', `/api/transactions/${  id}`);
  },

  // Audit Log
  async getAuditLog() {
    if (!this.online) return Storage._local.getAuditLog();
    const data = await this._fetch('GET', '/api/audit-log');
    return Array.isArray(data) ? data : Storage._local.getAuditLog();
  },

  // Settings
  async getSettings() {
    if (!this.online) return Storage._local.getSettings();
    const data = await this._fetch('GET', '/api/settings');
    return data && !data.error ? data : Storage._local.getSettings();
  },

  async saveSettings(settings) {
    if (!this.online) return Storage._local.saveSettings(settings);
    await this._fetch('POST', '/api/settings', settings);
  },

  // Equipment Config
  async getEquipmentConfig() {
    if (!this.online) return null;
    const data = await this._fetch('GET', '/api/equipment-config');
    return Array.isArray(data) ? data : null;
  },
  async saveEquipmentConfig(config) {
    if (!this.online) return;
    await this._fetch('POST', '/api/equipment-config', config);
  },
  async deleteEquipmentConfig(id) {
    if (!this.online) return;
    await this._fetch('DELETE', `/api/equipment-config/${  id}`);
  },

  // Inventory Config
  async getInventoryConfig() {
    if (!this.online) return null;
    const data = await this._fetch('GET', '/api/inventory-config');
    return Array.isArray(data) ? data : null;
  },
  async saveInventoryConfig(config) {
    if (!this.online) return;
    await this._fetch('POST', '/api/inventory-config', config);
  },
  async deleteInventoryConfig(id) {
    if (!this.online) return;
    await this._fetch('DELETE', `/api/inventory-config/${  id}`);
  },
  // 增量添加单个库存类型（无需修改源代码，运行时生效）
  async addInventoryConfigItem(item) {
    if (!this.online) return null;
    const data = await this._fetch('POST', '/api/inventory-config/item', item);
    return data;
  },
  // 更新单个库存类型
  async updateInventoryConfigItem(id, item) {
    if (!this.online) return null;
    const data = await this._fetch('PUT', `/api/inventory-config/item/${  encodeURIComponent(id)}`, item);
    return data;
  },
  // 从配置文件批量导入库存类型
  async importInventoryConfig(items) {
    if (!this.online) return null;
    const data = await this._fetch('POST', '/api/inventory-config/import', { items });
    return data;
  },

  // Clear all data
  async clearAllData() {
    if (!this.online) return false;
    const data = await this._fetch('POST', '/api/clear-all-data');
    return data && data.success;
  },

  // SN Registry
  async getSNRegistry() {
    if (!this.online && Storage.getSNRegistry) return Storage.getSNRegistry();
    const data = await this._fetch('GET', '/api/sn-registry');
    if (Array.isArray(data)) return data;
    // Fallback to local storage if server returns error
    if (Storage.getSNRegistry) return Storage.getSNRegistry();
    return [];
  },
  async upsertSNRegistry(entry) {
    if (!this.online && Storage.upsertSNRegistry) return Storage.upsertSNRegistry(entry);
    return await this._fetch('POST', '/api/sn-registry', entry);
  },
  // Phase 1.1: 原子机器上下线 — 单事务完成 SN/库存/交易/机器记录，
  // 替代前端多次 _registerSNChecked + 乐观本地变更 + best-effort 回滚的非事务流程。
  async syncMachineState(machineNumber, payload) {
    if (!this.online) return { success: false, error: 'offline' };
    return await this._fetch('POST', `/api/machines/${  encodeURIComponent(machineNumber)  }/sync-state`, payload);
  },
  async changeSNStatus(data) {
    return await this._fetch('POST', '/api/sn-status-change', data);
  },
  async shipSN(snCode, trackingNumber) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/sn-registry/ship', { snCode, trackingNumber });
  },
  async repairCompleteSN(snCode) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/sn-registry/repair-complete', { snCode });
  },
  async deleteSNFull(snCode) {
    if (!this.online) return { success: false, message: 'offline' };
    return await this._fetch('POST', '/api/sn-registry/delete-full', { snCode });
  },
  async deleteUpload(filePath) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/delete-upload', { filePath });
  },

  // Data integrity
  async getDataIntegrity() {
    if (!this.online) return { issues: [], count: 0 };
    const data = await this._fetch('GET', '/api/data-integrity');
    return data || { issues: [], count: 0 };
  },

  // Tech Support
  async getTechSupportList() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/tech-support');
    return Array.isArray(data) ? data : [];
  },

  async getTechSupportDetail(id) {
    if (!this.online) return null;
    const data = await this._fetch('GET', `/api/tech-support/${  id}`);
    return data && !data.error ? data : null;
  },

  async submitTechSupport(payload) {
    if (!this.online) return { success: false, message: '离线模式不支持提交' };
    const data = await this._fetch('POST', '/api/tech-support', payload);
    return data || { success: false, message: '请求失败' };
  },

  // 我的提交历史（跟随账户，跨设备可见）
  async getMyTechSupportHistory() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/tech-support/my-history');
    return Array.isArray(data) ? data : [];
  },

  // 常见故障模板（运营共享：任何运营账户可添加，全运营账户可见）
  async getCommonFaults() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/tech-support/common-faults');
    return data && Array.isArray(data.faults) ? data.faults : [];
  },

  async addCommonFault(payload) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/tech-support/common-faults', payload);
    return data || { success: false, message: '请求失败' };
  },

  async deleteCommonFault(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('DELETE', `/api/tech-support/common-faults/${id}`);
    return data || { success: false, message: '请求失败' };
  },

  async respondTechSupport(id) {
    if (!this.online) return { success: false, message: '离线模式不支持响应' };
    const data = await this._fetch('POST', `/api/tech-support/${  id  }/respond`);
    return data || { success: false, message: '请求失败' };
  },

  async completeTechSupport(id, result, extra) {
    if (!this.online) return { success: false, message: '离线模式不支持完成' };
    const payload = Object.assign({ result }, extra);
    const data = await this._fetch('POST', `/api/tech-support/${  id  }/complete`, payload);
    return data || { success: false, message: '请求失败' };
  },

  async deleteTechSupport(id) {
    if (!this.online) return { success: false, message: '离线模式不支持删除' };
    const data = await this._fetch('DELETE', `/api/tech-support/${  id}`);
    return data || { success: false, message: '请求失败' };
  },

  // 共享记忆（故障说明 / 维修结果）
  async getMemoryList(category) {
    if (!this.online) return [];
    const data = await this._fetch('GET', `/api/tech-support/memory/${  category}`);
    return Array.isArray(data) ? data : [];
  },

  async addMemory(category, text) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', `/api/tech-support/memory/${  category}`, { text });
    return data || { success: false, message: '请求失败' };
  },

  // Group Transfer
  async getGroupTransfers() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/group/transfers');
    return Array.isArray(data) ? data : [];
  },
  async getGroupMembers() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/group/members');
    return Array.isArray(data) ? data : [];
  },
  async getMemberRepairStats(userId, from, to) {
    if (!this.online) return null;
    let path = '/api/team/member-repair-stats?userId='+encodeURIComponent(userId);
    if (from) path += '&from='+encodeURIComponent(from);
    if (to) path += '&to='+encodeURIComponent(to);
    return this._fetch('GET', path) || null;
  },
  async createGroupTransfer(payload) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/group/transfer', payload);
    return data || { success: false, message: '请求失败' };
  },
  async approveGroupTransfer(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', `/api/group/transfer/${  id  }/approve`);
    return data || { success: false, message: '请求失败' };
  },
  async rejectGroupTransfer(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', `/api/group/transfer/${  id  }/reject`);
    return data || { success: false, message: '请求失败' };
  },
  async cancelGroupTransfer(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', `/api/group/transfer/${  id  }/cancel`);
    return data || { success: false, message: '请求失败' };
  },

  async getSubordinates() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/users/subordinates');
    return Array.isArray(data) ? data : [];
  },

  async getUserRepairStats(userId) {
    if (!this.online) return null;
    const data = await this._fetch('GET', `/api/users/${  userId  }/repair-stats`);
    return data || null;
  },

  async submitTaskProgress(progress, note) {
    if (!this.online) return { success: false, message: '离线模式不支持提交进度' };
    const data = await this._fetch('POST', '/api/task-progress', { progress, note });
    return data || { success: false, message: '请求失败' };
  },

  async getTaskProgress(date) {
    if (!this.online) return null;
    const url = date ? `/api/task-progress?date=${  date}` : '/api/task-progress';
    const data = await this._fetch('GET', url);
    return data || null;
  },

  async getUserTaskProgress(userId, date) {
    if (!this.online) return null;
    let url = `/api/task-progress?userId=${  userId}`;
    if (date) url += `&date=${  date}`;
    const data = await this._fetch('GET', url);
    return data || null;
  },

  async addUser(userData) {
    if (!this.online) return { success: false, message: '离线模式不支持添加用户' };
    const data = await this._fetch('POST', '/api/users', userData);
    return data || { success: false, message: '请求失败' };
  },

  async deleteUser(userId) {
    if (!this.online) return { success: false, message: '离线模式不支持删除用户' };
    const data = await this._fetch('DELETE', `/api/users/${  userId}`);
    return data || { success: false, message: '请求失败' };
  },

  async promoteUser(userId) {
    if (!this.online) return { success: false, message: '离线模式不支持操作' };
    const data = await this._fetch('POST', `/api/users/${  userId  }/promote`);
    return data || { success: false, message: '请求失败' };
  },

  async resetPassword(userId, newPassword) {
    if (!this.online) return { success: false, message: '离线模式不支持重置密码' };
    const data = await this._fetch('POST', `/api/users/${  userId  }/reset-password`, { newPassword });
    return data || { success: false, message: '请求失败' };
  },

  async getUsers() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/users');
    return Array.isArray(data) ? data : [];
  },

  // Popup Messages
  async getPopupMessages(category) {
    if (!this.online) return [];
    const url = `/api/popup-messages${  category ? `?category=${  category}` : ''}`;
    const data = await this._fetch('GET', url);
    return Array.isArray(data) ? data : [];
  },
  // ====== SOP 文档管理 ======
  async getSOP() {
    const data = await this._fetch('GET', '/api/sop');
    return Array.isArray(data) ? data : [];
  },
  async addSOP(payload) {
    return this._fetch('POST', '/api/sop', payload);
  },
  async deleteSOP(id) {
    return this._fetch('POST', '/api/sop/delete', { id });
  },
  async uploadSOPFile(file) {
    // Read file as base64 and upload via SOP create endpoint
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target.result;
        resolve(dataUrl);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  },
  // ====== 手套调出/调回 ======
  async transferGloves(payload) {
    return this._fetch('POST', '/api/transfers', payload);
  },
  async recallGloves(payload) {
    return this._fetch('POST', '/api/transfers/recall', payload);
  },
  async getTransfers() {
    return this._fetch('GET', '/api/transfers');
  },
  async getTransferStats() {
    return this._fetch('GET', '/api/transfers/stats');
  },

  async getRandomPopupMessage(category) {
    if (!this.online) return { text: '操作成功！' };
    const data = await this._fetch('GET', `/api/popup-messages/random?category=${  category || 'submit'}`);
    return data || { text: '操作成功！' };
  },
  async addPopupMessage(category, text) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/popup-messages', { category, text });
    return data || { success: false, message: '请求失败' };
  },
  async deletePopupMessage(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('DELETE', `/api/popup-messages/${  id}`);
    return data || { success: false, message: '请求失败' };
  },
  // Chat / 帮助中心
  async sendChatMessage(recipientId, recipientName, message) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    const data = await this._fetch('POST', '/api/chat/send', { recipientId, recipientName, message });
    return data || { success: false, message: '请求失败' };
  },
  async getChatHistory(withUserId) {
    if (!this.online) return [];
    const data = await this._fetch('GET', `/api/chat/history?withUserId=${  withUserId}`);
    return Array.isArray(data) ? data : [];
  },
  async getChatUnread() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/chat/unread');
    return Array.isArray(data) ? data : [];
  },
  async getChatConversations() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/chat/conversations');
    return Array.isArray(data) ? data : [];
  },
  async markChatRead(userId) {
    if (!this.online) return { success: false };
    const data = await this._fetch('POST', '/api/chat/mark-read', { userId });
    return data || { success: false };
  },
  async getChatHelpdesk() {
    if (!this.online) return null;
    const data = await this._fetch('GET', '/api/chat/helpdesk');
    return data && !data.error ? data : null;
  },
  // Agent 智能助手（已禁用）
  // async agentChat(message) { ... },
  // ====== 手套置换库存 ======
  async getReplacements() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/replacement/list');
    return Array.isArray(data) ? data : [];
  },
  async addReplacement(snCode, note) {
    if (!this.online) return { error: '离线模式不支持' };
    return this._fetch('POST', '/api/replacement/add', { snCode, note });
  },
  async returnReplacement(snCode, note) {
    if (!this.online) return { error: '离线模式不支持' };
    return this._fetch('POST', '/api/replacement/return', { snCode, note });
  },
  async shipReplacement(snCode, trackingNumber, note) {
    if (!this.online) return { error: '离线模式不支持' };
    return this._fetch('POST', '/api/replacement/ship', { snCode, trackingNumber, note });
  },
  // ====== 送货单（Delivery Notes）======
  async saveDeliveryNote(payload) {
    if (!this.online) return { error: '离线模式不支持' };
    return this._fetch('POST', '/api/delivery-notes/save', payload);
  },
  async getDeliveryNotes() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/delivery-notes/list');
    return (data && Array.isArray(data.list)) ? data.list : [];
  },
  async getDeliveryNote(id) {
    if (!this.online) return null;
    const data = await this._fetch('GET', `/api/delivery-notes/${encodeURIComponent(id)}`);
    return data || null;
  },
  async updateDeliveryNote(id, payload) {
    if (!this.online) return { success: false, error: '离线模式不支持' };
    return this._fetch('PUT', `/api/delivery-notes/${encodeURIComponent(id)}`, payload);
  },
  async deleteDeliveryNote(id) {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    return this._fetch('DELETE', `/api/delivery-notes/${encodeURIComponent(id)}`);
  },
  // ====== 班次首检（今日首检）======
  async getTodayShiftInspections() {
    if (!this.online) return { success: false, message: '离线模式不支持' };
    return this._fetch('GET', '/api/shift-inspections/today');
  },
  async saveShiftInspection(machineCode, payload) {
    if (!this.online) return { error: '离线模式不支持' };
    return this._fetch('POST', `/api/machines/${encodeURIComponent(machineCode)}/shift-inspection`, payload);
  },
  async getMachineShiftInspections(machineCode) {
    if (!this.online) return { success: false, list: [] };
    return this._fetch('GET', `/api/machines/${encodeURIComponent(machineCode)}/shift-inspections`);
  },
  // ====== 服务器看板 ======
  async getServerStatus() {
    if (!this.online) return { error: '离线模式不支持' };
    return this._fetch('GET', '/api/server-status');
  },
  // ====== 库位管理 ======
  async getStorageLocations() {
    if (!this.online) return [];
    const data = await this._fetch('GET', '/api/storage-locations');
    return Array.isArray(data) ? data : [];
  },
  async addStorageLocation(loc) {
    if (!this.online) return null;
    return await this._fetch('POST', '/api/storage-locations', loc);
  },
  async updateStorageLocation(code, loc) {
    if (!this.online) return null;
    return await this._fetch('PUT', `/api/storage-locations/${encodeURIComponent(code)}`, loc);
  },
  async deleteStorageLocation(code) {
    if (!this.online) return null;
    return await this._fetch('DELETE', `/api/storage-locations/${encodeURIComponent(code)}`);
  },
  async getLocationSNs(code) {
    if (!this.online) return [];
    const data = await this._fetch('GET', `/api/storage-locations/${encodeURIComponent(code)}/sns`);
    return Array.isArray(data) ? data : [];
  },

  // ====== 解决方案跟踪系统 ======
  async getSolutions(params = {}) {
    if (!this.online) return [];
    const qs = Object.entries(params).filter(([,v]) => v).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const data = await this._fetch('GET', `/api/solutions${qs ? '?' + qs : ''}`);
    return Array.isArray(data) ? data : [];
  },
  async getSolution(id) {
    if (!this.online) return null;
    return this._fetch('GET', `/api/solutions/${id}`);
  },
  async createSolution(payload) {
    return this._fetch('POST', '/api/solutions', payload);
  },
  async updateSolution(id, payload) {
    return this._fetch('PUT', `/api/solutions/${id}`, payload);
  },
  async deleteSolution(id) {
    return this._fetch('DELETE', `/api/solutions/${id}`);
  },
  async getSolutionStats() {
    if (!this.online) return null;
    return this._fetch('GET', '/api/solutions/stats');
  },
  async getTicketSolutions(ticketId) {
    if (!this.online) return [];
    const data = await this._fetch('GET', `/api/tech-support/${ticketId}/solutions`);
    return Array.isArray(data) ? data : [];
  },
  async linkSolution(ticketId, solutionId) {
    return this._fetch('POST', `/api/tech-support/${ticketId}/solutions`, { solutionId });
  },
  async unlinkSolution(ticketId, solutionId) {
    return this._fetch('DELETE', `/api/tech-support/${ticketId}/solutions/${solutionId}`);
  },
};
