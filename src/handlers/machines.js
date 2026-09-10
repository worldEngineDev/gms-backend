'use strict';

const os = require('os');

module.exports = function createMachinesHandlers(deps) {
  const {
    pool,
    sendJSON,
    _cached,
    _cache,
    saveMachine,
    saveMachineBinding,
    readJSONById,
    deleteJSON,
    saveJSON,
    _syncInventoryFromSN,
    _insertTransaction,
    _snToInvType,
    broadcastChange,
    broadcastSSE,
    loadEdgePresence,
    getEdgeLive,
  } = deps;

  function handleGetMachineCode(req, res) {
    const hostname = os.hostname();
    const machineCodeMatch = hostname.match(/^(we-\d+)$/);
    const machineCode = machineCodeMatch ? machineCodeMatch[1] : hostname;
    sendJSON(res, { machineCode, hostname });
  }

  async function handleMobileGetMachines(req, res) {
    try {

      const [rows] = await pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000');
      const all = rows.map(r => JSON.parse(r.data));
      all.sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id));
      const latest = new Map();
      for (const m of all) {
        const num = m.machineNumber;
        if (!num) continue;
        if (!latest.has(num)) latest.set(num, m);
      }
      const machines = Array.from(latest.values()).map(m => ({
        machineNumber: m.machineNumber,
        deviceType: m.deviceType || '',
        status: m.status || 'offline'
      }));

      const [snRows] = await pool.execute(
        "SELECT snCode, handType, machineNumber FROM sn_registry WHERE status = 'in_use' AND machineNumber IS NOT NULL AND machineNumber != ''"
      );
      const occupancy = {};
      for (const r of snRows) {
        if (!occupancy[r.machineNumber]) occupancy[r.machineNumber] = { left: null, right: null };
        if (r.handType === 'left') occupancy[r.machineNumber].left = r.snCode;
        else if (r.handType === 'right') occupancy[r.machineNumber].right = r.snCode;
      }

      const result = machines.map(m => {
        const o = occupancy[m.machineNumber];
        let effectiveStatus = 'offline';
        if (o && o.left && o.right) effectiveStatus = 'online';
        else if (o && (o.left || o.right)) effectiveStatus = 'partial';
        if (m.status === 'waiting_repair' || m.status === 'repairing') effectiveStatus = m.status;
        return {
          ...m,
          status: effectiveStatus,
          leftSN: (o && o.left) || null,
          rightSN: (o && o.right) || null,
        };
      });

      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          if (Object.keys(presence).length) {
            for (const m of result) {
              if (presence[m.machineNumber]) Object.assign(m, presence[m.machineNumber]);
            }
          }
        } catch (e) {
          console.error('[Mobile Machines] edge presence 合并失败:', e.message);
        }
      }

      try {
        const prodMap = await loadProductionStatuses();
        for (const m of result) {
          if (prodMap[m.machineNumber]) Object.assign(m, prodMap[m.machineNumber]);
        }
      } catch (e) {
        console.error('[Mobile Machines] production status 合并失败:', e.message);
      }

      sendJSON(res, { success: true, machines: result });
    } catch (e) {
      console.error('[Mobile Machines] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  async function handleGetMachineStatus(req, res, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);

      const [mRows] = await pool.execute(
        'SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
        [machineNumber]
      );
      if (mRows.length === 0) return sendJSON(res, { error: '机器不存在' }, 404);
      const m = JSON.parse(mRows[0].data);

      const [snRows] = await pool.execute(
        "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use'",
        [machineNumber]
      );
      const hands = new Set(snRows.map(r => r.handType));
      let effectiveStatus = 'offline';
      if (hands.has('left') && hands.has('right')) effectiveStatus = 'online';
      else if (hands.size > 0) effectiveStatus = 'partial';

      if (m.status === 'waiting_repair' || m.status === 'repairing') {
        effectiveStatus = m.status;
      }

      const leftSN = (snRows.find(r => r.handType === 'left') || {}).snCode || null;
      const rightSN = (snRows.find(r => r.handType === 'right') || {}).snCode || null;

      const unfinishedStatuses = ['open', 'assigned', 'in_progress', 'reopened'];
      const placeholders = unfinishedStatuses.map(() => '?').join(',');
      const [tsRows] = await pool.execute(
        `SELECT data FROM tech_support WHERE machine_no = ? AND status_v2 IN (${placeholders}) ORDER BY id DESC LIMIT 5`,
        [machineNumber, ...unfinishedStatuses]
      );
      let activeTicket = null;
      for (const row of tsRows) {
        try {
          const item = JSON.parse(row.data);

          if (item.machineNumber === machineNumber && unfinishedStatuses.includes(item.status)) {
            activeTicket = {
              id: item.id,
              status: item.status,
              faultType: item.faultType,
              faultDescription: item.faultDescription || '',
              submitterName: item.submitterName,
              submittedAt: item.submittedAt,
              responderName: item.responderName || null,
              respondedAt: item.respondedAt || null,
              priority: item.priority || 'P2',
            };
            break;
          }
        } catch {}
      }

      const statusLabelMap = {
        online: '在线', partial: '部分绑定', offline: '离线',
        waiting_repair: '等待维修', repairing: '维修中',
      };

      sendJSON(res, {
        success: true,
        machineNumber: m.machineNumber,
        deviceType: m.deviceType || '',
        status: effectiveStatus,
        statusLabel: statusLabelMap[effectiveStatus] || effectiveStatus,
        onlineTime: m.onlineTime || null,
        offlineTime: m.offlineTime || null,
        updatedAt: m.updatedAt || null,
        leftSN,
        rightSN,
        activeTicket,
      });
    } catch (e) {
      console.error('[Machine Status] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  async function handleGetMachines(req, res, user) {
    const records = await _cached('machines', async () => {
      const [rows] = await pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000');
      const all = rows.map(r => JSON.parse(r.data));

      all.sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id));
      const latest = new Map();
      for (const m of all) {
        const num = m.machineNumber;
        if (!num) continue;
        if (!latest.has(num)) latest.set(num, m);
      }
      return Array.from(latest.values());
    });

    let result = records;
    if (typeof loadEdgePresence === 'function') {
      try {
        const presence = await loadEdgePresence();
        if (Object.keys(presence).length) {
          result = records.map(machine => presence[machine.machineNumber]
            ? { ...machine, ...presence[machine.machineNumber] }
            : machine);
        }
      } catch (e) {
        console.error('[Machines] edge presence 合并失败:', e.message);
      }
    }

    try {
      const prodMap = await loadProductionStatuses();
      if (Object.keys(prodMap).length) {
        result = result.map(machine => prodMap[machine.machineNumber]
          ? { ...machine, ...prodMap[machine.machineNumber] }
          : machine);
      }
    } catch (e) {
      console.error('[Machines] production status 合并失败:', e.message);
    }

    sendJSON(res, result);
  }

  async function handleAddMachine(req, res, user, body) {

    const id = body.id || (`m-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`);

    if ((body.status === 'offline' || body.status === 'repairing') && body.machineNumber) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await saveMachine(id, { ...body, id }, conn);
        await unbindGlovesFromMachine(body.machineNumber, body.status, user.username, conn);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        console.error('[Machine] 添加机器记录及解绑失败:', e.message);
        return sendJSON(res, { error: '添加机器记录失败' }, 500);
      } finally {
        try { conn.release(); } catch {}
      }
    } else {
      await saveMachine(id, { ...body, id });
    }

    _cache.delete('machines');
    broadcastSSE('machines_updated', {});
    sendJSON(res, { success: true, machine: { ...body, id } });
  }

  async function unbindGlovesFromMachine(machineNumber, reason, operator, externalConn = null) {
    const conn = externalConn || await pool.getConnection();
    const isExternal = !!externalConn;
    try {
      if (!isExternal) await conn.beginTransaction();
      const [useConn] = await conn.execute(
        "SELECT snCode, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' FOR UPDATE",
        [machineNumber]
      );
      if (useConn.length === 0) {
        if (!isExternal) await conn.commit();
        return;
      }

      const now = new Date().toISOString();

      await conn.execute(
        "UPDATE sn_registry SET status='available', machineNumber=NULL, updatedAt=? WHERE machineNumber=? AND status='in_use'",
        [now, machineNumber]
      );

      for (const glove of useConn) {
        const historyId = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)  }-${  glove.snCode.slice(-6)}`;
        await conn.execute(
          "INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [historyId, glove.snCode, 'in_use', 'available', operator, `机器${reason === 'offline' ? '下线' : '报修'}自动解绑`, machineNumber, now]
        );
      }
      await _syncInventoryFromSN(conn);
      if (!isExternal) await conn.commit();
      broadcastChange('sn_registry', ['inventory']);
      console.log(`[Machine] 已解绑 ${machineNumber} 上的 ${useConn.length} 只手套`);
    } catch (e) {
      if (!isExternal) await conn.rollback();
      console.error('[Machine] 解绑手套失败:', e.message);
      throw e;
    } finally {
      if (!isExternal) {
        try { conn.release(); } catch {}
      }
    }
  }

  async function handleDeleteMachine(req, res, user, machineId) {
    if (user.role !== 'superadmin') return sendJSON(res, { error: '仅超级管理员可删除机器记录' }, 403);
    const machine = await readJSONById('machines', machineId);
    if (!machine) return sendJSON(res, { error: '机器不存在' }, 404);
    await deleteJSON('machines', machineId);
    const auditId = `audit-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
    await saveJSON('audit_log', auditId, {
      id: auditId,
      action: 'machine_delete',
      detail: `删除机器 ${machine.machineNumber} (ID: ${machineId})，设备类型: ${machine.deviceType || '未知'}，状态: ${machine.status || '未知'}`,
      user: user.username,
      userId: user.userId,
      machineId: machineId,
      machineNumber: machine.machineNumber,
      deviceType: machine.deviceType,
      status: machine.status,
      timestamp: new Date().toISOString(),
    });
    broadcastChange('machines', ['audit_log']);
    sendJSON(res, { success: true });
  }

  async function handleBindMachine(req, res, user, machineNumber, body) {
    if (!machineNumber) return sendJSON(res, { error: '缺少机器编号' }, 400);

    const [machineRows] = await pool.execute(
      "SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1",
      [machineNumber]
    );
    if (machineRows.length === 0) return sendJSON(res, { error: '机器不存在' }, 404);

    const machine = JSON.parse(machineRows[0].data);
    if (!machine || !machine.machineNumber) return sendJSON(res, { error: '机器数据异常' }, 500);

    const [conflictRows] = await pool.execute(
      "SELECT data FROM machine_bindings WHERE machineNumber = ? AND unboundAt IS NULL ORDER BY id DESC LIMIT 1",
      [machineNumber]
    );
    if (conflictRows.length > 0) {
      const existingBinding = JSON.parse(conflictRows[0].data);
      if (existingBinding.userId && existingBinding.userId !== user.userId) {
        return sendJSON(res, {
          error: `机器 ${machineNumber} 已被 ${existingBinding.username} 绑定，请选择其他机器`,
          boundBy: existingBinding.username
        }, 409);
      }
    }

    const unbindTimestamp = new Date().toISOString();
    try {
      await pool.execute(
        "UPDATE machine_bindings SET data = JSON_SET(data, '$.unboundAt', ?, '$.unboundBy', ?), unboundAt = ? WHERE userId = ? AND unboundAt IS NULL",
        [unbindTimestamp, user.username, unbindTimestamp, user.userId]
      );
    } catch (e) {

      console.warn('[Machine] 批量解绑失败，退回逐条解绑:', e.message);
      const [oldBindings] = await pool.execute(
        'SELECT id, data FROM machine_bindings WHERE userId = ? AND unboundAt IS NULL',
        [user.userId]
      );
      for (const ob of oldBindings) {
        try {
          const obData = JSON.parse(ob.data);
          obData.unboundAt = unbindTimestamp;
          obData.unboundBy = user.username;
          await saveMachineBinding(ob.id, obData);
        } catch (e2) { console.warn('[Machine] 解绑单条失败:', ob.id, e2.message); }
      }
    }

    const bindingId = `bind-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
    const bindingData = {
      id: bindingId,
      machineNumber,
      userId: user.userId,
      username: user.username,
      displayName: user.displayName || user.username,
      boundAt: new Date().toISOString(),
      deviceType: machine.deviceType || null
    };
    await saveMachineBinding(bindingId, bindingData);

    broadcastSSE('machine_bindings_updated', { machineNumber, userId: user.userId, username: user.username, displayName: user.displayName || user.username, action: 'bind' });

    console.log(`[Binding] ${user.displayName || user.username} 绑定机器 ${machineNumber}`);
    sendJSON(res, { success: true, binding: bindingData });
  }

  async function handleUnbindMachine(req, res, user, machineNumber) {
    if (!machineNumber) return sendJSON(res, { error: '缺少机器编号' }, 400);

    const [rows] = await pool.execute(
      "SELECT id, data FROM machine_bindings WHERE machineNumber = ? AND userId = ? AND unboundAt IS NULL",
      [machineNumber, user.userId]
    );

    let unbound = false;
    for (const row of rows) {
      const bData = JSON.parse(row.data);
      bData.unboundAt = new Date().toISOString();
      bData.unboundBy = user.username;
      await saveMachineBinding(row.id, bData);
      unbound = true;
      console.log(`[Binding] ${user.username} 解绑机器 ${machineNumber}`);
    }

    if (!unbound) {
      return sendJSON(res, { success: true, message: '无需解绑' });
    }

    try {
      await unbindGlovesFromMachine(machineNumber, 'user_unbind', user.username);
    } catch (e) {
      console.error('[UnbindMachine] Glove unbind failed:', e.message);
    }

    broadcastSSE('machine_bindings_updated', { machineNumber, userId: user.userId, username: user.username, action: 'unbind' });
    sendJSON(res, { success: true });
  }

  async function handleGetMachineBindings(req, res, user) {

    const [bindings] = await pool.execute(
      "SELECT data FROM machine_bindings WHERE unboundAt IS NULL ORDER BY id DESC"
    );
    const result = bindings.map(b => JSON.parse(b.data));
    sendJSON(res, result);
  }

  async function handleSyncMachineState(req, res, authUser, machineNumber, body) {
    if (!machineNumber) return sendJSON(res, { error: '缺少机器编号' }, 400);
    const { status, deviceType, reason, offlineType, snOperations } = body;
    if (status !== 'online' && status !== 'offline') return sendJSON(res, { error: 'status 必须为 online 或 offline' }, 400);
    const ops = Array.isArray(snOperations) ? snOperations.filter(o => o && o.snCode) : [];
    const now = new Date().toISOString();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [currentInUse] = await conn.execute(
        "SELECT snCode, equipmentType, handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' FOR UPDATE",
        [machineNumber]
      );
      const inUseBySn = Object.create(null);
      for (const r of currentInUse) inUseBySn[r.snCode] = r;

      if (ops.length > 0) {
        const sns = ops.map(o => o.snCode);
        const ph = sns.map(() => '?').join(',');
        await conn.execute(
          `SELECT snCode FROM sn_registry WHERE snCode IN (${ph}) FOR UPDATE`,
          sns
        );
      }

      const allOps = [];
      const opBySn = Object.create(null);
      for (const o of ops) opBySn[o.snCode] = o;

      if (status === 'online') {

        for (const r of currentInUse) {
          if (!opBySn[r.snCode]) {
            allOps.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
              fromStatus: 'in_use', targetStatus: 'available', machineNumber: '', reason: '' });
          }
        }

        for (const o of ops) {
          allOps.push({ snCode: o.snCode, equipmentType: o.equipmentType, handType: o.handType,
            fromStatus: inUseBySn[o.snCode] ? 'in_use' : 'available', targetStatus: 'in_use',
            machineNumber, reason: '' });
        }
      } else {

        if (ops.length === 0) {
          for (const r of currentInUse) {
            let ts = 'available', rsn = reason || '';
            if (offlineType === 'damaged') { ts = 'damaged'; rsn = reason || '损坏'; }
            else if (offlineType === 'transfer') { ts = 'transferred'; rsn = reason || '未指定地点'; }
            allOps.push({ snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
              fromStatus: 'in_use', targetStatus: ts, machineNumber: '', reason: rsn });
          }
        } else {
          for (const o of ops) {
            allOps.push({ snCode: o.snCode, equipmentType: o.equipmentType, handType: o.handType,
              fromStatus: inUseBySn[o.snCode] ? 'in_use' : 'available',
              targetStatus: o.targetStatus || 'available', machineNumber: '', reason: o.reason || '' });
          }
        }
      }

      if (status === 'online' && ops.length > 0) {
        const sns = ops.map(o => o.snCode);
        const ph = sns.map(() => '?').join(',');
        const [snRows] = await conn.execute(
          `SELECT snCode, status, machineNumber FROM sn_registry WHERE snCode IN (${ph})`,
          sns
        );
        const snMap = Object.create(null);
        for (const r of snRows) snMap[r.snCode] = r;
        for (const o of ops) {
          if (!snMap[o.snCode]) throw new Error(`SN码 ${o.snCode} 不存在，无法上线`);
          const sn = snMap[o.snCode];
          if (sn.status === 'in_use' && sn.machineNumber && sn.machineNumber !== machineNumber) {
            throw new Error(`SN码 ${o.snCode} 已绑定到机器 ${sn.machineNumber}`);
          }

          if (sn.status === 'transferred' || sn.status === 'damaged') {
            throw new Error(`SN码 ${o.snCode} 当前状态为 ${sn.status}，无法投入使用`);
          }
        }
      }

      for (const op of allOps) {
        const damageReason = op.targetStatus === 'damaged' ? (op.reason || '') : '';
        const trackingNumber = op.targetStatus === 'transferred' ? (op.reason || '') : '';
        await conn.execute(
          "UPDATE sn_registry SET status=?, machineNumber=?, damageReason=?, trackingNumber=?, updatedAt=? WHERE snCode=?",
          [op.targetStatus, op.machineNumber || '', damageReason, trackingNumber, now, op.snCode]
        );
        const hid = `h-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)  }-${  op.snCode.slice(-6)}`;
        await conn.execute(
          "INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?,?,?,?,?,?,?,?)",
          [hid, op.snCode, op.fromStatus || 'available', op.targetStatus, authUser.username,
           status === 'online' ? `机器${machineNumber}上线` : `机器${machineNumber}下线`, machineNumber, now]
        );
      }

      await _syncInventoryFromSN(conn);

      for (const op of allOps) {
        const invType = _snToInvType(op.equipmentType, op.handType) || op.equipmentType;
        let txType, direction, note;
        if (op.targetStatus === 'in_use') {
          txType = 'machine_online'; direction = 'out'; note = `机器${machineNumber}上线自动扣减`;
        } else if (op.targetStatus === 'available') {
          txType = 'machine_offline'; direction = 'in'; note = `机器${machineNumber}下线自动归还`;
        } else if (op.targetStatus === 'damaged') {
          txType = 'damaged'; direction = 'out'; note = `机器${machineNumber}下线损坏: ${op.reason || '损坏'}`;
        } else if (op.targetStatus === 'transferred') {
          txType = 'transfer'; direction = 'out'; note = `机器${machineNumber}下线调出: ${op.reason || ''}`;
        } else continue;
        await _insertTransaction(conn, {
          type: txType, refId: machineNumber, equipmentType: op.equipmentType, handType: op.handType,
          invType, direction, quantity: 1, snCode: op.snCode, machineNumber,
          operator: authUser.username, note, timestamp: now
        });
      }

      let recordOnlineTime = status === 'online' ? now : null;
      const recordOfflineTime = status === 'offline' ? now : null;
      if (status === 'offline') {
        const [onlineRecs] = await conn.execute(
          "SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC LIMIT 5",
          [machineNumber]
        );
        for (const r of onlineRecs) {
          try {
            const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            if (d && d.status === 'online' && d.onlineTime) { recordOnlineTime = d.onlineTime; break; }
          } catch {}
        }
      }
      const offlineReason = status === 'offline'
        ? (reason || (offlineType === 'damaged' ? '损坏' : offlineType === 'transfer' ? '调出' : ''))
        : '';
      const machineId = `m-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
      await saveMachine(machineId, {
        id: machineId, machineNumber, deviceType, status,
        onlineTime: recordOnlineTime, offlineTime: recordOfflineTime,
        onlineReason: status === 'online' ? (reason || '') : '',
        offlineReason, updatedBy: authUser.username, updatedAt: now,
      }, conn);

      await conn.commit();
      broadcastChange('machines', ['sn_registry', 'inventory', 'transactions']);
      sendJSON(res, { success: true, machineNumber, status, machineId, opsApplied: allOps.length });
    } catch (e) {
      await conn.rollback();
      console.error('[SyncMachineState] failed:', e.message);
      sendJSON(res, { error: e.message }, 500);
    } finally {
      try { conn.release(); } catch {}
    }
  }

  const PRODUCTION_STATUSES = ['ready', 'in_production', 'waiting_repair', 'testing'];
  const PRODUCTION_STATUS_META = {
    ready: { label: '可生产' },
    in_production: { label: '在生产' },
    waiting_repair: { label: '待维修' },
    testing: { label: '在测试' },
  };

  async function loadProductionStatuses() {
    const [rows] = await pool.execute(
      'SELECT machineNumber,status,reason,source,ticketId,updatedBy,updatedByName,updatedAt FROM machine_production'
    );
    const map = {};
    for (const r of rows) {
      map[r.machineNumber] = {
        productionStatus: r.status || 'ready',
        productionStatusLabel: (PRODUCTION_STATUS_META[r.status] || PRODUCTION_STATUS_META.ready).label,
        productionReason: r.reason || '',
        productionSource: r.source || 'manual',
        productionTicketId: r.ticketId || '',
        productionUpdatedBy: r.updatedBy || '',
        productionUpdatedByName: r.updatedByName || '',
        productionUpdatedAt: r.updatedAt || null,
      };
    }
    return map;
  }

  async function setProductionStatus(opts = {}) {
    const machineNumber = (opts.machineNumber || '').toLowerCase().trim();
    const status = opts.status;
    if (!machineNumber || !PRODUCTION_STATUSES.includes(status)) {
      return { ok: false, error: 'invalid_args' };
    }
    try {
      const [rows] = await pool.execute(
        'SELECT status FROM machine_production WHERE machineNumber = ?',
        [machineNumber]
      );
      const prev = rows.length ? rows[0].status : null;
      if (prev === status) return { ok: true, changed: false, from: prev, to: status };

      const now = new Date().toISOString();
      const reason = (opts.reason || '').slice(0, 500);
      const source = opts.source === 'ticket' ? 'ticket' : 'manual';
      const opId = opts.operator?.id || (source === 'ticket' ? 'system' : '');
      const opName = opts.operator?.name || (source === 'ticket' ? '系统（工单联动）' : '');

      await pool.execute(
        `INSERT INTO machine_production (machineNumber,status,reason,source,ticketId,updatedBy,updatedByName,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE status=VALUES(status),reason=VALUES(reason),source=VALUES(source),
           ticketId=VALUES(ticketId),updatedBy=VALUES(updatedBy),updatedByName=VALUES(updatedByName),updatedAt=VALUES(updatedAt)`,
        [machineNumber, status, reason, source, opts.ticketId || '', opId, opName, now]
      );

      const histId = `mph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const hist = {
        id: histId, machineNumber, oldStatus: prev, newStatus: status,
        reason, source, ticketId: opts.ticketId || '',
        operator: opId, operatorName: opName, createdAt: now,
      };
      await pool.execute(
        'INSERT INTO machine_production_history (id,machineNumber,newStatus,data,createdAt) VALUES (?,?,?,?,?)',
        [histId, machineNumber, status, JSON.stringify(hist), now]
      );

      console.log(`[Production Status] ${machineNumber}: ${prev || '(无记录)'} -> ${status} (${source}${opts.ticketId ? ',ticket=' + opts.ticketId : ''})`);
      try { broadcastSSE('machines_updated', { machineNumber, productionStatus: status }); } catch {}
      return { ok: true, changed: true, from: prev, to: status };
    } catch (e) {
      console.error('[Production Status] setProductionStatus error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async function handleSetProductionStatus(req, res, user, body) {
    try {
      const b = body || {};
      const machineNumber = (b.machineNumber || '').trim().toLowerCase();
      const status = b.status;
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!['ready', 'in_production', 'testing'].includes(status)) {
        return sendJSON(res, { error: '目标状态无效（待维修状态由维修工单自动驱动）' }, 400);
      }
      const [rows] = await pool.execute(
        'SELECT status FROM machine_production WHERE machineNumber = ?', [machineNumber]
      );
      const prev = rows.length ? rows[0].status : null;
      if (prev === 'waiting_repair' && status === 'in_production') {
        return sendJSON(res, { error: '该机器待维修，不能标记为在生产；请先完成维修工单' }, 409);
      }
      const reason = (b.reason || '').trim().slice(0, 500);
      const result = await setProductionStatus({
        machineNumber, status, reason, source: 'manual',
        operator: { id: user?.userId || user?.id || '', name: user?.displayName || user?.username || '' },
      });
      if (!result.ok) return sendJSON(res, { error: result.error || '更新失败' }, 500);
      sendJSON(res, { success: true, changed: result.changed, from: result.from, to: result.to });
    } catch (e) {
      console.error('[Production Status] manual set error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  async function handleGetProductionHistory(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const machineNumber = (url.searchParams.get('machineNumber') || '').trim().toLowerCase();
      let limit = parseInt(url.searchParams.get('limit') || '200', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 200;
      limit = Math.min(limit, 500);
      let rows;
      if (machineNumber) {
        [rows] = await pool.execute(
          'SELECT data FROM machine_production_history WHERE machineNumber = ? ORDER BY createdAt DESC, id DESC LIMIT ' + limit,
          [machineNumber]
        );
      } else {
        [rows] = await pool.execute(
          'SELECT data FROM machine_production_history ORDER BY createdAt DESC, id DESC LIMIT ' + limit
        );
      }
      const items = rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
      sendJSON(res, { success: true, items });
    } catch (e) {
      console.error('[Production Status] history error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  function collectorIpOf(machineNumber) {
    const m = /^(?:we|szx3)-(\d+)$/.exec(machineNumber || '');
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 254 ? `10.5.51.${n}` : null;
  }

  async function _fetchCollectorJSON(url, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function handleStopCollector(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      let hostOnline = false;
      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          const ep = presence && presence[machineNumber];
          hostOnline = !!(ep && ep.hostOnline);
        } catch { }
      }
      if (!hostOnline) return sendJSON(res, { error: '该机器未部署心跳代理或代理离线' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/stop-collector`, {
        method: 'POST',
        signal: AbortSignal.timeout(35000),
        headers: { 'x-edge-token': token, Accept: 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        return sendJSON(res, { error: body.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, container: body.container, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleStopExodus(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      let hostOnline = false;
      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          const ep = presence && presence[machineNumber];
          hostOnline = !!(ep && ep.hostOnline);
        } catch { }
      }
      if (!hostOnline) return sendJSON(res, { error: '该机器未部署心跳代理或代理离线' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/stop-exodus`, {
        method: 'POST',
        signal: AbortSignal.timeout(35000),
        headers: { 'x-edge-token': token, Accept: 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        return sendJSON(res, { error: body.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, container: body.container, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleFixQuest(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      let hostOnline = false;
      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          const ep = presence && presence[machineNumber];
          hostOnline = !!(ep && ep.hostOnline);
        } catch { }
      }
      if (!hostOnline) return sendJSON(res, { error: '该机器未部署心跳代理或代理离线' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/fix-quest`, {
        method: 'POST',
        signal: AbortSignal.timeout(150000),
        headers: { 'x-edge-token': token, Accept: 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        return sendJSON(res, { error: body.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, pid: body.pid || null, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleDiagnoseHands(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      let hostOnline = false;
      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          const ep = presence && presence[machineNumber];
          hostOnline = !!(ep && ep.hostOnline);
        } catch { }
      }
      if (!hostOnline) return sendJSON(res, { error: '该机器未部署心跳代理或代理离线' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/diagnose-hands`, {
        method: 'POST',
        signal: AbortSignal.timeout(175000),
        headers: { 'x-edge-token': token, Accept: 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        return sendJSON(res, { error: body.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      sendJSON(res, { success: true, hands: body.hands || [], machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  // 灵巧手检测进度（agent 侧实时状态，前端轮询用）
  async function handleDiagnoseProgress(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/diagnose-progress`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
        headers: { 'x-edge-token': token, Accept: 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        return sendJSON(res, { error: body.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      sendJSON(res, { success: true, progress: body.progress || null, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleMachineConfig(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/machine-config`, {
        headers: { 'x-edge-token': token, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        return sendJSON(res, { error: body.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      sendJSON(res, { success: true, config: body.config, raw: body.raw });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  // ==================== 通用命令按钮注册表 ====================
  // 前端"维护操作"面板的命令按钮即由本表生成；新增按钮只需在此加一行
  // cmd 必须能被 gms-heartbeat-agent 的 /exec 白名单匹配
  const MACHINE_COMMANDS = [
    { key: 'container-ps', label: '查看容器状态', cmd: 'docker ps -a', danger: false, timeout: 10000, showOutput: true },
  ];

  async function handleMachineCommands(req, res, user, machineNumber) {
    if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
    if (!user || !['admin', 'superadmin'].includes(user.role)) {
      return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
    }
    sendJSON(res, {
      success: true,
      commands: MACHINE_COMMANDS.map(({ key, label, danger, showOutput }) => ({ key, label, danger, showOutput })),
    });
  }

  async function handleMachineCommand(req, res, user, machineNumber, body) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const key = body && body.key;
      const cmdDef = MACHINE_COMMANDS.find((c) => c.key === key);
      if (!cmdDef) return sendJSON(res, { error: '未知命令: ' + key }, 400);
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      let hostOnline = false;
      if (typeof loadEdgePresence === 'function') {
        try {
          const presence = await loadEdgePresence();
          const ep = presence && presence[machineNumber];
          hostOnline = !!(ep && ep.hostOnline);
        } catch { }
      }
      if (!hostOnline) return sendJSON(res, { error: '该机器未部署心跳代理或代理离线' }, 400);
      const token = process.env.EDGE_TOKEN || '';
      if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
      const r = await fetch(`http://${ip}:3000/exec`, {
        method: 'POST',
        signal: AbortSignal.timeout(cmdDef.timeout + 5000),
        headers: { 'x-edge-token': token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: cmdDef.cmd, timeout: cmdDef.timeout }),
      });
      const body2 = await r.json().catch(() => ({}));
      if (!r.ok || body2.ok === false) {
        return sendJSON(res, { error: body2.error || `agent 返回 HTTP ${r.status}` }, 502);
      }
      if (cmdDef.showOutput) {
        return sendJSON(res, { success: true, output: body2.stdout || '', cmd: cmdDef.cmd, machineNumber });
      }
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接采集器主机上的心跳代理'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  /*
   * 机械臂状态切换功能暂未启用（SDK 硬编码绑定 UDP 4730，与 mono 采集器占用冲突），先注释掉
   */
  // async function handleArmControl(req, res, user, machineNumber, body) {
  //   try {
  //     if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
  //     if (!user || !['admin', 'superadmin'].includes(user.role)) {
  //       return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  //     }
  //     body = body || {};
  //     const action = body.action;
  //     const arm = (body.arm || 'A').toUpperCase();
  //     const state = body.state !== undefined ? parseInt(body.state, 10) : undefined;
  //     if (!action) return sendJSON(res, { error: '缺少 action 参数' }, 400);
  //     if (!['A','B','AB'].includes(arm)) return sendJSON(res, { error: 'arm 必须为 A、B 或 AB' }, 400);
  //     if (action === 'set_state' && (isNaN(state) || state < 0 || state > 4)) {
  //       return sendJSON(res, { error: 'state 必须为 0-4: 0=下伺服 1=位置跟随 2=PVT 3=扭矩 4=协作释放' }, 400);
  //     }
  //     const ip = collectorIpOf(machineNumber);
  //     if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
  //     let hostOnline = false;
  //     if (typeof loadEdgePresence === 'function') {
  //       try {
  //         const presence = await loadEdgePresence();
  //         const ep = presence && presence[machineNumber];
  //         hostOnline = !!(ep && ep.hostOnline);
  //       } catch { }
  //     }
  //     if (!hostOnline) return sendJSON(res, { error: '该机器未部署心跳代理或代理离线' }, 400);
  //     const token = process.env.EDGE_TOKEN || '';
  //     if (!token) return sendJSON(res, { error: '服务端未配置 EDGE_TOKEN' }, 500);
  //     const r = await fetch(`http://${ip}:3000/arm-control`, {
  //       method: 'POST',
  //       signal: AbortSignal.timeout(35000),
  //       headers: { 'x-edge-token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
  //       body: JSON.stringify({ action, arm, state: isNaN(state) ? undefined : state }),
  //     });
  //     const result = await r.json().catch(() => ({}));
  //     if (!r.ok || result.ok === false) {
  //       return sendJSON(res, { error: result.error || `agent 返回 HTTP ${r.status}` }, 502);
  //     }
  //     sendJSON(res, { success: true, ...result, machineNumber });
  //   } catch (e) {
  //     const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
  //     const msg = refused || e.name === 'TimeoutError'
  //       ? '无法连接采集器主机上的心跳代理'
  //       : (e.message || '操作失败');
  //     sendJSON(res, { error: msg }, 502);
  //   }
  // }

  function _stateTopicMap(state) {
    const items = (state && state.robots && state.robots.robot_1) || [];
    const map = {};
    for (const it of items) if (it && it.topic) map[it.topic] = it.data;
    return map;
  }

  function _groupComponents(components, healthComponents) {
    const out = {
      dexterousHands: { left: null, right: null },
      gloves: { left: null, right: null },
      quest: null, marvin: null, cameras: [], other: [],
    };
    const ages = healthComponents || {};
    for (const [key, val] of Object.entries(components || {})) {
      const ageRaw = ages[key] && ages[key].age_s;
      const entry = {
        key,
        status: (val && val.status) || 'unknown',
        ageS: typeof ageRaw === 'number' ? Math.round(ageRaw * 10) / 10 : null,
        everSeen: ages[key] ? !!ages[key].ever_seen : null,
      };
      if (key === 'robot/wuji_hand_l') out.dexterousHands.left = entry;
      else if (key === 'robot/wuji_hand_r') out.dexterousHands.right = entry;
      else if (key === 'robot/wuji_glove_l' || key === 'gello/wuji_glove_l') out.gloves.left = entry;
      else if (key === 'robot/wuji_glove_r' || key === 'gello/wuji_glove_r') out.gloves.right = entry;
      else if (key === 'gello/quest_controller' || key === 'quest/overlay') out.quest = entry;
      else if (key === 'robot/marvin') out.marvin = entry;
      else if (key.startsWith('camera/')) out.cameras.push({ name: key.slice('camera/'.length), ...entry });
      else out.other.push(entry);
    }
    out.cameras.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // 心跳代理会把 Wuji SDK 的详细诊断放在 wuji，同时把兼容摘要放在
  // devices.devicesNet。这里统一补齐 devicesNet，保证“机器状态”所有
  // 读取路径（数据库快照、实时 SSE、直连抓取）都能看到同一套字段。
  function _mergeWujiDevices(devicesNet, wuji) {
    const source = devicesNet || {};
    const out = {
      gloves: { ...(source.gloves || {}) },
      dexterousHands: { ...(source.dexterousHands || {}) },
      roboticArm: source.roboticArm || null,
    };
    const copySide = (kind, side) => {
      const sdk = wuji && wuji[kind] && wuji[kind][side];
      if (!sdk || typeof sdk !== 'object') return;
      const current = out[kind][side] && typeof out[kind][side] === 'object'
        ? out[kind][side] : {};
      out[kind][side] = {
        ...current,
        ...sdk,
        snCode: sdk.sn || current.snCode || null,
        ip: sdk.ip || current.ip || null,
      };
    };
    copySide('gloves', 'left');
    copySide('gloves', 'right');
    copySide('dexterousHands', 'left');
    copySide('dexterousHands', 'right');
    const hasAny = Object.keys(out.gloves).length
      || Object.keys(out.dexterousHands).length
      || !!out.roboticArm;
    return hasAny ? out : null;
  }

  function _edgeInfoFromPresence(ep) {
    if (!ep) return null;
    return {
      machineType: ep.machineType || null,
      devicesNet: _mergeWujiDevices(ep.edgeDevices || null, ep.edgeWuji || null),
      questInfo: ep.edgeQuest ? {
        netConnected: !!ep.edgeQuest.connected,
        serialNumber: ep.edgeQuest.serialNumber || null,
        adbStatus: ep.edgeQuest.adbStatus || null,
        batteryLevel: ep.edgeQuest.battery && ep.edgeQuest.battery.level != null ? ep.edgeQuest.battery.level : null,
        batteryStatus: ep.edgeQuest.battery && ep.edgeQuest.battery.status ? ep.edgeQuest.battery.status : null,
        batteryTemp: ep.edgeQuest.battery && ep.edgeQuest.battery.temperature != null ? ep.edgeQuest.battery.temperature : null,
        controllers: ep.edgeQuest.controllers || null,
      } : null,
      cameraFps: ep.edgeCameraFps || null,
      cameras: ep.edgeCameras || [],
      encoderFps: ep.edgeEncoderFps || null,
      wuji: ep.edgeWuji || null,
      handStream: ep.edgeHandStream || null,
    };
  }

  function _composeLiveInfo(machineNumber, settled, edge) {
    const [coreR, healthR, versionR, stateR, sensorsR] = settled;
    const core = coreR.status === 'fulfilled' ? coreR.value : null;
    const hermesHealth = healthR.status === 'fulfilled' ? healthR.value : null;
    const hermesVersion = versionR.status === 'fulfilled' && versionR.value && versionR.value.content
      ? versionR.value.content.version : null;
    const stateMap = stateR.status === 'fulfilled' ? _stateTopicMap(stateR.value) : {};

    const ciInfo = (core && core.collector_info && core.collector_info.info) || {};
    const devices = _groupComponents(ciInfo.components || (hermesHealth && hermesHealth.components) || {}, hermesHealth && hermesHealth.components);

    const dnet = _mergeWujiDevices(edge && edge.devicesNet, edge && edge.wuji);
    if (dnet) {
      const probe = (obj, hand) => (obj && hand && obj[hand] && typeof obj[hand].connected === 'boolean')
        ? !!obj[hand].connected : null;
      if (devices.dexterousHands && devices.dexterousHands.left) devices.dexterousHands.left.probeConnected = probe(dnet.dexterousHands, 'left');
      if (devices.dexterousHands && devices.dexterousHands.right) devices.dexterousHands.right.probeConnected = probe(dnet.dexterousHands, 'right');
      if (devices.gloves && devices.gloves.left) devices.gloves.left.probeConnected = probe(dnet.gloves, 'left');
      if (devices.gloves && devices.gloves.right) devices.gloves.right.probeConnected = probe(dnet.gloves, 'right');
      if (devices.marvin && dnet.roboticArm && typeof dnet.roboticArm.connected === 'boolean') {
        devices.marvin.probeConnected = !!dnet.roboticArm.connected;
      }
    }
    if (edge && edge.machineType === 'glove_only') {
      devices.dexterousHands = { left: null, right: null };
      devices.marvin = null;
    }

    const tc = core && core.task_config && core.task_config.id ? core.task_config : null;
    const tpl = (tc && tc.template) || {};
    const op = (tc && tc.operator) || {};
    const task = tc ? {
      id: tc.id,
      name: tpl.ref_name || tpl.name || '未知任务',
      state: tc.state || null,
      hours: tc.hours != null ? tc.hours : null,
      hoursCompleted: tc.hours_completed != null ? tc.hours_completed : 0,
      percent: tc.hours ? Math.min(100, Math.round(((tc.hours_completed || 0) / tc.hours) * 100)) : null,
      createTime: tc.create_time || null,
      endTime: tc.end_time || null,
      isTraining: !!tpl.is_training,
      operator: {
        name: op.name || op.localized_name || '未知',
        level: op.level != null ? op.level : null,
        email: op.email || null,
        state: op.state || null,
      },
      steps: (tpl.steps && tpl.steps.payload) || [],
      verbs: tpl.verbs || [],
      objects: tpl.objects || [],
    } : null;

    const misc = (core && core.machine_config && core.machine_config.misc) || {};
    const containers = Object.entries((core && core.containers) || {}).map(([name, status]) => ({ name, status }));

    const _refused = r => {
      if (r.status !== 'rejected') return false;
      const cause = r.reason && r.reason.cause;
      return !!(cause && (cause.code === 'ECONNREFUSED' || cause.code === 'ECONNRESET'));
    };
    const hermesAllDown = !hermesHealth && !hermesVersion && !Object.keys(stateMap).length;
    const hermesOffline = hermesAllDown && _refused(healthR) && _refused(versionR) && _refused(stateR);

    return {
      success: true,
      machineNumber,
      source: 'live',
      dataAgeSec: 0,
      collectorName: misc.machine_id || null,
      computerId: misc.computer_id || null,
      importerVersion: (core && core.version) || null,
      collectorVersion: hermesVersion,
      channel: (core && core.channel) || null,
      vstFps: (core && core.machine_config && core.machine_config.vst && core.machine_config.vst.fps) != null
        ? core.machine_config.vst.fps : null,
      sensors: sensorsR.status === 'fulfilled' && Array.isArray(sensorsR.value) ? sensorsR.value : null,
      teleopDelay: {
        left: stateMap['teleop/hand_left/delay'] != null ? stateMap['teleop/hand_left/delay'] : null,
        right: stateMap['teleop/hand_right/delay'] != null ? stateMap['teleop/hand_right/delay'] : null,
      },
      questInfo: (edge && edge.questInfo) || null,
      devicesNet: dnet,
      cameraFps: (edge && edge.cameraFps) || null,
      camerasFps: (edge && edge.cameraFps && Array.isArray(edge.cameraFps.cameras))
        ? edge.cameraFps.cameras
        : ((edge && Array.isArray(edge.cameras)) ? edge.cameras : []),
      cameras: (edge && Array.isArray(edge.cameras)) ? edge.cameras : [],
      encoderFps: (edge && edge.encoderFps) || null,
      wuji: (edge && edge.wuji) || null,
      handStream: (edge && edge.handStream) || null,
      system: {
        activity: (core && core.activity) || null,
        collectorAlive: !!(core && core.is_collector_alive),
        observerAlive: !!(core && core.is_observer_alive),
        loggedIn: !!(core && core.is_logged_in),
        idleTimeSecs: (core && core.idle_time_secs) != null ? core.idle_time_secs : null,
        controlState: stateMap.control_state || ciInfo.status || null,
        isRecording: !!stateMap.is_recording,
        emergencyStopped: !!stateMap.is_emergency_stopped,
        errorCount: stateMap.error_count != null ? stateMap.error_count : (ciInfo.errors ? ciInfo.errors.length : 0),
      },
      containers,
      devices,
      task,
      degraded: ciInfo.degraded || (hermesHealth && hermesHealth.degraded) || [],
      errors: ciInfo.errors || (hermesHealth && hermesHealth.errors) || [],

      partial: {
        importer: !core,
        hermesOffline,
        hermesFailed: hermesAllDown && !hermesOffline,
      },
    };
  }

  async function handleGetMachineInfo(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器（仅 we-1xx / szx3-* 灵巧手机器提供）' }, 400);

      const url = new URL(req.url, 'http://x');
      const forceLive = url.searchParams.get('refresh') === '1';

      let edgePresence = null;
      try {
        const presence = await loadEdgePresence();
        edgePresence = presence && presence[machineNumber] ? presence[machineNumber] : null;
      } catch { }

      let snap = null;
      if (!forceLive && edgePresence && edgePresence.hostLastSeen
        && Date.now() - new Date(edgePresence.hostLastSeen).getTime() < 90 * 1000
        && (edgePresence.hostOnline || edgePresence.importer || edgePresence.hermes
          || edgePresence.edgeDevices || edgePresence.edgeWuji
          || edgePresence.edgeCameraFps || edgePresence.edgeCameras?.length)) {
        snap = edgePresence;
      }

      if (snap) {
        const imp = snap.importer || {};
        const her = snap.hermes || {};
        const comps = (her.health && her.health.components) || {};

        const entry = c => ({
          kind: c.kind || null,
          status: c.status || 'disconnected',
          age_s: c.ageS != null ? c.ageS : null,
          ever_seen: c.everSeen != null ? c.everSeen : null,
        });
        const devices = { dexterousHands: {}, gloves: {}, quest: null, marvin: null, cameras: [], other: [] };
        for (const [key, c] of Object.entries(comps)) {
          if (key === 'robot/wuji_hand_l') devices.dexterousHands.left = entry(c);
          else if (key === 'robot/wuji_hand_r') devices.dexterousHands.right = entry(c);
          else if (key === 'robot/wuji_glove_l') devices.gloves.left = entry(c);
          else if (key === 'robot/wuji_glove_r') devices.gloves.right = entry(c);
          else if (key === 'quest/overlay') devices.quest = entry(c);
          else if (key === 'robot/marvin') devices.marvin = entry(c);
          else if (key.startsWith('camera/')) devices.cameras.push({ name: key.slice('camera/'.length), ...entry(c) });
          else devices.other.push({ key, ...entry(c) });
        }
        devices.cameras.sort((a, b) => a.name.localeCompare(b.name));

        const dnet0 = _mergeWujiDevices(snap.edgeDevices || null, snap.edgeWuji || null);
        if (dnet0) {
          const probe = (obj, hand) => (obj && hand && obj[hand] && typeof obj[hand].connected === 'boolean')
            ? !!obj[hand].connected : null;
          if (devices.dexterousHands.left) devices.dexterousHands.left.probeConnected = probe(dnet0.dexterousHands, 'left');
          if (devices.dexterousHands.right) devices.dexterousHands.right.probeConnected = probe(dnet0.dexterousHands, 'right');
          if (devices.gloves.left) devices.gloves.left.probeConnected = probe(dnet0.gloves, 'left');
          if (devices.gloves.right) devices.gloves.right.probeConnected = probe(dnet0.gloves, 'right');
          if (devices.marvin && dnet0.roboticArm && typeof dnet0.roboticArm.connected === 'boolean') {
            devices.marvin.probeConnected = !!dnet0.roboticArm.connected;
          }
        }
        if (snap.machineType === 'glove_only') {
          devices.dexterousHands = { left: null, right: null };
          devices.marvin = null;
        }

        const it = imp.task || null;
        const task = it ? {
          id: it.id,
          name: (it.template && (it.template.refName || it.template.name)) || '未知任务',
          state: it.state || null,
          hours: it.hours != null ? it.hours : null,
          hoursCompleted: it.hoursCompleted != null ? it.hoursCompleted : 0,
          percent: it.hours ? Math.min(100, Math.round(((it.hoursCompleted || 0) / it.hours) * 100)) : null,
          createTime: it.createTime || null,
          endTime: it.endTime || null,
          isTraining: !!(it.template && it.template.isTraining),
          operator: {
            name: (it.operator && (it.operator.name || it.operator.localized_name)) || '未知',
            level: it.operator ? it.operator.level : null,
            email: null,
            state: it.operator ? it.operator.state : null,
          },
          steps: [], verbs: [], objects: [],
        } : null;

        const herDown = her.reachable === false;

        const q = snap.edgeQuest || null;
        const dnet = _mergeWujiDevices(snap.edgeDevices || null, snap.edgeWuji || null);
        const sensors = Array.isArray(her.sensors) ? her.sensors : null;
        sendJSON(res, {
          success: true,
          machineNumber,
          source: 'agent',
          dataAgeSec: Math.max(0, Math.round((Date.now() - new Date(snap.hostLastSeen).getTime()) / 1000)),
          collectorName: imp.machineId || null,
          computerId: imp.computerId || null,
          importerVersion: imp.importerVersion || null,
          collectorVersion: her.version || null,
          channel: imp.channel || null,
          vstFps: imp.vst && imp.vst.fps != null ? imp.vst.fps : null,
          cameraFps: snap.edgeCameraFps || null,
          camerasFps: snap.edgeCameraFps && Array.isArray(snap.edgeCameraFps.cameras)
            ? snap.edgeCameraFps.cameras
            : (snap.edgeCameras || []),
          cameras: snap.edgeCameras || [],
          encoderFps: snap.edgeEncoderFps || null,
          wuji: snap.edgeWuji || null,
          handStream: snap.edgeHandStream || null,
          sensors,
          teleopDelay: (her.state && her.state.teleopDelay) || null,
          questInfo: q ? {
            netConnected: !!q.connected,
            serialNumber: q.serialNumber || null,
            adbStatus: q.adbStatus || null,
            batteryLevel: q.battery && q.battery.level != null ? q.battery.level : null,
            batteryStatus: q.battery && q.battery.status ? q.battery.status : null,
            batteryTemp: q.battery && q.battery.temperature != null ? q.battery.temperature : null,
            controllers: q.controllers || null,
          } : null,
          devicesNet: dnet,
          system: {
            activity: imp.activity || null,
            collectorAlive: imp.collectorAlive != null ? !!imp.collectorAlive : (her.reachable !== false),
            observerAlive: !!imp.observerAlive,
            loggedIn: !!imp.loggedIn,
            idleTimeSecs: imp.idleTimeSecs != null ? imp.idleTimeSecs : null,

            stateStale: herDown || !her.state || !her.state.timestampPosix
              || (Date.now() / 1000 - her.state.timestampPosix > 180),
            controlState: (!herDown && her.state && her.state.timestampPosix
              && (Date.now() / 1000 - her.state.timestampPosix <= 180))
              ? (her.state.controlState || null) : null,
            isRecording: (!herDown && her.state && her.state.timestampPosix
              && (Date.now() / 1000 - her.state.timestampPosix <= 180))
              ? !!her.state.isRecording : false,
            lastControlState: (her.state && her.state.controlState) || null,
            lastIsRecording: !!(her.state && her.state.isRecording),
            lastStateAgeSec: her.state && her.state.timestampPosix
              ? Math.max(0, Math.round(Date.now() / 1000 - her.state.timestampPosix)) : null,
            emergencyStopped: !!(her.state && her.state.emergencyStopped),
            errorCount: her.state && her.state.errorCount != null ? her.state.errorCount
              : (her.health ? (her.health.errors || []).length : 0),
          },
          containers: [
            { name: 'importer', status: imp.reachable === false ? 'exited' : 'running' },
            { name: '采集程序(rdc-exodus)', status: herDown ? 'exited' : 'running' },
          ],
          devices,
          task,
          degraded: (her.health && her.health.degraded) || [],
          errors: (her.health && her.health.errors) || [],
          partial: {
            importer: imp.reachable === false,
            hermesOffline: herDown,
            hermesFailed: false,
          },
        });
        return;
      }

      const base = `http://${ip}`;
      const settled = await Promise.allSettled([
        _fetchCollectorJSON(`${base}:5025/api/core/health`, 6000),
        _fetchCollectorJSON(`${base}:5006/health`, 4000),
        _fetchCollectorJSON(`${base}:5006/version`, 4000),
        _fetchCollectorJSON(`${base}:5006/state`, 4000),
        _fetchCollectorJSON(`${base}:5006/sensors`, 4000),
      ]);
      // 即使本次选择直连采集器（refresh=1 或心跳暂时不可用），只要
      // edge_hosts 里还有新鲜的代理快照，也一并带回机器状态，避免
      // “实时刷新”时 FPS/Wuji 状态突然消失。
      sendJSON(res, _composeLiveInfo(
        machineNumber,
        settled,
        edgePresence && edgePresence.hostLastSeen
          && Date.now() - new Date(edgePresence.hostLastSeen).getTime() < 90 * 1000
          ? _edgeInfoFromPresence(edgePresence) : null,
      ));
    } catch (e) {
      console.error('[Machine Info] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  async function handleGetMachineLive(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('event: connected\ndata: {"status":"ok"}\n\n');

      let closed = false;
      let fastBusy = false;
      let slowBusy = false;
      let coreR = null, versionR = null, stateR = null, sensorsR = null;
      let edge = null;

      const loadEdge = async () => {
        try {
          const presence = await loadEdgePresence();
          const ep = presence && presence[machineNumber];
          if (!ep) return;
          edge = _edgeInfoFromPresence(ep);
        } catch { }
      };

      const fetchSlow = async () => {
        if (slowBusy) return;
        slowBusy = true;
        try {
          const [c, v, s, sn] = await Promise.allSettled([
            _fetchCollectorJSON(`http://${ip}:5025/api/core/health`, 6000),
            _fetchCollectorJSON(`http://${ip}:5006/version`, 4000),
            _fetchCollectorJSON(`http://${ip}:5006/state`, 4000),
            _fetchCollectorJSON(`http://${ip}:5006/sensors`, 4000),
          ]);
          coreR = c; versionR = v; stateR = s; sensorsR = sn;
        } catch { }
        slowBusy = false;
      };

      const tick = async () => {
        if (closed || fastBusy) return;
        fastBusy = true;
        try {
          let healthR, coreRUse = coreR, edgeUse = edge;
          const live = getEdgeLive ? getEdgeLive(machineNumber) : null;
          if (live && live.core && live.hermesHealth && Date.now() - live.ts < 8000) {
            healthR = { status: 'fulfilled', value: live.hermesHealth };
            coreRUse = { status: 'fulfilled', value: live.core };
            edgeUse = {
              devicesNet: _mergeWujiDevices(live.devices || null, live.wuji || null)
                || ((edge && edge.devicesNet) || null),
              questInfo: live.quest ? {
                netConnected: !!live.quest.connected,
                serialNumber: live.quest.serialNumber || null,
                adbStatus: live.quest.adbStatus || null,
                batteryLevel: typeof live.quest.battery === 'object' && live.quest.battery
                  ? (live.quest.battery.level != null ? live.quest.battery.level : null)
                  : (typeof live.quest.battery === 'number' ? live.quest.battery : null),
                batteryStatus: typeof live.quest.battery === 'object' && live.quest.battery ? (live.quest.battery.status || null) : null,
                controllers: live.quest.controllers || null,
              } : ((edge && edge.questInfo) || null),
              cameraFps: live.cameraFps || (edge && edge.cameraFps) || null,
              camerasFps: live.cameraFps && Array.isArray(live.cameraFps.cameras)
                ? live.cameraFps.cameras
                : ((live.cameras && Array.isArray(live.cameras)) ? live.cameras : ((edge && edge.cameras) || [])),
              cameras: live.cameras && Array.isArray(live.cameras)
                ? live.cameras
                : ((edge && edge.cameras) || []),
              encoderFps: live.encoderFps || (edge && edge.encoderFps) || null,
              wuji: live.wuji || (edge && edge.wuji) || null,
              handStream: live.handStream || (edge && edge.handStream) || null,
            };
          } else {
            healthR = (await Promise.allSettled([
              _fetchCollectorJSON(`http://${ip}:5006/health`, 3000),
            ]))[0];
          }
          const body = _composeLiveInfo(machineNumber, [coreRUse, healthR, versionR, stateR, sensorsR], edgeUse);
          if (!closed) res.write(`data: ${JSON.stringify(body)}\n\n`);
        } catch { }
        fastBusy = false;
      };

      const kill = () => {
        if (closed) return;
        closed = true;
        clearInterval(slowTimer);
        clearInterval(fastTimer);
        clearTimeout(maxTimer);
        try { res.end(); } catch { }
      };
      req.on('close', kill);

      const slowTimer = setInterval(() => { loadEdge(); fetchSlow(); }, 10000);
      const fastTimer = setInterval(() => { tick(); }, 2000);
      const maxTimer = setTimeout(kill, 30 * 60 * 1000);

      await loadEdge();
      await fetchSlow();
      if (!closed) await tick();
    } catch (e) {
      console.error('[Machine Live] Error:', e);
      try { res.end(); } catch { }
    }
  }

  return {
    handleGetMachineCode,
    handleMobileGetMachines,
    handleGetMachineStatus,
    handleGetMachineInfo,
    handleGetMachineLive,
    handleStopCollector,
    handleStopExodus,
    handleFixQuest,
    handleDiagnoseHands,
    handleDiagnoseProgress,
    handleMachineConfig,
    handleMachineCommands,
    handleMachineCommand,
    // handleArmControl,  // 机械臂状态切换暂未启用
    handleGetMachines,
    handleAddMachine,
    handleDeleteMachine,
    handleBindMachine,
    handleUnbindMachine,
    handleGetMachineBindings,
    handleSyncMachineState,
    handleSetProductionStatus,
    handleGetProductionHistory,
    setProductionStatus,
  };
};
