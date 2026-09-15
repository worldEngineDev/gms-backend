// 领域 API 端点层：移植自 js/api.js 的全部桌面端接口
import { get, post, put, del, ApiError } from './http';
import type { User } from '../types';

export { checkServer } from './http';

// ==================== 认证 ====================
export async function login(username: string, password: string): Promise<{ success: boolean; user?: User; message?: string }> {
  // 先取机器码（与旧版行为一致）
  let machineCode: string | null = null;
  try {
    const mc = await get<{ machineCode?: string }>('/api/machine-code', 3000);
    machineCode = mc.machineCode || null;
  } catch { /* 忽略 */ }
  try {
    // silent=true：密码错误的 401 不应触发全局“会话过期”弹窗
    const data = await post<{ user: User; token?: string }>('/api/auth/login', { username, password, machineCode }, 10000, true);
    return { success: true, user: data.user };
  } catch (e) {
    const err = e as ApiError;
    if (err.status && err.status !== 0) return { success: false, message: err.message };
    return { success: false, message: '无法连接服务器，请检查网络' };
  }
}

export function logout(): void {
  // fire-and-forget：清除服务端 session + HttpOnly cookie
  post('/api/logout').catch(() => {});
}

export const getLoginUsers = () => get<string[]>('/api/auth/users', 5000).catch(() => [] as string[]);

/** 用 /api/settings 验证 cookie 会话是否有效（silent：401 属预期结果，不触发全局认证错误） */
export const validateSession = () => get('/api/settings', 3000, true).then(() => true).catch((e: ApiError) => !(e.status === 401));

// ==================== 库存 ====================
export const getAllInventory = () => get<any[]>('/api/inventory');
export const getInventoryByWarehouse = () => get<any[]>('/api/inventory?groupBy=warehouse');
export const getInventory = (type: string) => get<any>(`/api/inventory/${encodeURIComponent(type)}`);
export const adjustInventory = (type: string, delta: number, updatedBy: string, snCode?: string, note?: string, warehouseId?: string) =>
  post(`/api/inventory/${encodeURIComponent(type)}`, { delta, snCode, updatedBy, note, warehouseId });

// ==================== 机器 ====================
export const getMachines = () => get<any[]>('/api/machines');
export const addMachine = (machine: any) => post('/api/machines', machine);
export const deleteMachine = (id: string | number) => del(`/api/machines/${encodeURIComponent(String(id))}`);
export const syncMachineState = (machineNumber: string, payload: any) =>
  post(`/api/machines/${encodeURIComponent(machineNumber)}/sync-state`, payload);
// 机器生产状态（可生产/在生产/待维修/在测试）
export const setProductionStatus = (machineNumber: string, status: string, reason?: string) =>
  post('/api/machines/production-status', { machineNumber, status, reason: reason || '' });
export const getProductionHistory = (machineNumber?: string) =>
  get<{ success: boolean; items: any[] }>(
    `/api/machines/production-history${machineNumber ? `?machineNumber=${encodeURIComponent(machineNumber)}` : ''}`
  ).then(r => r.items || []);
export const getMachineStatusTimeline = (machineNumber: string, date?: string) =>
  get<{
    success: boolean;
    machineNumber: string;
    date: string;
    intervals: any[];
    productionIntervals: any[];
    summary: Record<string, { seconds: number; label: string }>;
    productionSummary?: Record<string, { seconds: number; label: string }>;
    statusMeta: Record<string, { label: string; color: string }>;
  }>(`/api/machines/${encodeURIComponent(machineNumber)}/status-timeline${date ? `?date=${encodeURIComponent(date)}` : ''}`);
// 采集器综合状态（机器状态信息：任务/操作员/灵巧手/手套/Quest/摄像头/系统程序/容器）
// opts.refresh=true 时服务端强制直连采集器实时抓取（绕过心跳快照缓存）
export const getMachineInfo = (machineNumber: string, opts?: { refresh?: boolean }) =>
  get<any>(`/api/machines/${encodeURIComponent(machineNumber)}/info${opts?.refresh ? '?refresh=1' : ''}`, 12000);

