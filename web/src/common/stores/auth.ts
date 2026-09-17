// 认证状态：移植自 js/api.js 的 init/login/logout 语义
// - 会话权威是 HttpOnly cookie（gms_token），前端只保存用户基本信息
// - 登录历史 24h 内自动恢复（同设备）
import { create } from 'zustand';
import type { User } from '../types';
import { login as apiLogin, logout as apiLogout, validateSession, checkServer } from '../api';
import { fetchCsrfToken, clearCsrfToken } from '../api/http';
import { startSSE, stopSSE } from '../realtime/sse';
import { setCookie } from '../utils/cookies';

function getDeviceId(): string {
  let id = localStorage.getItem('gms_device_id');
  if (!id) {
    id = `dev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem('gms_device_id', id);
  }
  return id;
}

function saveLoginHistory(user: User) {
  localStorage.setItem('gms_login_history', JSON.stringify({
    username: user.username, role: user.role, system: user.system || 'maintenance',
    deviceId: getDeviceId(), loginAt: Date.now(),
  }));
}

function getLoginHistory(): { username: string; role: string; system: string } | null {
  try {
    const data = JSON.parse(localStorage.getItem('gms_login_history') || 'null');
    if (!data) return null;
    if (Date.now() - data.loginAt > 24 * 60 * 60 * 1000) { localStorage.removeItem('gms_login_history'); return null; }
    if (data.deviceId !== getDeviceId()) { localStorage.removeItem('gms_login_history'); return null; }
    return data;
  } catch { return null; }
}

interface AuthState {
  user: User | null;
  online: boolean;
  initialized: boolean;
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<{ success: boolean; message?: string; user?: User }>;
  logout: (reason?: string) => void;
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  online: false,
  initialized: false,

  async init() {
    // 1. 恢复用户信息
    let user: User | null = null;
    try { user = JSON.parse(localStorage.getItem('gms_user') || sessionStorage.getItem('gms_user') || 'null'); } catch { /* ignore */ }
    if (!user) {
      const hist = getLoginHistory();
      if (hist) {
        user = { username: hist.username, role: hist.role, system: hist.system as any };
        localStorage.setItem('gms_user', JSON.stringify(user));
      }
    }

    // 2. 健康检查
    const online = await checkServer();
    let sessionValid = false;
    if (online) {
      try {
        sessionValid = await validateSession();
      } catch { sessionValid = false; }
      if (!sessionValid) {
        // cookie 失效：清空本地用户，保持在线等待重新登录
        localStorage.removeItem('gms_user');
        user = null;
      } else {
        fetchCsrfToken();
        if (user) startSSE();
      }
    } else {
      // 离线时不保留登录态（无离线模式）
      user = null;
    }
    set({ user, online, initialized: true });
  },

  async login(username, password) {
    const result = await apiLogin(username, password);
    if (!result.success || !result.user) return { success: false, message: result.message };
    const user = result.user;
    localStorage.setItem('gms_user', JSON.stringify(user));
    saveLoginHistory(user);
    setCookie('gms_logged', '1', 7);
    set({ user, online: true });
    fetchCsrfToken();
    startSSE();
    return { success: true, user };
  },

  logout(reason) {
    const isSessionExpired = reason === 'session_expired';
    if (!isSessionExpired) apiLogout();
    stopSSE();
    clearCsrfToken();
    localStorage.removeItem('gms_user');
    sessionStorage.removeItem('gms_user');
    localStorage.removeItem('gms_login_history');
    // 主动退出时服务器仍在线，保持 online；会话过期时维持当前探测结果，
    // 避免登录页误显示"离线模式"
    set({ user: null });
  },

  setUser(user) {
    if (user) localStorage.setItem('gms_user', JSON.stringify(user));
    set({ user });
  },
}));

export const isAdmin = (user?: User | null): boolean =>
  !!user && (user.role === 'admin' || user.role === 'superadmin');
export const isSuperAdmin = (user?: User | null): boolean => !!user && user.role === 'superadmin';
export const isOperationsAdmin = (user?: User | null): boolean =>
  !!user && (user.role === 'superadmin' || (user.system === 'operations' && user.role === 'admin'));
