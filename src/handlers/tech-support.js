/**
 * Tech-Support Domain Handlers (Phase 2.1 step7)
 * 技术支持域：工单提交/响应/完成/删除 + 维修日志导出
 *
 * Factory / Dependency Injection pattern:
 *   module.exports = function createTechSupportHandlers(deps) { ... return handlers }
 *
 * Internal helpers (only called within this domain):
 *   _recomputeMachineStatusFromGloves — 维修完成/删除后按手套绑定重置机器状态
 *   _updateMachineStatusByNumber — 工单提交/响应时设置 waiting_repair / repairing
 */
'use strict';

const { computeDeadlines, isBreached, getDefaultConfig } = require('../../lib/sla');
const { requireTechResponder, requireTechAdmin } = require('./_permissions');

module.exports = function createTechSupportHandlers(deps) {
  const {
    pool, sendJSON, _cached,
    readJSONById, deleteJSON, saveMachine, saveTechSupport,
    _syncInventoryFromSN,
    broadcastChange,
    realtime, feishu,
    fmtDuration: _fmtDuration,
    // Phase B: SLA 配置存取（settings 表辅助函数，可选注入）
    getSetting, saveSetting,
    // 机器生产状态写入口（machines 域注入，可选）：提交工单→待维修，完成工单→可生产
    setProductionStatus,
  } = deps;

  // SLA 配置缓存（启动加载，PUT 时刷新）
  let _slaConfig = getDefaultConfig();
  async function _loadSLAConfig() {
    if (!getSetting) return _slaConfig;
    try {
      const v = await getSetting('tech_support_sla_config');
      if (v) _slaConfig = typeof v === 'string' ? JSON.parse(v) : v;
    } catch (e) { /* 降级用默认 */ }
    return _slaConfig;
  }
  // 启动时异步加载（非阻塞）
  _loadSLAConfig();

  // ============================================================
  // ITSM 状态机向后兼容层
  // ============================================================
  // 新枚举 → 旧枚举映射：open/assigned→pending，in_progress/reopened→responded，resolved/closed→completed
  // 所有旧消费者（导出 XLSX、机器状态联动判断）经此映射后零感知。
  const STATUS_LEGACY_MAP = {
    open: 'pending',
    assigned: 'pending',
    in_progress: 'responded',
    reopened: 'responded',
    resolved: 'completed',
    closed: 'completed',
  };
  function _legacyStatus(s) {
    return STATUS_LEGACY_MAP[s] || s;
  }

  // 工单默认字段（ITSM 升级新增）
  const ITSM_DEFAULTS = {
    priority: 'P2',
    severity: 'S3',
    category: 'hardware',
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    slaRespondBy: null,
    slaResolveBy: null,
    slaBreached: false,
    reopenedCount: 0,
    attachedFileIds: [],
    resolutionNote: '',
    kbTag: null,
    tags: [],
  };

  // 按 faultType 推断 category（迁移用）
  function _inferCategory(faultType) {
    if (!faultType) return 'hardware';
    const ft = faultType.toLowerCase();
    if (/(闪退|无法启动|连接失败|数据异常|软件|程序|系统|崩溃)/.test(ft)) return 'software';
    if (/(网络|断网|掉线|延迟|网速)/.test(ft)) return 'network';
    if (/(操作|使用|咨询|培训)/.test(ft)) return 'operation';
    if (/(硬件|损坏| broken|坏|故障)/.test(ft)) return 'hardware';
    return 'other';
  }

  // ============================================================
  // Internal helpers (tech-support domain only)
  // ============================================================

  // Recompute machine status based on glove bindings
  // Rule: Both left+right bound -> online, one bound -> partial, none -> offline
  async function _recomputeMachineStatusFromGloves(machineNumber) {
    if (!machineNumber) return;
    const [rows] = await pool.execute(
      "SELECT handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use'",
      [machineNumber]
    );
    const hands = new Set(rows.map(r => r.handType));
    let newStatus = 'offline';
    if (hands.has('left') && hands.has('right')) newStatus = 'online';
    else if (hands.size > 0) newStatus = 'partial';

    const [machineRows] = await pool.execute(
      'SELECT id, data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
      [machineNumber]
    );
    if (machineRows.length === 0) return;
    const d = JSON.parse(machineRows[0].data);
    d.status = newStatus;
    d.updatedAt = new Date().toISOString();
    await saveMachine(machineRows[0].id, d);
    console.log(`[Machine Recompute] ${machineNumber} -> ${newStatus} (from gloves)`);
  }

  // Update the latest machine record's status by machineNumber
  // 非事务版：供技术支持流程独占调用（设置 waiting_repair/repairing/online）
  async function _updateMachineStatusByNumber(machineNumber, newStatus) {
    if (!machineNumber) return;
    try {
      const [rows] = await pool.execute(
        'SELECT id, data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
        [machineNumber]
      );
      if (rows.length === 0) {
        console.log(`[Machine Status] ${machineNumber} not found`);
        return;
      }
      const d = JSON.parse(rows[0].data);
      d.status = newStatus;
      d.updatedAt = new Date().toISOString();
      await saveMachine(rows[0].id, d);
      console.log(`[Machine Status] ${machineNumber} -> ${newStatus}`);
    } catch (e) {
      console.error('[Machine Status Update Error]', e.message);
    }
  }

  // ============================================================
  // Handlers
  // ============================================================

  async function handleGetTechSupportList(req, res, authUser) {
    // 只返回今天提交/完成的记录 + 所有未完成的记录，减少数据量提升响应速度
    const LIMIT = 500;
    const items = await _cached('tech_support', async () => {
      // 用冗余列 status_v2 / submitted_ts 在 SQL 层过滤，命中索引，避免全量拉取1000条 MEDIUMTEXT
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartISO = todayStart.toISOString();
      const [rows] = await pool.execute(
        `SELECT data FROM tech_support
         WHERE status_v2 IN ('pending','in_progress')
            OR submitted_ts >= ?
         ORDER BY id DESC`,
        [todayStartISO]
      );
      return rows.map(r => JSON.parse(r.data));
    });
    // 计算今天00:00:00的时间戳
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartISO = todayStart.toISOString();
    // 未完成的状态
    const unfinishedStatuses = ['pending', 'in_progress'];
    const isToday = (t) => t && t >= todayStartISO;
    let filtered = items.filter(item =>
      unfinishedStatuses.includes(item.status) ||
      isToday(item.submittedAt) ||
      isToday(item.completedAt)
    );
    if (authUser.system === 'operations' && authUser.role !== 'superadmin') {
      if (authUser.role === 'admin') {
        const [subs] = await pool.execute('SELECT id FROM users WHERE parentId = ?', [authUser.userId]);
        const subIds = new Set(subs.map(s => s.id));
        subIds.add(authUser.userId);
        filtered = filtered.filter(item => subIds.has(item.submitterId));
      } else {
        filtered = filtered.filter(item => item.submitterId === authUser.userId);
      }
    }
    filtered.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    // 截断到 LIMIT 条，减少传输量（前端分页 PAGE_SIZE=30，500 条足够 16 页）
    sendJSON(res, filtered.slice(0, LIMIT));
  }

  async function handleGetTechSupportDetail(req, res, authUser, id) {
    const [rows] = await pool.execute('SELECT data FROM tech_support WHERE id = ?', [id]);
    if (rows.length === 0) return sendJSON(res, { error: '请求不存在' }, 404);
    const item = JSON.parse(rows[0].data);
    if (authUser.system === 'operations' && authUser.role !== 'superadmin') {
      let allowed = item.submitterId === authUser.userId;
      if (!allowed && authUser.role === 'admin') {
        const [sub] = await pool.execute('SELECT id FROM users WHERE id = ? AND parentId = ?', [item.submitterId, authUser.userId]);
        allowed = sub.length > 0;
      }
      if (!allowed) return sendJSON(res, { error: '无权限查看' }, 403);
    }
    sendJSON(res, item);
  }

  async function handleGetRepairResults(req, res) {
    const [rows] = await pool.execute(
      `SELECT data FROM tech_support WHERE status_v2 IN ('completed') ORDER BY id DESC LIMIT 1000`
    );
    const results = new Set();
    for (const row of rows) {
      try {
        const item = JSON.parse(row.data);
        if (item.result && item.result.trim()) results.add(item.result.trim());
      } catch {}
    }
    sendJSON(res, [...results].sort());
  }

  // 我的提交历史（跟随账户，跨设备可见）：从本人历史工单中提取「故障现象+说明」去重记录
  async function handleGetMySubmitHistory(req, res, authUser) {
    const [rows] = await pool.execute(
      'SELECT data FROM tech_support WHERE submitter_id = ? ORDER BY id DESC LIMIT 200',
      [authUser.userId]
    );
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      try {
        const it = JSON.parse(r.data);
        if (!it.faultType || !it.faultDescription) continue;
        const key = `${it.faultType}\u0000${it.faultDescription}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ faultType: it.faultType, faultDescription: it.faultDescription, submittedAt: it.submittedAt || null });
        if (out.length >= 20) break;
      } catch {}
    }
    sendJSON(res, out);
  }

  // ==================== 常见故障模板（运营共享） ====================
  // 存储：settings 表 skey='tech_support_common_faults'，JSON 数组。
  // 任何运营账户（含普通 user）均可添加，全运营账户可见可用；仅添加人/超管可删除。
  const COMMON_FAULTS_SKEY = 'tech_support_common_faults';
  const COMMON_FAULTS_MAX = 100;

  async function _readCommonFaults() {
    if (!getSetting) return [];
    try {
      const v = await getSetting(COMMON_FAULTS_SKEY);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      console.error('[TECH_SUPPORT] 读取常见故障失败:', e.message);
      return [];
    }
  }

  function _isOperations(authUser) {
    return authUser && (authUser.system === 'operations' || authUser.role === 'superadmin');
  }

  // GET /api/tech-support/common-faults（登录即可读）
  async function handleListCommonFaults(req, res) {
    sendJSON(res, { success: true, faults: await _readCommonFaults() });
  }

  // POST /api/tech-support/common-faults（运营可添加）
  async function handleAddCommonFault(req, res, authUser, body) {
    if (!_isOperations(authUser)) {
      return sendJSON(res, { error: '仅运营用户可添加常见故障' }, 403);
    }
    const faultType = String((body && body.faultType) || '').trim();
    const faultDescription = String((body && body.faultDescription) || '').trim();
    if (!faultType || !faultDescription) {
      return sendJSON(res, { error: '故障现象和故障说明都不能为空' }, 400);
    }
    if (faultType.length > 50) return sendJSON(res, { error: '故障现象过长（最多 50 字）' }, 400);
    if (faultDescription.length > 500) return sendJSON(res, { error: '故障说明过长（最多 500 字）' }, 400);
    if (!saveSetting) return sendJSON(res, { error: '配置服务不可用' }, 503);

    const list = await _readCommonFaults();
    if (list.some(f => f.faultType === faultType && f.faultDescription === faultDescription)) {
      return sendJSON(res, { error: '该常见故障已存在，请勿重复添加' }, 400);
    }
    list.unshift({
      id: `cf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      faultType,
      faultDescription,
      createdBy: authUser.userId || '',
      createdByName: authUser.displayName || authUser.username || '',
      createdAt: new Date().toISOString(),
    });
    while (list.length > COMMON_FAULTS_MAX) list.pop();
    await saveSetting(COMMON_FAULTS_SKEY, list);
    console.log(`[TECH_SUPPORT] 常见故障已添加 by ${authUser.username}: ${faultType}`);
    sendJSON(res, { success: true, faults: list });
  }

  // DELETE /api/tech-support/common-faults/:id（添加人或超管可删）
  async function handleDeleteCommonFault(req, res, authUser, id) {
    if (!_isOperations(authUser)) {
      return sendJSON(res, { error: '仅运营用户可管理常见故障' }, 403);
    }
    if (!id) return sendJSON(res, { error: '缺少常见故障 ID' }, 400);
    if (!saveSetting) return sendJSON(res, { error: '配置服务不可用' }, 503);

    const list = await _readCommonFaults();
    const idx = list.findIndex(f => f.id === id);
    if (idx < 0) return sendJSON(res, { error: '常见故障不存在或已被删除' }, 404);
    if (authUser.role !== 'superadmin' && list[idx].createdBy && list[idx].createdBy !== authUser.userId) {
      return sendJSON(res, { error: '仅添加人或管理员可删除该常见故障' }, 403);
    }
    const removed = list.splice(idx, 1)[0];
    await saveSetting(COMMON_FAULTS_SKEY, list);
    console.log(`[TECH_SUPPORT] 常见故障已删除 by ${authUser.username}: ${removed.faultType} (${id})`);
    sendJSON(res, { success: true, faults: list });
  }

  async function handleSubmitTechSupport(req, res, authUser, body) {
    if (authUser.system !== 'operations' && authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅运营用户可提交技术支持请求' }, 403);
    }
    const { equipmentType, equipmentTypeName, machineId, machineNumber, faultType, faultDescription } = body;
    if (!equipmentType || !machineId || !faultType || !(faultDescription || '').trim()) {
      return sendJSON(res, { error: '请填写所有必填字段（设备类型、设备编号、故障类型、故障描述）' }, 400);
    }

    const machineNo = machineNumber || machineId;
    // 检查该设备是否有未完成的技术支持请求（用冗余列直接在 SQL 层过滤，避免全表扫描）
    const [dupRows] = await pool.execute(
      `SELECT data FROM tech_support
       WHERE status_v2 IN ('pending','in_progress')
         AND machine_no = ?
       ORDER BY id DESC LIMIT 1`,
      [machineNo]
    );
    if (dupRows.length > 0) {
      const unfinished = JSON.parse(dupRows[0].data);
      const statusLabel = unfinished.status === 'pending' ? '待响应' : '处理中';
      return sendJSON(res, {
        error: `设备 ${machineNo} 已有 ${statusLabel} 的技术支持请求（提交人：${unfinished.submitterName}），请等待维修完成后再提交`,
      }, 400);
    }
    const now = new Date().toISOString();
    const id = `ts-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
    // 合并 ITSM_DEFAULTS + 业务字段 + 新 status='pending'
    const category = _inferCategory(faultType);
    // Phase B: 按优先级计算 SLA 截止时间
    const priority = body.priority && ['P0','P1','P2','P3'].includes(body.priority) ? body.priority : 'P2';
    const sla = computeDeadlines(priority, now, _slaConfig);
    const item = Object.assign({}, ITSM_DEFAULTS, {
      id,
      submitterId: authUser.userId,
      submitterName: authUser.displayName || authUser.username,
      equipmentType,
      equipmentTypeName: equipmentTypeName || equipmentType,
      machineId,
      machineNumber: machineNumber || machineId,
      faultType,
      faultDescription: faultDescription || '',
      status: 'pending',
      responderId: null,
      responderName: null,
      respondedAt: null,
      completedAt: null,
      result: '',
      submittedAt: now,
      createdAt: now,
      waitSeconds: null,
      repairSeconds: null,
      totalSeconds: null,
      category,
      priority,
      slaRespondBy: sla.slaRespondBy,
      slaResolveBy: sla.slaResolveBy,
    });
    await saveTechSupport(id, item);
    await _updateMachineStatusByNumber(item.machineNumber, 'waiting_repair');
    // 生产状态联动：提交工单 → 待维修
    if (typeof setProductionStatus === 'function') {
      setProductionStatus({
        machineNumber: item.machineNumber, status: 'waiting_repair', source: 'ticket',
        ticketId: id, reason: `提交维修工单：${faultType}`,
      }).catch(e => console.error('[Production Status] 工单联动失败:', e.message));
    }
    broadcastChange('tech_support', ['machines'], { action: 'created', id });
    sendJSON(res, { success: true, item });
    setImmediate(() => {
      realtime.notifyNewTechSupport(item);
      feishu.syncToFeishu(item).catch(e => console.error('[Feishu] Sync err:', e.message));
      feishu.sendGroupMessage(
        '🔧 新的技术支持请求',
        `**提交人：** ${item.submitterName}\n**设备：** ${item.equipmentTypeName || item.equipmentType}\n**机器编号：** ${item.machineNumber}\n**故障类型：** ${item.faultType}\n**故障描述：** ${item.faultDescription || '无'}\n**提交时间：** ${new Date(item.submittedAt).toLocaleString('zh-CN')}\n\n[查看详情](http://10.5.51.216:8765)`
      ).catch(e => console.error('[Feishu] Notify err:', e.message));
    });
  }

  // ============================================================
  // 系统自动建单（边缘代理告警 → 技术支持工单）
  // 与 handleSubmitTechSupport 区别：无 HTTP/authUser 上下文，提交人为系统
  // 运营账号；复用同一套去重（机器有未完成工单则跳过）、SLA、机器状态联动、
  // 飞书通知。仅允许服务端内部调用（edge 域 reconcile 后触发），agent 不直接接触。
  //
  // 增强版：自动建单比人工建单更详细，包含完整的诊断信息、环境快照、设备状态
  // ============================================================
  async function createSystemTicket(opts) {
    const {
      machineNumber,
      faultType,
      faultDescription,
      priority = 'P2',
      equipmentType = 'glove',
      equipmentTypeName = '手套',
      alertCode = null,
      source = 'edge_agent',
      // 新增：详细诊断信息
      diagnostics = null,        // 诊断详情对象
      deviceSnapshot = null,     // 设备快照
      environmentInfo = null,    // 环境信息
      alertContext = null,       // 告警上下文
    } = opts || {};

    if (!machineNumber || !faultType || !(faultDescription || '').trim()) {
      return { ok: false, reason: 'missing_fields' };
    }

    // 去重：该机器已有 pending/in_progress 工单（人工或自动）则跳过，规则与人工提交一致
    const [dupRows] = await pool.execute(
      `SELECT id FROM tech_support
       WHERE status_v2 IN ('pending','in_progress')
         AND machine_no = ?
       ORDER BY id DESC LIMIT 1`,
      [machineNumber]
    );
    if (dupRows.length > 0) {
      return { ok: false, reason: 'already_open', existingId: dupRows[0].id };
    }

    // 提交人：系统运营账号（默认 sa-002 运营超管，运营端可见、可流转），
    // 可用环境变量 EDGE_TICKET_SUBMITTER_ID 覆盖
    const submitterId = process.env.EDGE_TICKET_SUBMITTER_ID || 'sa-002';
    let submitterName = '系统监控（边缘代理）';
    try {
      // users 表有 username/displayName 冗余列（users 不在 readJSONById 表白名单，直接查）
      const [uRows] = await pool.execute(
        'SELECT username, displayName FROM users WHERE id = ? LIMIT 1',
        [submitterId]
      );
      const u = uRows[0];
      if (u && (u.displayName || u.username)) {
        submitterName = `${u.displayName || u.username}（系统自动）`;
      }
    } catch (e) {
      console.error('[EDGE-TICKET] 系统账号读取失败，使用默认提交人名:', e.message);
    }

    // 构建故障描述（精简版：只保留排障必需信息）
    let detailedDescription = `【系统自动检测】${machineNumber || ''} ${faultDescription}`;

    // 诊断详情（仅 SN 冲突类告警会产生这段）
    if (diagnostics && alertCode !== 'unregistered_sn') {
      const diagLines = [];
      if (diagnostics.observedSN) diagLines.push(`观测SN ${diagnostics.observedSN}`);
      if (diagnostics.registeredSN) diagLines.push(`登记SN ${diagnostics.registeredSN}`);
      if (diagnostics.expectedHand) diagLines.push(`应接${diagnostics.expectedHand === 'left' ? '左' : '右'}口`);
      if (diagnostics.actualHand) diagLines.push(`实接${diagnostics.actualHand === 'left' ? '左' : '右'}口`);
      if (diagnostics.deviceStatus) diagLines.push(diagnostics.deviceStatus);
      if (diagnostics.boundMachine) diagLines.push(`绑定机器 ${diagnostics.boundMachine}`);
      if (diagLines.length) detailedDescription += `\n诊断: ${diagLines.join('，')}`;
    }

    // 设备快照：只列异常设备（✅ 连接正常的不再显示）。
    // 降级类告警除外：故障描述已指明是哪个组件连接断开，不再重复罗列
    // 无关设备（例如手套断开时避免再出现"❌机械臂"）
    if (deviceSnapshot && alertCode !== 'collector_degraded') {
      const dev = [];
      if (deviceSnapshot.leftGlove === false) dev.push('❌手套L');
      if (deviceSnapshot.rightGlove === false) dev.push('❌手套R');
      if (deviceSnapshot.leftDexterous === false) dev.push('❌灵巧手L');
      if (deviceSnapshot.rightDexterous === false) dev.push('❌灵巧手R');
      if (deviceSnapshot.quest === false) dev.push('❌Quest');
      if (deviceSnapshot.roboticArm === false) dev.push('❌机械臂');
      if (dev.length) detailedDescription += `\n${dev.join(' ')}`;
    }

    // 时间
    if (alertContext && alertContext.firstDetected) {
      detailedDescription += `\n检测 ${new Date(alertContext.firstDetected).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`;
    } else if (environmentInfo && environmentInfo.lastHeartbeat) {
      detailedDescription += `\n检测 ${new Date(environmentInfo.lastHeartbeat).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`;
    }

    // 原因与建议（故障库中登记的才有）
    if (alertContext) {
      if (alertContext.possibleCause) detailedDescription += `\n可能原因: ${alertContext.possibleCause}`;
      if (alertContext.suggestedAction) detailedDescription += `\n建议操作: ${alertContext.suggestedAction}`;
      if (alertContext.relatedAlerts && alertContext.relatedAlerts.length > 0 && alertCode !== 'unregistered_sn') {
        detailedDescription += `\n相关告警: ${alertContext.relatedAlerts.join('、')}`;
      }
    }

    const now = new Date().toISOString();
    const id = `ts-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const p = ['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : 'P2';
    const sla = computeDeadlines(p, now, _slaConfig);
    const item = Object.assign({}, ITSM_DEFAULTS, {
      id,
      submitterId,
      submitterName,
      equipmentType,
      equipmentTypeName: equipmentTypeName || equipmentType,
      machineId: machineNumber,
      machineNumber,
      faultType,
      faultDescription: detailedDescription,
      status: 'pending',
      responderId: null,
      responderName: null,
      respondedAt: null,
      completedAt: null,
      result: '',
      submittedAt: now,
      createdAt: now,
      waitSeconds: null,
      repairSeconds: null,
      totalSeconds: null,
      category: _inferCategory(faultType),
      priority: p,
      slaRespondBy: sla.slaRespondBy,
      slaResolveBy: sla.slaResolveBy,
      // 自动单标记（列表/统计可区分，不参与状态机）
      autoCreated: true,
      alertCode,
      source,
      // 保存原始诊断数据供后续分析
      diagnosticsData: diagnostics || {},
      deviceSnapshotData: deviceSnapshot || {},
      environmentData: environmentInfo || {},
      alertContextData: alertContext || {},
    });
    await saveTechSupport(id, item);
    await _updateMachineStatusByNumber(machineNumber, 'waiting_repair');
    // 生产状态联动：告警自动建单 → 待维修
    if (typeof setProductionStatus === 'function') {
      try {
        // 等待状态写入完成，避免同一心跳中的“开始录制”状态更新发生竞态。
        await setProductionStatus({
          machineNumber, status: 'waiting_repair', source: 'ticket',
          ticketId: id, reason: `告警自动建单：${faultType}`,
        });
      } catch (e) {
        console.error('[Production Status] 自动单联动失败:', e.message);
      }
    }
    broadcastChange('tech_support', ['machines'], { action: 'created', id, auto: true });
    setImmediate(() => {
      try { if (realtime && realtime.notifyNewTechSupport) realtime.notifyNewTechSupport(item); } catch {}
      try {
        if (feishu && feishu.syncToFeishu) {
          feishu.syncToFeishu(item).catch(e => console.error('[Feishu] Sync err:', e.message));
        }
        if (feishu && feishu.sendGroupMessage) {
          feishu.sendGroupMessage(
            '🤖 系统自动提交技术支持请求',
            `**提交人：** ${item.submitterName}\n**设备：** ${item.equipmentTypeName || item.equipmentType}\n**机器编号：** ${item.machineNumber}\n**故障类型：** ${item.faultType}\n**故障描述：** ${item.faultDescription}\n**提交时间：** ${new Date(item.submittedAt).toLocaleString('zh-CN')}\n\n[查看详情](http://10.5.51.216:8765)`
          ).catch(e => console.error('[Feishu] Notify err:', e.message));
        }
      } catch {}
    });
    console.log(`[EDGE-TICKET] 自动建单 ${id}：${machineNumber} ${faultType}（${alertCode || '-'}）`);
    return { ok: true, item };
  }

  // ============================================================
  // 录制恢复自动关单（系统自动流）
  // 采集员自行完成维修后重新开始录制（hermes.state.isRecording 由 false → true 时由 edge 域触发），
  // 系统自动完成该机器上"系统自动创建"的采集组件类未完成工单，无需运维人工关单。
  // 仅处理 autoCreated 的采集类工单（这些故障在恢复录制时即视为解除，如手套断联/组件降级/录制器未就绪）；
  // SN 绑定/库存类告警（hand_mismatch/sn_unusable 等）涉及系统侧数据确认，保持人工关闭，不自动处理。
  // pending（未响应）也允许完成：采集员现场自修的场景可能从未有人响应工单。
  // ============================================================
  const AUTO_CLOSE_ALERT_CODES = new Set([
    'collector_degraded', 'importer_unreachable', 'hermes_unreachable',
    'emergency_stopped', 'recorder_not_ready', 'hermes_errors',
  ]);

  async function autoCompleteCollectorTickets(machineNumber) {
    if (!machineNumber) return { closed: 0 };
    const [rows] = await pool.execute(
      `SELECT id, data FROM tech_support
       WHERE status_v2 IN ('pending','in_progress') AND machine_no = ?`,
      [machineNumber]
    );
    let closed = 0;
    for (const row of rows) {
      let item = null;
      try { item = JSON.parse(row.data); } catch { continue; }
      if (!item || item.autoCreated !== true) continue;                     // 只关系统自动建的工单
      if (!AUTO_CLOSE_ALERT_CODES.has(item.alertCode)) continue;            // 只关采集组件类故障
      if (item.status === 'completed' || _legacyStatus(item.status) === 'completed') continue;
      const now = new Date().toISOString();
      item.status = 'completed';
      item.completedAt = now;
      item.result = '系统自动完成：机器已恢复录制，采集组件恢复正常';
      item.resolutionNote = item.result;
      item.autoCompletedBy = 'edge_agent_recording';
      item.repairSeconds = item.respondedAt ? Math.round((new Date(now) - new Date(item.respondedAt)) / 1000) : null;
      item.totalSeconds = Math.round((new Date(now) - new Date(item.submittedAt)) / 1000);
      await saveTechSupport(row.id, item);
      closed++;
      await _recomputeMachineStatusFromGloves(machineNumber);
      // 录制恢复代表机器已投入生产；等待写入完成，避免被后续心跳覆盖。
      if (typeof setProductionStatus === 'function') {
        try {
          await setProductionStatus({
            machineNumber, status: 'in_production', source: 'recording',
            ticketId: row.id, reason: '机器开始录制，自动完成采集故障工单并进入生产',
          });
        } catch (e) {
          console.error('[Production Status] 录制恢复联动失败:', e.message);
        }
      }
      broadcastChange('tech_support', ['machines', 'sn_registry', 'inventory'], { action: 'completed', id: row.id });
      setImmediate(() => {
        try { if (realtime && realtime.notifyTechCompleted) realtime.notifyTechCompleted(item); } catch {}
        try { if (feishu && feishu.syncToFeishu) feishu.syncToFeishu(item).catch(e => console.error('[Feishu] Sync err:', e.message)); } catch {}
      });
      console.log(`[TECH_SUPPORT] 录制恢复自动关单: ${machineNumber} ${row.id}（${item.alertCode || '-'}）`);
    }
    return { closed };
  }

  async function handleRespondTechSupport(req, res, authUser, id) {
    if (!requireTechResponder(authUser, res, sendJSON, '仅运维人员或运营管理员可响应技术支持请求')) return;
    const [rows] = await pool.execute('SELECT data FROM tech_support WHERE id = ?', [id]);
    if (rows.length === 0) return sendJSON(res, { error: '请求不存在' }, 404);
    const item = JSON.parse(rows[0].data);
    // 仅 pending（待响应）可响应
    const respondable = ['pending'];
    if (!respondable.includes(item.status) && _legacyStatus(item.status) !== 'pending') {
      return sendJSON(res, { error: '该请求已被响应或已完成' }, 400);
    }
    const now = new Date().toISOString();
    item.status = 'in_progress';
    item.responderId = authUser.userId;
    item.responderName = authUser.username;
    item.respondedAt = now;
    item.waitSeconds = Math.round((new Date(now) - new Date(item.submittedAt)) / 1000);
    await saveTechSupport(id, item);
    await _updateMachineStatusByNumber(item.machineNumber, 'repairing');
    broadcastChange('tech_support', ['machines'], { action: 'responded', id });
    sendJSON(res, { success: true, item });
    setImmediate(() => {
      realtime.notifyTechResponded(item);
      feishu.syncToFeishu(item).catch(e => console.error("[Feishu] Sync err:", e.message));
    });
  }

  async function handleCompleteTechSupport(req, res, authUser, id, body) {
    if (!requireTechResponder(authUser, res, sendJSON, '仅运维人员或运营管理员可完成技术支持请求')) return;
    const [rows] = await pool.execute('SELECT data FROM tech_support WHERE id = ?', [id]);
    if (rows.length === 0) return sendJSON(res, { error: '请求不存在' }, 404);
    const item = JSON.parse(rows[0].data);
    // 已完成的不可重复完成
    if (item.status === 'completed' || _legacyStatus(item.status) === 'completed') {
      return sendJSON(res, { error: '该请求已完成' }, 400);
    }
    // 仅 in_progress（处理中）可完成（兼容旧 responded 经映射）
    if (item.status !== 'in_progress' && _legacyStatus(item.status) !== 'responded') {
      return sendJSON(res, { error: '请先响应技术支持请求，再进行维修完成' }, 400);
    }
    const result = (body && body.result || '').trim();
    if (!result) return sendJSON(res, { error: '维修结果为必填项，请填写维修结果' }, 400);
    const now = new Date().toISOString();
    item.status = 'completed';
    item.completedAt = now;
    item.result = result;
    item.resolutionNote = result;
    item.repairSeconds = Math.round((new Date(now) - new Date(item.respondedAt)) / 1000);
    item.totalSeconds = Math.round((new Date(now) - new Date(item.submittedAt)) / 1000);

    // 维修确认检查项（quest连接 / 相机连接 / 相机页面匹配 / 手套连接 / 可生产）
    if (body && typeof body.checklist === 'object' && body.checklist !== null) {
      const cl = body.checklist;
      const yes = ['yes', 'true', 'connected', 'matched', 'ok', '1'];
      const norm = v => (typeof v === 'boolean') ? v : yes.includes(String(v || '').toLowerCase());
      item.checklist = {
        questConnected: norm(cl.questConnected),
        wristCamLConnected: norm(cl.wristCamLConnected),
        wristCamRConnected: norm(cl.wristCamRConnected),
        wristPageLMatched: norm(cl.wristPageLMatched),
        wristPageRMatched: norm(cl.wristPageRMatched),
        gloveLConnected: norm(cl.gloveLConnected),
        gloveRConnected: norm(cl.gloveRConnected),
        canProduce: norm(cl.canProduce),
        checkedAt: now,
        operator: authUser.username
      };
    }

    const affectedSNs = (body && Array.isArray(body.affectedSNs)) ? body.affectedSNs : [];
    item.affectedSNs = affectedSNs;
    item.replacedSNs = (body && Array.isArray(body.replacedSNs)) ? body.replacedSNs : [];

    for (const snCode of affectedSNs) {
      const [snRows] = await pool.execute('SELECT status, equipmentType, handType FROM sn_registry WHERE snCode = ?', [snCode]);
      if (snRows.length > 0) {
        const historyId = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)  }-${  snCode.slice(-6)}`;
        await pool.execute(
          'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [historyId, snCode, snRows[0].status, snRows[0].status, authUser.username, `技术支持工单 ${id}: ${result}`, item.machineNumber, now]
        );
      }
    }

    for (const replacedSN of (body && Array.isArray(body.replacedSNs)) ? body.replacedSNs : []) {
      const [snRows] = await pool.execute('SELECT equipmentType, handType, status FROM sn_registry WHERE snCode = ?', [replacedSN.oldSN]);
      if (snRows.length > 0) {
        await pool.execute(
          'UPDATE sn_registry SET status = ?, machineNumber = NULL, damageReason = ?, updatedAt = ? WHERE snCode = ?',
          ['damaged', `技术支持工单 ${id} 更换`, now, replacedSN.oldSN]
        );
        const historyId = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
        await pool.execute(
          'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [historyId, replacedSN.oldSN, snRows[0].status, 'damaged', authUser.username, `技术支持工单 ${id} 更换手套`, item.machineNumber, now]
        );
        if (replacedSN.newSN) {
          const newHistoryId = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)  }-new`;
          await pool.execute(
            'INSERT INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
            [replacedSN.newSN, snRows[0].equipmentType, snRows[0].handType, 'available', '', now]
          );
          await pool.execute(
            'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [newHistoryId, replacedSN.newSN, '', 'available', authUser.username, `技术支持工单 ${id} 新手套入库`, '', now]
          );
        }
      }
    }

    await saveTechSupport(id, item);
    await _syncInventoryFromSN(pool);
    await _recomputeMachineStatusFromGloves(item.machineNumber);
    // 生产状态联动：维修完成 → 可生产
    if (typeof setProductionStatus === 'function') {
      setProductionStatus({
        machineNumber: item.machineNumber, status: 'ready', source: 'ticket',
        ticketId: id, reason: '维修工单完成，恢复可生产',
      }).catch(e => console.error('[Production Status] 完成联动失败:', e.message));
    }
    broadcastChange('tech_support', ['machines', 'sn_registry', 'inventory'], { action: 'completed', id });
    sendJSON(res, { success: true, item });
    setImmediate(() => {
      realtime.notifyTechCompleted(item);
      feishu.syncToFeishu(item).catch(e => console.error("[Feishu] Sync err:", e.message));
    });
  }

  async function handleDeleteTechSupport(req, res, authUser, id) {
    if (!requireTechAdmin(authUser, res, sendJSON, '仅运维系统或运营系统管理员可删除维修日志')) return;
    const item = await readJSONById('tech_support', id);
    if (!item) return sendJSON(res, { error: '记录不存在' }, 404);
    // 已完成的需重算机器状态；处理中的同样
    const wasCompleted = item.status === 'completed' || _legacyStatus(item.status) === 'completed';
    const wasResponded = item.status === 'in_progress' || _legacyStatus(item.status) === 'responded';
    const machineNumber = item.machineNumber;
    await deleteJSON('tech_support', id);

    if ((wasCompleted || wasResponded) && machineNumber) {
      try {
        await _recomputeMachineStatusFromGloves(machineNumber);
      } catch (e) {
        console.error('[TechSupport Delete] Machine status recompute failed:', e.message);
      }
    }
    // 未完成工单被删除（故障解除/误单）→ 生产状态恢复可生产；已是可生产则为空操作
    if (!wasCompleted && machineNumber && typeof setProductionStatus === 'function') {
      setProductionStatus({
        machineNumber, status: 'ready', source: 'ticket',
        ticketId: id, reason: '未完成工单被删除，恢复可生产',
      }).catch(e => console.error('[Production Status] 删除联动失败:', e.message));
    }

    broadcastChange('tech_support', ['machines'], { action: 'deleted', id });
    sendJSON(res, { success: true });
    setImmediate(() => feishu.deleteFromFeishu(id).catch(e => console.error("[Feishu] Delete err:", e.message)));
  }

  // -- Tech Support XLSX Export --
  async function handleExportTechSupportXLSX(req, res, user) {
    const XLSX = require('xlsx');
    const url = new URL(req.url, 'http://localhost');
    const dateParam = url.searchParams.get('date');
    const startParam = url.searchParams.get('start');
    const endParam = url.searchParams.get('end');
    const startTime = url.searchParams.get('startTime');
    const endTime = url.searchParams.get('endTime');

    const [dbRows] = await pool.execute('SELECT data FROM tech_support ORDER BY id DESC');
    let data = dbRows.map(r => JSON.parse(r.data)).reverse();
    if (user.system === 'operations' && user.role !== 'superadmin') {
      data = data.filter(i => i.submitterId === user.userId);
    }

    if (dateParam || startParam || endParam || startTime || endTime) {
      data = data.filter(t => {
        const ts = t.submittedAt ? new Date(t.submittedAt) : null;
        if (!ts || isNaN(ts.getTime())) return false;

        if (dateParam) {
          const d = dateParam.split('-').map(Number);
          if (ts.getFullYear() !== d[0] || ts.getMonth() + 1 !== d[1] || ts.getDate() !== d[2]) return false;
        }
        if (startParam) {
          if (ts < new Date(startParam)) return false;
        }
        if (endParam) {
          if (ts > new Date(endParam)) return false;
        }
        if (startTime || endTime) {
          const hourMin = ts.getHours() * 60 + ts.getMinutes();
          if (startTime) {
            const [sh, sm] = startTime.split(':').map(Number);
            const startMin = sh * 60 + sm;
            if (endTime) {
              const [eh, em] = endTime.split(':').map(Number);
              const endMin = eh * 60 + em;
              if (endMin < startMin) {
                if (hourMin < startMin && hourMin > endMin) return false;
              } else {
                if (hourMin < startMin || hourMin > endMin) return false;
              }
            } else {
              if (hourMin < startMin) return false;
            }
          } else if (endTime) {
            const [eh, em] = endTime.split(':').map(Number);
            const endMin = eh * 60 + em;
            if (hourMin > endMin) return false;
          }
        }
        return true;
      });
    }

    // 3 种状态：待响应 / 处理中 / 已完成（兼容旧枚举）
    const statusMap = {
      pending: '待响应', in_progress: '处理中', completed: '已完成',
    };
    const rows = data.map(t => ({
      '提交时间': t.submittedAt ? new Date(t.submittedAt).toLocaleString('zh-CN') : '-',
      '设备编号': t.machineNumber || t.machineId || '-',
      '故障设备': t.equipmentTypeName || t.equipmentType || '-',
      '故障现象': t.faultType || '-',
      '故障说明': t.faultDescription || '-',
      '提交人': t.submitterName || '-',
      '优先级': t.priority || 'P2',
      '分类': t.category || '-',
      '维修状态': statusMap[t.status] || statusMap[_legacyStatus(t.status)] || t.status || '-',
      '维修人员': t.responderName || t.assigneeName || '-',
      '响应时间': t.respondedAt ? new Date(t.respondedAt).toLocaleString('zh-CN') : '-',
      '恢复时间': t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '-',
      '等待时长': _fmtDuration(t.waitSeconds),
      '维修时长': _fmtDuration(t.repairSeconds),
      '总时长': _fmtDuration(t.totalSeconds),
      '处理结果': t.result || '-',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 22 },
      { wch: 12 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 22 },
      { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 22 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '维修日志');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = encodeURIComponent(`维修日志-${  new Date().toISOString().slice(0, 10)}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}.xlsx`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  }

  // ============================================================
  // Phase B: SLA 配置 handler
  // ============================================================
  async function handleGetSLAConfig(req, res, authUser) {
    // 所有登录用户可读 SLA 配置（前端展示用）；写操作限 superadmin
    const config = await _loadSLAConfig();
    sendJSON(res, config);
  }

  async function handleSaveSLAConfig(req, res, authUser, body) {
    if (authUser.role !== 'superadmin') {
      return sendJSON(res, { error: '仅超级管理员可修改 SLA 配置' }, 403);
    }
    // 简单校验：必须有 P0-P3 + autoCloseDays
    const validPriorities = ['P0', 'P1', 'P2', 'P3'];
    if (!body || typeof body !== 'object') {
      return sendJSON(res, { error: '配置格式错误' }, 400);
    }
    for (const p of validPriorities) {
      if (!body[p] || typeof body[p].respondMinutes !== 'number' || typeof body[p].resolveMinutes !== 'number') {
        return sendJSON(res, { error: `${p} 配置需包含 respondMinutes 和 resolveMinutes 数字` }, 400);
      }
    }
    if (typeof body.autoCloseDays !== 'number' || body.autoCloseDays < 1) {
      return sendJSON(res, { error: 'autoCloseDays 必须为正整数' }, 400);
    }
    if (!saveSetting) {
      return sendJSON(res, { error: '设置存储不可用' }, 500);
    }
    await saveSetting('tech_support_sla_config', JSON.stringify(body));
    _slaConfig = body; // 刷新内存缓存
    console.log('[TECH_SUPPORT][SLA] Config updated by', authUser.username);
    sendJSON(res, { success: true, config: body });
  }

  // Phase B: SLA 检查器入口（由 server.js 定时调用）
  // 扫描所有活跃工单，标记超时的 slaBreached=true 并通知
  async function _runSLACheck(notifyFn) {
    const activeStatuses = ['open', 'assigned', 'in_progress', 'reopened'];
    const placeholders = activeStatuses.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT id, data FROM tech_support WHERE status_v2 IN (${placeholders}) AND sla_breached = 0`,
      activeStatuses
    );
    let breachedCount = 0;
    for (const row of rows) {
      try {
        const item = JSON.parse(row.data);
        const result = isBreached(item, new Date());
        if (result.breached) {
          item.slaBreached = true;
          item.slaBreachReason = result.reason;
          item.slaBreachAt = new Date().toISOString();
          await saveTechSupport(row.id, item);
          breachedCount++;
          if (notifyFn) {
            try { await notifyFn(item, result.reason); } catch (e) {
              console.error('[TECH_SUPPORT][SLA] notify error:', e.message);
            }
          }
        }
      } catch (e) { /* 跳过坏数据 */ }
    }
    if (breachedCount > 0) {
      console.log(`[TECH_SUPPORT][SLA] scanned=${rows.length} breached=${breachedCount}`);
    }
    return { scanned: rows.length, breached: breachedCount };
  }

  return {
    handleGetTechSupportList,
    handleGetTechSupportDetail,
    handleGetRepairResults,
    handleGetMySubmitHistory,
    handleListCommonFaults,
    handleAddCommonFault,
    handleDeleteCommonFault,
    handleSubmitTechSupport,
    createSystemTicket,
    autoCompleteCollectorTickets,
    handleRespondTechSupport,
    handleCompleteTechSupport,
    handleDeleteTechSupport,
    handleExportTechSupportXLSX,
    // Phase B: SLA
    handleGetSLAConfig,
    handleSaveSLAConfig,
    _runSLACheck,
    // ITSM 兼容层导出（供单元测试与外部复用）
    _legacyStatus,
    _inferCategory,
    ITSM_DEFAULTS,
    STATUS_LEGACY_MAP,
  };
};