// 运营机器状态中心：Importer 登录/任务、Hermes 工作流、处理状态、上传及全天会话。
export const getMachineOperationsCenter = (
  machineNumber: string,
  period?: { since?: number; until?: number },
) => {
  const params = new URLSearchParams();
  if (period?.since != null) params.set('since', String(period.since));
  if (period?.until != null) params.set('until', String(period.until));
  const query = params.toString();
  return get<any>(
    `/api/machines/${encodeURIComponent(machineNumber)}/operations-center${query ? `?${query}` : ''}`,
    12000,
  );
};

// 机械臂连接会话：连接/退出由现场操作员显式触发。退出只释放 Agent
// 的 Marvin SDK 端口，不会启停 main/采集器容器。
export const armControl = (machineNumber: string, action: string, options: Record<string, any> = {}) =>
  post<any>(`/api/machines/${encodeURIComponent(machineNumber)}/arm-control`, { action, ...options }, 40000);
export const questControl = (machineNumber: string, action: 'connect'|'disconnect') =>
  post<any>(`/api/machines/${encodeURIComponent(machineNumber)}/quest-control`, { action }, 40000);

// 机器实时流（SSE over fetch）：弹窗打开期间订阅，服务端每 ~2s 直连采集器推送
export async function streamMachineLive(
  machineNumber: string,
  onData: (data: any) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/machines/${encodeURIComponent(machineNumber)}/live`, {
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      try {
        const data = JSON.parse(line.slice(5).trim());
        if (data && data.success !== false) onData(data);
      } catch { /* 半包忽略 */ }
    }
  }
}

// ==================== 流水 ====================
export const getTransactions = (limit = 2000) => get<any[]>(`/api/transactions?limit=${limit}`);
export const addTransaction = (tx: any) => post('/api/transactions', tx);
export const deleteTransaction = (id: string | number) => del(`/api/transactions/${encodeURIComponent(String(id))}`);

// ==================== 审计日志 ====================
export const getAuditLog = () => get<any[]>('/api/audit-log');

// ==================== 设置 ====================
export const getSettings = () => get<any>('/api/settings');
export const saveSettings = (settings: any) => post('/api/settings', settings);

// ==================== 设备/库存类型配置 ====================
export const getEquipmentConfig = () => get<any[]>('/api/equipment-config');
export const saveEquipmentConfig = (config: any) => post('/api/equipment-config', config);
export const deleteEquipmentConfig = (id: string) => del(`/api/equipment-config/${encodeURIComponent(id)}`);
export const getInventoryConfig = () => get<any[]>('/api/inventory-config');
export const saveInventoryConfig = (config: any) => post('/api/inventory-config', config);
export const deleteInventoryConfig = (id: string) => del(`/api/inventory-config/${encodeURIComponent(id)}`);
export const addInventoryConfigItem = (item: any) => post('/api/inventory-config/item', item);
export const updateInventoryConfigItem = (id: string, item: any) =>
  put(`/api/inventory-config/item/${encodeURIComponent(id)}`, item);
export const importInventoryConfig = (items: any[]) => post('/api/inventory-config/import', { items });

export const clearAllData = () => post('/api/clear-all-data');

// ==================== 盘点 ====================
export const createStocktake = (scope?: string[]) => post('/api/stocktakes', { scope });
export const getStocktakes = () => get<any[]>('/api/stocktakes');
export const getStocktake = (id: string) => get<any>(`/api/stocktakes/${encodeURIComponent(id)}`);
export const saveStocktake = (id: string, items: any[]) =>
  put(`/api/stocktakes/${encodeURIComponent(id)}`, { items });
export const completeStocktake = (id: string) =>
  post(`/api/stocktakes/${encodeURIComponent(id)}/complete`, {});
export const cancelStocktake = (id: string) =>
  del(`/api/stocktakes/${encodeURIComponent(id)}`);

// ==================== SN 注册表 ====================
export const getSNRegistry = () => get<any[]>('/api/sn-registry');
export const upsertSNRegistry = (entry: any) => post('/api/sn-registry', entry);
export const changeSNStatus = (data: any) => post('/api/sn-status-change', data);
export const shipSN = (snCode: string, trackingNumber: string) => post('/api/sn-registry/ship', { snCode, trackingNumber });
export const repairCompleteSN = (snCode: string) => post('/api/sn-registry/repair-complete', { snCode });
export const deleteSNFull = (snCode: string) => post('/api/sn-registry/delete-full', { snCode });
export const deleteUpload = (filePath: string) => post('/api/delete-upload', { filePath });

// ==================== 数据完整性 ====================
export const getDataIntegrity = () => get<any>('/api/data-integrity').catch(() => ({ issues: [], count: 0 }));

// ==================== 技术支持（工单） ====================
export const getTechSupportList = () => get<any[]>('/api/tech-support');
export const getTechSupportDetail = (id: string | number) => get<any>(`/api/tech-support/${encodeURIComponent(String(id))}`);
export const submitTechSupport = (payload: any) => post('/api/tech-support', payload);
export const respondTechSupport = (id: string | number) => post(`/api/tech-support/${encodeURIComponent(String(id))}/respond`);
export const completeTechSupport = (id: string | number, result: string, extra?: any) =>
  post(`/api/tech-support/${encodeURIComponent(String(id))}/complete`, { result, ...(extra || {}) });
export const deleteTechSupport = (id: string | number) => del(`/api/tech-support/${encodeURIComponent(String(id))}`);
export const getMyTechSupportHistory = () => get<any[]>('/api/tech-support/my-history');
// 常见故障模板（运营共享：任何运营账户可添加，全运营账户可见）
export const getCommonFaults = () => get<{ success: boolean; faults: any[] }>('/api/tech-support/common-faults').then(r => r.faults || []).catch(() => [] as any[]);
export const addCommonFault = (payload: { faultType: string; faultDescription: string }) =>
  post<{ success: boolean; faults: any[] }>('/api/tech-support/common-faults', payload);
export const deleteCommonFault = (id: string) => del(`/api/tech-support/common-faults/${encodeURIComponent(id)}`);
export const getMemoryList = (category: string) => get<any[]>(`/api/tech-support/memory/${encodeURIComponent(category)}`);
export const addMemory = (category: string, text: string) => post(`/api/tech-support/memory/${encodeURIComponent(category)}`, { text });

// ==================== 小组/转岗 ====================
export const getGroupTransfers = () => get<any[]>('/api/group/transfers');
export const getGroupMembers = () => get<any[]>('/api/group/members');
export const getMemberRepairStats = (userId: string, from?: string, to?: string) => {
  let path = '/api/team/member-repair-stats?userId=' + encodeURIComponent(userId);
  if (from) path += '&from=' + encodeURIComponent(from);
  if (to) path += '&to=' + encodeURIComponent(to);
  return get<any>(path);
};
export const createGroupTransfer = (payload: any) => post('/api/group/transfer', payload);
export const approveGroupTransfer = (id: string | number) => post(`/api/group/transfer/${id}/approve`);
export const rejectGroupTransfer = (id: string | number) => post(`/api/group/transfer/${id}/reject`);
export const cancelGroupTransfer = (id: string | number) => post(`/api/group/transfer/${id}/cancel`);
export const getSubordinates = () => get<any[]>('/api/users/subordinates');
export const getUserRepairStats = (userId: string) => get<any>(`/api/users/${encodeURIComponent(userId)}/repair-stats`);

// ==================== 任务进度 ====================
export const submitTaskProgress = (progress: any, note?: string) => post('/api/task-progress', { progress, note });
export const getTaskProgress = (date?: string) => get<any>(date ? `/api/task-progress?date=${date}` : '/api/task-progress');
export const getUserTaskProgress = (userId: string, date?: string) =>
  get<any>(`/api/task-progress?userId=${encodeURIComponent(userId)}${date ? `&date=${date}` : ''}`);

// ==================== 用户管理 ====================
export const getUsers = () => get<any[]>('/api/users');
export const addUser = (userData: any) => post('/api/users', userData);
export const deleteUser = (userId: string | number) => del(`/api/users/${encodeURIComponent(String(userId))}`);
export const promoteUser = (userId: string | number) => post(`/api/users/${encodeURIComponent(String(userId))}/promote`);
export const resetPassword = (userId: string | number, newPassword: string) =>
  post(`/api/users/${encodeURIComponent(String(userId))}/reset-password`, { newPassword });
export const updateUser = (userId: string | number, data: { username: string; password?: string }) =>
  post(`/api/users/${encodeURIComponent(String(userId))}`, data);
export const getUserPasswordInfo = (userId: string | number) =>
  get<any>(`/api/users/${encodeURIComponent(String(userId))}/password`);
export const changePassword = (oldPassword: string, newPassword: string) =>
  post('/api/change-password', { oldPassword, newPassword });

// ==================== 个人资料 ====================
export const getMyProfile = () => get<any>('/api/me');
export const updateMyProfile = (data: any) => put('/api/me', data);
export const getMyActivity = (limit = 100) =>
  get<any>(`/api/my-activity?limit=${limit}`).catch(() => ({ items: [] as any[] }));

// ==================== 弹窗句子 ====================
export const getPopupMessages = (category?: string) =>
  get<any[]>(`/api/popup-messages${category ? `?category=${encodeURIComponent(category)}` : ''}`);
export const getRandomPopupMessage = (category = 'submit') =>
  get<{ text: string }>(`/api/popup-messages/random?category=${encodeURIComponent(category)}`).catch(() => ({ text: '操作成功！' }));
export const addPopupMessage = (category: string, text: string) => post('/api/popup-messages', { category, text });
export const deletePopupMessage = (id: string | number) => del(`/api/popup-messages/${encodeURIComponent(String(id))}`);

// ==================== SOP 文档 ====================
export const getSOP = () => get<any[]>('/api/sop');
export const addSOP = (payload: any) => post('/api/sop', payload);
export const deleteSOP = (id: string | number) => post('/api/sop/delete', { id });

// ==================== 手套调出/调回 ====================
export const transferGloves = (payload: any) => post('/api/transfers', payload);
export const recallGloves = (payload: any) => post('/api/transfers/recall', payload);
export const getTransfers = () => get<any[]>('/api/transfers');
export const getTransferStats = () => get<any>('/api/transfers/stats');

// ==================== 聊天/客服 ====================
export const sendChatMessage = (recipientId: string, recipientName: string, message: string) =>
  post('/api/chat/send', { recipientId, recipientName, message });
export const getChatHistory = (withUserId: string) => get<any[]>(`/api/chat/history?withUserId=${encodeURIComponent(withUserId)}`);
export const getChatUnread = () => get<any[]>('/api/chat/unread');
export const getChatConversations = () => get<any[]>('/api/chat/conversations');
export const markChatRead = (userId: string) => post('/api/chat/mark-read', { userId });
export const getChatHelpdesk = () => get<any>('/api/chat/helpdesk').catch(() => null);

// ==================== 置换库存 ====================
export const getReplacements = () => get<any[]>('/api/replacement/list');
export const addReplacement = (snCode: string, note?: string) => post('/api/replacement/add', { snCode, note });
export const returnReplacement = (snCode: string, note?: string) => post('/api/replacement/return', { snCode, note });
export const shipReplacement = (snCode: string, trackingNumber: string, note?: string) =>
  post('/api/replacement/ship', { snCode, trackingNumber, note });

// ==================== 送货单 ====================
export const saveDeliveryNote = (payload: any) => post('/api/delivery-notes/save', payload);
export const getDeliveryNotes = () => get<any>('/api/delivery-notes/list').then(d => (Array.isArray(d?.list) ? d.list : []));
export const getDeliveryNote = (id: string) => get<any>(`/api/delivery-notes/${encodeURIComponent(id)}`);
export const updateDeliveryNote = (id: string, payload: any) => put(`/api/delivery-notes/${encodeURIComponent(id)}`, payload);
export const deleteDeliveryNote = (id: string) => del(`/api/delivery-notes/${encodeURIComponent(id)}`);

// ==================== 班次首检 ====================
export const getTodayShiftInspections = () => get<any>('/api/shift-inspections/today');
export const saveShiftInspection = (machineCode: string, payload: any) =>
  post(`/api/machines/${encodeURIComponent(machineCode)}/shift-inspection`, payload);
export const getMachineShiftInspections = (machineCode: string) =>
  get<any>(`/api/machines/${encodeURIComponent(machineCode)}/shift-inspections`);

// ==================== 服务器看板 ====================
export const getServerStatus = () => get<any>('/api/server-status');

// ==================== 库位管理 ====================
export const getStorageLocations = () => get<any[]>('/api/storage-locations');
export const addStorageLocation = (loc: any) => post('/api/storage-locations', loc);
export const updateStorageLocation = (code: string, loc: any) => put(`/api/storage-locations/${encodeURIComponent(code)}`, loc);
export const deleteStorageLocation = (code: string) => del(`/api/storage-locations/${encodeURIComponent(code)}`);
export const getLocationSNs = (code: string) => get<any[]>(`/api/storage-locations/${encodeURIComponent(code)}/sns`);

// ==================== 仓库管理（Phase 1 企业级基座） ====================
export const getWarehouses = () => get<any[]>('/api/warehouses');
export const createWarehouse = (p: any) => post('/api/warehouses', p);
export const updateWarehouse = (id: string, p: any) => put(`/api/warehouses/${encodeURIComponent(id)}`, p);
export const deleteWarehouse = (id: string) => del(`/api/warehouses/${encodeURIComponent(id)}`);

// ==================== 角色/权限（RBAC） ====================
export const getPermissions = () => get<any>('/api/permissions');
export const getRoles = () => get<any[]>('/api/roles');
export const createRole = (p: any) => post('/api/roles', p);
export const updateRole = (id: string, p: any) => put(`/api/roles/${encodeURIComponent(id)}`, p);
export const deleteRole = (id: string) => del(`/api/roles/${encodeURIComponent(id)}`);

// ==================== 库存审计 ====================
export const getInventoryAudit = (params?: string) => get<any[]>(`/api/inventory-audit${params ? `?${params}` : ''}`);

// ==================== 批次管理 & 仓库调拨（Phase 2） ====================
export const getBatches = (params?: string) => get<any[]>(`/api/batches${params ? `?${params}` : ''}`);
export const getWarehouseTransfers = (params?: string) => get<any[]>(`/api/warehouse-transfers${params ? `?${params}` : ''}`);
export const createWarehouseTransfer = (p: any) => post('/api/warehouse-transfers', p);
export const approveWarehouseTransfer = (id: string) => post(`/api/warehouse-transfers/${encodeURIComponent(id)}/approve`);
export const rejectWarehouseTransfer = (id: string, note?: string) => post(`/api/warehouse-transfers/${encodeURIComponent(id)}/reject`, { note: note || '' });

// ==================== 解决方案 ====================
export const getSolutions = (params: Record<string, any> = {}) => {
  const qs = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return get<any[]>(`/api/solutions${qs ? '?' + qs : ''}`);
};
export const getSolution = (id: string | number) => get<any>(`/api/solutions/${id}`);
export const createSolution = (payload: any) => post('/api/solutions', payload);
export const updateSolution = (id: string | number, payload: any) => put(`/api/solutions/${id}`, payload);
export const deleteSolution = (id: string | number) => del(`/api/solutions/${id}`);
export const getSolutionStats = () => get<any>('/api/solutions/stats');
export const getTicketSolutions = (ticketId: string | number) => get<any[]>(`/api/tech-support/${ticketId}/solutions`);
export const linkSolution = (ticketId: string | number, solutionId: string | number) =>
  post(`/api/tech-support/${ticketId}/solutions`, { solutionId });
export const unlinkSolution = (ticketId: string | number, solutionId: string | number) =>
  del(`/api/tech-support/${ticketId}/solutions/${solutionId}`);

// ==================== 通知/消息中心（本地存储，与旧版 gms_notifications 键保持一致） ====================
const NOTIF_KEY = 'gms_notifications';
export const getNotifications = (): any[] => {
  try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); } catch { return []; }
};
export const saveNotifications = (list: any[]): void => {
  localStorage.setItem(NOTIF_KEY, JSON.stringify(list.slice(0, 100)));
};
export const addNotification = (n: any): void => {
  const list = getNotifications();
  list.unshift({ id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), read: false, createdAt: new Date().toISOString(), ...n });
  saveNotifications(list);
};

// ==================== 版本/状态 ====================
export const getVersion = () => get<{ version: string }>('/api/version', 3000);
export const getServerLoad = () => get<any>('/api/status', 5000);

// ==================== 附件上传（移植 js/ui/attachments.js：压缩后以 dataUrl 上传） ====================
export async function uploadAttachment(file: File, maxSizeKB = 5120): Promise<string | null> {
  const dataUrl = await new Promise<string | null>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  if (dataUrl.length > maxSizeKB * 1024 * 1.37) {
    throw new Error('附件过大，请压缩后重试');
  }
  const res = await post<{ success?: boolean; url?: string; filePath?: string; error?: string }>(
    '/api/upload', { filename: file.name, data: dataUrl }, 30000,
  );
  return res?.url || res?.filePath || null;
}
