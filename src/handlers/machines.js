'use strict';

const os = require('os');
const { getEdgeLive } = require('../edge-live');

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
  } = deps;

  async function loadAgentPresence() {
    const [rows] = await pool.execute(
      "SELECT machineNumber, status, lastSeen, data, agentVersion FROM edge_hosts WHERE agentVersion IS NOT NULL AND agentVersion <> ''",
    );
    const result = {};
    for (const row of rows) {
      let data = {};
      try { data = JSON.parse(row.data || '{}'); } catch { }
      result[row.machineNumber] = {
        ...data,
        edgeContainers: data.edgeContainers || data.containers || [],
        hostOnline: row.status === 'online',
        hostLastSeen: row.lastSeen || data.hostLastSeen || null,
        statusSource: 'agent',
      };
    }
    return result;
  }

  function compactPresenceForMachineList(presence) {
    const importer = presence.importer || {};
    const hermes = presence.hermes || {};
    return {
      hostOnline: presence.hostOnline,
      hostLastSeen: presence.hostLastSeen,
      statusSource: presence.statusSource,
      machineType: presence.machineType || null,
      edgeAlerts: Array.isArray(presence.alerts) ? presence.alerts : [],
      importer: {
        reachable: importer.reachable,
        machineId: importer.machineId || null,
        computerId: importer.computerId || null,
        workflow: importer.workflow || null,
        collectorType: importer.collectorType || null,
        importerVersion: importer.importerVersion || null,
        activity: importer.activity || null,
        collectorAlive: importer.collectorAlive,
        loggedIn: importer.loggedIn,
        idleTimeSecs: importer.idleTimeSecs,
        task: importer.task || null,
        workers: Array.isArray(importer.workers) ? importer.workers : [],
        queue: importer.queue || null,
      },
      hermes: {
        reachable: hermes.reachable,
        health: hermes.health || null,
        state: hermes.state || null,
      },
    };
  }

  async function handleListAgentHosts(req, res) {
    try {
      const presence = await loadAgentPresence();
      sendJSON(res, { success: true, hosts: Object.entries(presence).map(([machineNumber, data]) => ({ machineNumber, ...data })) });
    } catch (e) {
      sendJSON(res, { error: e.message || '读取 Agent 快照失败' }, 500);
    }
  }

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

      let result = machines.map(m => {
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

      {
        try {
          const presence = await loadAgentPresence();
          if (Object.keys(presence).length) {
            for (const m of result) {
              if (presence[m.machineNumber]) {
                Object.assign(m, presence[m.machineNumber]);
                if (m.hostOnline === true && !['waiting_repair', 'repairing'].includes(m.status)) {
                  m.status = 'online';
                  m.onlineReason = 'Agent 实时采集在线';
                }
              }
            }
          }
        } catch (e) {
          console.error('[Mobile Machines] Agent 快照合并失败:', e.message);
        }
      }

      result = result.map(_applyMachineTypeOverride).map(m => {
        if (m.machineType === 'dexterous') return { ...m, deviceType: 'dexterous' };
        if (m.machineType === 'glove_only') return { ...m, deviceType: 'glove' };
        return m;
      });

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
      {
    try {
      const presence = await loadAgentPresence();
        if (Object.keys(presence).length) {
          result = records.map(machine => presence[machine.machineNumber]
            ? {
              ...machine,
              ...compactPresenceForMachineList(presence[machine.machineNumber]),
              ...((presence[machine.machineNumber].hostOnline === true
                && !['waiting_repair', 'repairing'].includes(machine.status))
                ? { status: 'online', onlineReason: 'Agent 实时采集在线' } : {}),
            }
            : machine);
      }
    } catch (e) {
      console.error('[Machines] Agent 快照合并失败:', e.message);
    }

    result = result.map(_applyMachineTypeOverride).map(machine => machine.machineType === 'dexterous'
      ? { ...machine, deviceType: 'dexterous' }
      : machine.machineType === 'glove_only'
        ? { ...machine, deviceType: 'glove' }
        : machine);
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

  const STATUS_LABELS = {
    offline: '离线',
    recording: '录制中',
    online_idle: '在线空闲',
    error: '异常',
    unknown: '未知',
    ready: '可生产',
    in_production: '在生产',
    waiting_repair: '待维修',
    testing: '在测试',
  };

  // 将状态按连续时间区间持久化。相同状态只更新开放区间，状态变化才关闭并新建区间。
  async function recordStatusInterval(machineNumber, statusType, status, details = null, at = new Date().toISOString()) {
    machineNumber = String(machineNumber || '').trim().toLowerCase();
    statusType = String(statusType || '').trim().toLowerCase();
    status = String(status || 'unknown').trim();
    if (!machineNumber || !statusType || !status) return { ok: false, error: 'invalid_args' };
    const nowMs = Date.parse(at) || Date.now();
    let conn;
    const lockName = `gms:machine-status:${machineNumber}:${statusType}`;
    let lockAcquired = false;
    try {
      conn = await pool.getConnection();
      const [lockRows] = await conn.execute('SELECT GET_LOCK(?, 3) AS locked', [lockName]);
      lockAcquired = Number(lockRows?.[0]?.locked) === 1;
      if (!lockAcquired) return { ok: false, error: 'status_interval_busy' };
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT id,status,startedAt,lastSeenAt FROM machine_status_intervals WHERE machineNumber = ? AND statusType = ? AND openKey = \'Y\' ORDER BY startedAt DESC LIMIT 1 FOR UPDATE',
        [machineNumber, statusType]
      );
      const open = rows[0];
      const detailText = details == null ? null : JSON.stringify(details);
      if (open && open.status === status) {
        const startedMs = Date.parse(open.startedAt) || nowMs;
        const durationSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
        await conn.execute(
          'UPDATE machine_status_intervals SET lastSeenAt = ?, durationSec = ?, details = COALESCE(?, details), updatedAt = ? WHERE id = ?',
          [at, durationSec, detailText, at, open.id]
        );
      } else {
        if (open) {
          const startedMs = Date.parse(open.startedAt) || nowMs;
          const durationSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
          await conn.execute(
            'UPDATE machine_status_intervals SET endedAt = ?, lastSeenAt = ?, durationSec = ?, openKey = NULL, updatedAt = ? WHERE id = ?',
            [at, at, durationSec, at, open.id]
          );
        }
        const id = `msi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
        await conn.execute(
          'INSERT INTO machine_status_intervals (id,machineNumber,statusType,status,startedAt,endedAt,lastSeenAt,durationSec,details,openKey,createdAt,updatedAt) VALUES (?,?,?,?,?,NULL,?,?,?,\'Y\',?,?)',
          [id, machineNumber, statusType, status, at, at, 0, detailText, at, at]
        );
      }
      await conn.commit();
      return { ok: true };
    } catch (e) {
      try { if (conn) await conn.rollback(); } catch {}
      // 多进程同时首次写入时，唯一键竞争不应影响心跳主流程。
      console.error('[Machine Status Interval] write error:', e.message);
      return { ok: false, error: e.message };
    } finally {
      if (conn && lockAcquired) {
        try { await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]); } catch {}
      }
      try { if (conn) conn.release(); } catch {}
    }
  }

  const STATUS_TIMELINE_META = {
    recording: { label: '录制中', color: '#ff4d4f' },
    online_idle: { label: '在线空闲', color: '#52c41a' },
    error: { label: '异常', color: '#fa8c16' },
    offline: { label: '离线', color: '#8c8c8c' },
    unknown: { label: '未知', color: '#bfbfbf' },
    ready: { label: '可生产', color: '#52c41a' },
    in_production: { label: '在生产', color: '#1677ff' },
    waiting_repair: { label: '待维修', color: '#ff4d4f' },
    testing: { label: '在测试', color: '#722ed1' },
  };

  async function handleGetStatusTimeline(req, res, user, machineNumber) {
    try {
      machineNumber = String(machineNumber || '').trim().toLowerCase();
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      const url = new URL(req.url, 'http://x');
      const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '')
        ? url.searchParams.get('date') : shanghaiDate;
      // 日报按中国标准时间（Asia/Shanghai）切日，再转换为 ISO 时间参与索引查询。
      const dayStart = new Date(`${date}T00:00:00+08:00`).toISOString();
      const dayEnd = new Date(`${date}T23:59:59.999+08:00`).toISOString();
      const [rows] = await pool.execute(
        `SELECT id,machineNumber,statusType,status,startedAt,endedAt,lastSeenAt,durationSec,details
           FROM machine_status_intervals
          WHERE machineNumber = ? AND startedAt <= ? AND (endedAt IS NULL OR endedAt >= ?)
          ORDER BY statusType, startedAt`,
        [machineNumber, dayEnd, dayStart]
      );
      const now = new Date().toISOString();
      const clip = (r) => {
        const start = new Date(Math.max(Date.parse(r.startedAt) || 0, Date.parse(dayStart))).toISOString();
        const endMs = Math.min(Date.parse(r.endedAt || now) || Date.now(), Date.parse(dayEnd));
        const end = new Date(Math.max(endMs, Date.parse(start))).toISOString();
        let details = null; try { details = r.details ? JSON.parse(r.details) : null; } catch {}
        return { ...r, label: STATUS_LABELS[r.status] || r.status, startedAt: start, endedAt: r.endedAt ? end : null,
          durationSec: Math.max(0, Math.floor((endMs - Date.parse(start)) / 1000)), details };
      };
      const intervals = rows.map(clip);
      const summary = {};
      for (const r of intervals) {
        if (r.statusType !== 'runtime') continue;
        summary[r.status] = (summary[r.status] || 0) + Number(r.durationSec || 0);
      }
      const productionIntervals = intervals.filter(r => r.statusType === 'production');
      const productionSummary = {};
      for (const r of productionIntervals) {
        productionSummary[r.status] = (productionSummary[r.status] || 0) + Number(r.durationSec || 0);
      }
      // 老数据尚未有区间时，从生产状态审计流水重建只读区间，避免上线前历史日报为空。
      if (productionIntervals.length === 0) {
        const [historyRows] = await pool.execute(
          'SELECT data FROM machine_production_history WHERE machineNumber = ? ORDER BY createdAt ASC, id ASC LIMIT 2000',
          [machineNumber]
        );
        const events = historyRows.map(r => { try { return JSON.parse(r.data); } catch { return null; } })
          .filter(r => r && r.newStatus && r.createdAt);
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          const nextAt = events[i + 1]?.createdAt || now;
          const startMs = Date.parse(event.createdAt);
          const endMs = Date.parse(nextAt);
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < Date.parse(dayStart) || startMs > Date.parse(dayEnd)) continue;
          const clippedStart = Math.max(startMs, Date.parse(dayStart));
          const clippedEnd = Math.min(endMs, Date.parse(dayEnd));
          if (clippedEnd < clippedStart) continue;
          productionIntervals.push({ id: `history-${i}`, machineNumber, statusType: 'production', status: event.newStatus,
            label: STATUS_LABELS[event.newStatus] || event.newStatus,
            startedAt: new Date(clippedStart).toISOString(), endedAt: new Date(clippedEnd).toISOString(),
            durationSec: Math.max(0, Math.floor((clippedEnd - clippedStart) / 1000)),
            details: { reason: event.reason || '', source: event.source || '', ticketId: event.ticketId || '', operator: event.operatorName || '' } });
        }
        const [[current]] = await pool.execute(
          'SELECT status,updatedAt,reason,source,ticketId,updatedByName FROM machine_production WHERE machineNumber = ? LIMIT 1',
          [machineNumber]
        );
        if (productionIntervals.length === 0 && current && current.status) {
          const start = new Date(Math.max(Date.parse(current.updatedAt) || Date.parse(dayStart), Date.parse(dayStart))).toISOString();
          const endMs = Math.min(Date.now(), Date.parse(dayEnd));
          productionIntervals.push({ id: `current-${machineNumber}`, machineNumber, statusType: 'production', status: current.status,
            label: STATUS_LABELS[current.status] || current.status, startedAt: start, endedAt: null,
            durationSec: Math.max(0, Math.floor((endMs - Date.parse(start)) / 1000)),
            details: { reason: current.reason || '', source: current.source || '', ticketId: current.ticketId || '', operator: current.updatedByName || '' } });
        }
      }
      sendJSON(res, {
        success: true, machineNumber, date, intervals: intervals.filter(r => r.statusType === 'runtime'), productionIntervals,
        summary: Object.fromEntries(Object.entries(summary).map(([k, seconds]) => [k, { seconds, label: STATUS_LABELS[k] || k }])) ,
        productionSummary: Object.fromEntries(Object.entries(productionSummary).map(([k, seconds]) => [k, { seconds, label: STATUS_LABELS[k] || k }])),
        statusMeta: STATUS_TIMELINE_META,
      });
    } catch (e) {
      console.error('[Machine Status Interval] timeline error:', e.message);
      sendJSON(res, { error: '状态时间轴查询失败' }, 500);
    }
  }

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
      if (prev === status) {
        await recordStatusInterval(machineNumber, 'production', status, {
          reason: opts.reason || '', source: opts.source || 'manual', ticketId: opts.ticketId || '', operator: opts.operator?.name || '',
        });
        return { ok: true, changed: false, from: prev, to: status };
      }

      const now = new Date().toISOString();
      const reason = (opts.reason || '').slice(0, 500);
      const source = opts.source === 'ticket' || opts.source === 'recording' ? opts.source : 'manual';
      const opId = opts.operator?.id || (source === 'ticket' ? 'system' : source === 'recording' ? 'agent' : '');
      const opName = opts.operator?.name || (source === 'ticket' ? '系统（工单联动）' : source === 'recording' ? '边缘采集代理（录制）' : '');

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

      // 生产状态也进入同一套区间表，日报可以和运行状态对齐展示。
      await recordStatusInterval(machineNumber, 'production', status, {
        reason, source, ticketId: opts.ticketId || '', operator: opName,
      }, now);

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

  async function callAgent(machineNumber, path, { method = 'GET', body, timeout = 30000 } = {}) {
    const ip = collectorIpOf(machineNumber);
    if (!ip) return { ok: false, error: '无法解析目标机器地址' };
    const token = process.env.EDGE_TOKEN || '';
    if (!token) return { ok: false, error: '服务端未配置 EDGE_TOKEN' };
    const response = await fetch(`http://${ip}:3000${path}`, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-edge-token': token },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: data.error || `Agent HTTP ${response.status}`, ...data };
    return data;
  }

  async function runMachineCommandAgent(machineNumber, command, timeout = 30000) {
    const result = await callAgent(machineNumber, '/exec', { method: 'POST', body: { cmd: command, timeout }, timeout });
    return result.ok === false ? { ok: false, stderr: result.error } : { ok: true, stdout: result.output || result.stdout || '', ...result };
  }

  async function _fetchCollectorJSON(url, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function runAgentArmControl(machineNumber, payload, timeout = 40000) {
    return callAgent(machineNumber, '/arm-control', { method: 'POST', body: payload, timeout });
  }

  async function handleStopCollector(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const body = await callAgent(machineNumber, '/stop-collector', { method: 'POST', timeout: 35000 });
      if (body.ok === false) return sendJSON(res, { error: body.error || 'Agent 执行失败' }, 502);
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, container: body.container, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
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
      const body = await callAgent(machineNumber, '/stop-exodus', { method: 'POST', timeout: 35000 });
      if (body.ok === false) return sendJSON(res, { error: body.error || 'Agent 执行失败' }, 502);
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, container: body.container, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
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
      const body = await callAgent(machineNumber, '/fix-quest', { method: 'POST', timeout: 150000 });
      if (body.ok === false) return sendJSON(res, { error: body.error || 'Agent 执行失败' }, 502);
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, output: body.stdout || '', machineNumber, source: 'agent' });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleQuestControl(req, res, user, machineNumber, body) {
    try {
      if (!user || !['admin', 'superadmin'].includes(user.role)) return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      const action = String(body?.action || '');
      if (!['connect', 'disconnect'].includes(action)) return sendJSON(res, { error: '无效操作' }, 400);
      const ip = collectorIpOf(machineNumber); if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const out = await callAgent(machineNumber, '/quest-control', { method: 'POST', body: { action }, timeout: 30000 });
      if (out.ok === false) return sendJSON(res, { error: out.error || 'Agent 执行失败' }, 502);
      broadcastChange('machines', null, { machineNumber }); sendJSON(res,{success:true, action, machineNumber, output: out.stdout});
    } catch(e) { sendJSON(res,{error:e.message || 'Quest 操作失败'},502); }
  }

  async function handleDiagnoseHands(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const requestUrl = new URL(req.url, 'http://x');
      const requestedSide = (requestUrl.searchParams.get('side') || '').trim().toLowerCase();
      const side = requestedSide === 'left' || requestedSide === 'right' ? requestedSide : 'all';
      const body = await callAgent(machineNumber, `/diagnose-hands?side=${encodeURIComponent(side)}`, { method: 'POST', timeout: 175000 });
      if (body.ok === false) return sendJSON(res, { error: body.error || 'Agent 执行失败' }, 502);
      sendJSON(res, { success: true, ...body, machineNumber, side, source: 'agent' });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  // 灵巧手检测进度（目标机临时文件，前端轮询用）
  async function handleDiagnoseProgress(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const requestUrl = new URL(req.url, 'http://x');
      const requestedSide = (requestUrl.searchParams.get('side') || '').trim().toLowerCase();
      const side = requestedSide === 'left' || requestedSide === 'right' ? requestedSide : 'all';
      const body = await callAgent(machineNumber, `/diagnose-progress?side=${encodeURIComponent(side)}`, { timeout: 8000 });
      if (body.ok === false) return sendJSON(res, { error: body.error || 'Agent 执行失败' }, 502);
      sendJSON(res, { success: true, ...body, machineNumber, side, source: 'agent' });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
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

      const body = await callAgent(machineNumber, '/machine-config', { timeout: 15000 });
      if (body.ok === false) return sendJSON(res, { error: body.error || 'Agent 无法读取机器配置', source: 'agent' }, 502);
      const config = body && body.config && typeof body.config === 'object' ? body.config : body;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return sendJSON(res, { error: 'Importer 返回的机器配置格式无效', source: 'agent' }, 502);
      }
      return sendJSON(res, { success: true, config, raw: JSON.stringify(config, null, 2), source: 'agent-importer-api' });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleMachineProbe(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const health = await callAgent(machineNumber, '/health', { timeout: 30000 });
      if (health.ok === false) return sendJSON(res, { error: health.error || 'Agent 探针执行失败' }, 502);
      sendJSON(res, { success: true, machineNumber, health, checkedAt: new Date().toISOString(), source: 'agent' });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  // ==================== 通用命令按钮注册表 ====================
  // 前端"维护操作"面板的命令按钮即由本表生成；新增按钮只需在此加一行
  // 命令同时受服务端与 Agent 白名单限制。
  const MACHINE_COMMANDS = [
    { key: 'container-ps', label: '查看容器状态', cmd: 'docker ps', danger: false, timeout: 10000, showOutput: true },
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
      const body2 = await runMachineCommandAgent(machineNumber, cmdDef.cmd, cmdDef.timeout + 5000);
      if (!body2.ok) return sendJSON(res, { error: body2.stderr || 'Agent 执行失败' }, 502);
      if (cmdDef.showOutput) {
        return sendJSON(res, { success: true, output: body2.stdout || '', cmd: cmdDef.cmd, machineNumber });
      }
      broadcastChange('machines', null, { machineNumber });
      sendJSON(res, { success: true, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

  async function handleArmControl(req, res, user, machineNumber, body) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      if (!user || !['admin', 'superadmin'].includes(user.role)) {
        return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
      }
      body = body || {};
      const action = String(body.action || '');
      const arm = String(body.arm || 'A').toUpperCase();
      const state = body.state !== undefined ? parseInt(body.state, 10) : undefined;
      const validActions = ['connect', 'disconnect', 'exit', 'set_state', 'clear_error', 'soft_stop', 'get_errors', 'disable', 'set_joint_mode', 'set_impedance_joint', 'set_impedance_cart', 'joint_drag', 'cart_drag', 'exit_drag', 'set_tool'];
      if (!validActions.includes(action)) {
        return sendJSON(res, { error: '无效操作' }, 400);
      }
      if (!['A', 'B', 'AB'].includes(arm)) return sendJSON(res, { error: 'arm 必须为 A、B 或 AB' }, 400);
      if (action === 'set_state' && (isNaN(state) || state < 0 || state > 4)) {
        return sendJSON(res, { error: 'state 必须为 0-4' }, 400);
      }
      if (['set_joint_mode', 'set_impedance_joint', 'set_impedance_cart'].includes(action)) {
        const velRatio = Number(body.velRatio);
        const accRatio = Number(body.accRatio);
        if (!Number.isInteger(velRatio) || velRatio < 1 || velRatio > 100 || !Number.isInteger(accRatio) || accRatio < 1 || accRatio > 100) {
          return sendJSON(res, { error: 'velRatio/accRatio 必须为 1-100 的整数' }, 400);
        }
      }
      const ip = collectorIpOf(machineNumber);
      if (!ip) return sendJSON(res, { error: '该机器未部署采集器' }, 400);
      const result = await runAgentArmControl(machineNumber, {
        action, arm, state: isNaN(state) ? undefined : state,
        velRatio: body.velRatio, accRatio: body.accRatio, stiffness: body.stiffness, damping: body.damping,
        rotType: body.rotType, cartCtrlPara: body.cartCtrlPara, direction: body.direction, kinePara: body.kinePara, dynPara: body.dynPara,
      }, 40000);
      if (result.ok === false || result.success === false) return sendJSON(res, { error: result.error || 'Agent SDK 执行失败', ...result }, 502);
      sendJSON(res, { success: true, ...result, machineNumber });
    } catch (e) {
      const refused = e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ETIMEDOUT');
      const msg = refused || e.name === 'TimeoutError'
        ? '无法连接目标机器 Agent 或机械臂 SDK'
        : (e.message || '操作失败');
      sendJSON(res, { error: msg }, 502);
    }
  }

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

  // Agent 探针把 Wuji SDK 的详细诊断放在 wuji，同时把兼容摘要放在
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
      collectorStarted: ep.collectorStarted !== false
        && ep.edgeContainerRoleStatus?.collector?.running !== false,
      machineType: ep.machineType || null,
      machineTypeReason: ep.machineTypeReason || null,
      machineTypeConfidence: ep.machineTypeConfidence || null,
      machineTypeEvidence: ep.machineTypeEvidence || null,
      machineProfile: ep.machineProfile || null,
      importer: ep.importer || null,
      marvinBroker: ep.edgeMarvinBroker || null,
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
      health: ep.edgeHealth || null,
      containers: ep.edgeContainers || [],
      containerRoles: ep.edgeContainerRoles || {},
      containerRoleStatus: ep.edgeContainerRoleStatus || {},
      hostDisks: ep.edgeHostDisks || {},
      host: ep.edgeHost || {},
    };
  }

  function _normalizeMachineType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (['glove_only', 'glove-only', 'glove', 'glove_system', 'glove-system', '纯手套', '纯手套机器', '手套'].includes(type)) return 'glove_only';
    if (['dexterous', 'dexterous_hand', 'dexterous-hand', 'robot', 'robotic', 'robotic_arm', '灵巧手', '灵巧手机器', '机械臂'].includes(type)) return 'dexterous';
    return null;
  }

  const machineTypeOverrides = (() => {
    const map = Object.create(null);
    const raw = process.env.MACHINE_TYPE_OVERRIDES || 'we-051=dexterous';
    for (const item of String(raw).split(',')) {
      const [key, value] = item.split('=').map(v => String(v || '').trim().toLowerCase());
      const type = _normalizeMachineType(value);
      if (!key || !type) continue;
      map[key] = type;
      const match = key.match(/^(?:we|szx3)-0*(\d+)$/);
      if (match) map[match[1]] = type;
    }
    return map;
  })();

  function _machineTypeOverride(machineNumber) {
    const raw = String(machineNumber || '').trim().toLowerCase();
    const short = raw.match(/^(?:we|szx3)-0*(\d+)$/);
    return machineTypeOverrides[raw] || (short && machineTypeOverrides[short[1]]) || null;
  }

  function _applyMachineTypeOverride(record) {
    if (!record || !record.machineNumber) return record;
    const type = _machineTypeOverride(record.machineNumber);
    if (!type) return record;
    return {
      ...record,
      machineType: type,
      machineTypeReason: 'machine_type_override',
      machineTypeConfidence: 'high',
      deviceType: type === 'dexterous' ? 'dexterous' : 'glove',
    };
  }

  function _deriveMachineType(machineNumber, explicit, devicesNet, components, importer, explicitReason) {
    const overrideType = _machineTypeOverride(machineNumber);
    if (overrideType) return overrideType;
    const explicitType = _normalizeMachineType(explicit);
    const importerMachineId = String(importer && (importer.machineId || importer.machine_id) || '');
    const importerUnit = String(importer && (importer.commanderUnit || importer.commander?.unit) || '');
    if (/iris/i.test(importerMachineId) || /^iris$/i.test(importerUnit)) return 'dexterous';
    // 显式配置优先；其它值仍需让 Importer 配置校正。
    if (explicitReason === 'configured' && (explicitType === 'glove_only' || explicitType === 'dexterous')) {
      return explicitType;
    }
    const importerType = _normalizeMachineType(importer && (importer.machineType || importer.machine_type));
    if (importerType === 'glove_only' || importerType === 'dexterous') return importerType;
    // 直连 Hermes core/health 时可能只带原始 machine_config；即使没有
    // 即使没有经过额外规范化，也按 Importer 配置中的设备槽位识别。
    const normalizedSlots = [
      ...(importer && Array.isArray(importer.gelloSlots) ? importer.gelloSlots : []),
      ...(importer && Array.isArray(importer.gloveSlots) ? importer.gloveSlots : []),
      ...(importer && Array.isArray(importer.robotSlots) ? importer.robotSlots : []),
    ].map(String);
    if (normalizedSlots.some(name => /(?:wuji_hand|dexterous|marvin|robotic_arm|robot_arm|gripper)/i.test(name))) return 'dexterous';
    if (normalizedSlots.some(name => /(?:wuji_glove|glove)/i.test(name))) return 'glove_only';
    // 只有带有 config 原文时才递归扫描；规范化 profile 中的字段名
    //（例如 gloveSlots）不是硬件槽位，不能单凭字段名判成纯手套。
    const importerRoot = importer && importer.config && typeof importer.config === 'object'
      ? importer.config
      : (importer && (importer.commander || importer.robot || importer.robots
        || importer.robotic_arm || importer.robot_arm) ? importer : null);
    const importerNames = [];
    const collectNames = (value, key = '') => {
      if (key) importerNames.push(String(key));
      if (!value || typeof value !== 'object') {
        return;
      }
      for (const [childKey, child] of Object.entries(value)) collectNames(child, childKey);
    };
    if (importerRoot) {
      collectNames(importerRoot);
      if (importerNames.some(name => /(?:wuji_hand|dexterous|marvin|robotic_arm|robot_arm|gripper)/i.test(name))) return 'dexterous';
      if (importerNames.some(name => /(?:wuji_glove|glove)/i.test(name))) return 'glove_only';
    }
    if (['configured', 'importer_config'].includes(explicitReason)
      && (explicitType === 'glove_only' || explicitType === 'dexterous')) return explicitType;
    const d = devicesNet || {};
    const hands = d.dexterousHands || {};
    if ((hands.left && hands.left.connected) || (hands.right && hands.right.connected)
      || (d.roboticArm && d.roboticArm.connected)) return 'dexterous';
    const keys = Object.keys(components || {});
    if (keys.some(key => key === 'robot/wuji_hand_l' || key === 'robot/wuji_hand_r' || key === 'robot/marvin')) return 'dexterous';
    const match = /^(?:we|szx3)-(\d+)$/.exec(String(machineNumber || '').toLowerCase());
    if (match) return parseInt(match[1], 10) < 100 ? 'glove_only' : 'dexterous';
    return null;
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
    const machineType = _deriveMachineType(
      machineNumber,
      edge && edge.machineType,
      dnet,
      ciInfo.components || (hermesHealth && hermesHealth.components),
      (edge && edge.importer) || (core && core.machine_config),
      edge && edge.machineTypeReason,
    );
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
    if (machineType === 'glove_only') {
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
        id: tc.operator_id || op.id || null,
        name: op.name || op.localized_name || '未知',
        localizedName: op.localized_name || null,
        level: op.level != null ? op.level : null,
        email: op.email || null,
        state: op.state || null,
      },
      steps: (tpl.steps && tpl.steps.payload) || [],
      verbs: tpl.verbs || [],
      objects: tpl.objects || [],
    } : null;

    const misc = (core && core.machine_config && core.machine_config.misc) || {};
    const edgeContainers = edge && Array.isArray(edge.containers) ? edge.containers : [];
    const containers = edgeContainers.length
      ? edgeContainers
      : Object.entries((core && core.containers) || {}).map(([name, status]) => ({ name, status }));

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
      machineType,
      machineTypeReason: (edge && edge.importer && edge.importer.machineTypeReason)
        || (edge && edge.machineTypeReason) || null,
      machineTypeConfidence: (edge && edge.importer && edge.importer.machineTypeConfidence)
        || (edge && edge.machineTypeConfidence) || null,
      machineTypeEvidence: (edge && edge.importer && edge.importer.machineTypeEvidence)
        || (edge && edge.machineTypeEvidence) || null,
      machineProfile: (edge && edge.machineProfile) || null,
      marvinBroker: (edge && edge.marvinBroker) || null,
      importer: (edge && edge.importer) || null,
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
      host: (edge && edge.host) || {},
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
      containerRoles: (edge && edge.containerRoles) || {},
      containerRoleStatus: (edge && edge.containerRoleStatus) || {},
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

      let edgePresence = null;
      try {
        const presence = await loadAgentPresence();
        edgePresence = presence && presence[machineNumber] ? presence[machineNumber] : null;
      } catch { }

      let snap = null;
      if (edgePresence && edgePresence.hostLastSeen
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
        const snapMachineType = _deriveMachineType(
          machineNumber,
          snap.machineType,
          dnet0,
          comps,
          imp,
          snap.machineTypeReason,
        );
        if (snapMachineType === 'glove_only') {
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
            id: it.operatorId || (it.operator && it.operator.id) || null,
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
          collectorStarted: snap.collectorStarted !== false
            && snap.edgeContainerRoleStatus?.collector?.running !== false,
          machineType: snapMachineType,
          machineTypeReason: imp.machineTypeReason || snap.machineTypeReason || null,
          machineTypeConfidence: imp.machineTypeConfidence || snap.machineTypeConfidence || null,
          machineTypeEvidence: imp.machineTypeEvidence || snap.machineTypeEvidence || null,
          machineProfile: snap.machineProfile || null,
          importer: imp,
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
          marvinBroker: snap.edgeMarvinBroker || null,
          handStream: snap.edgeHandStream || null,
          health: snap.edgeHealth || null,
          containers: snap.edgeContainers || [],
          containerRoles: snap.edgeContainerRoles || {},
          containerRoleStatus: snap.edgeContainerRoleStatus || {},
          hostDisks: snap.edgeHostDisks || {},
          host: snap.edgeHost || {},
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
          containers: (Array.isArray(snap.edgeContainers) && snap.edgeContainers.length)
            ? snap.edgeContainers
            : [
              { name: 'importer', status: imp.reachable === false ? 'exited' : 'running' },
              { name: snap.containerRoleStatus && snap.containerRoleStatus.collector
                ? snap.containerRoleStatus.collector.name : '采集程序', status: herDown ? 'exited' : 'running' },
            ],
          containerRoles: snap.edgeContainerRoles || {},
          containerRoleStatus: snap.edgeContainerRoleStatus || {},
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

      sendJSON(res, {
        success: false,
        machineNumber,
        hostOnline: false,
        source: 'agent',
        error: edgePresence?.agentError || '尚未取得有效 Agent 快照',
      }, 503);
    } catch (e) {
      console.error('[Machine Info] Error:', e);
      sendJSON(res, { error: '服务器内部错误' }, 500);
    }
  }

  // Operations dashboard aggregate: read-only snapshot of Importer/Hermes state.
  async function handleGetOperationsCenter(req, res, user, machineNumber) {
    try {
      if (!machineNumber) return sendJSON(res, { error: '机器编号不能为空' }, 400);
      // Agent-first path: use the latest read-only Importer/Hermes snapshot
      // persisted by the edge heartbeat. This avoids opening eight HTTP
      // connections to the target machine for every dashboard refresh.
      try {
        const [agentRows] = await pool.execute(
          "SELECT data, lastSeen FROM edge_hosts WHERE machineNumber = ? AND agentVersion IS NOT NULL AND agentVersion <> '' ORDER BY updatedAt DESC LIMIT 1",
          [machineNumber]
        );
        const row = agentRows[0];
        const live = getEdgeLive(machineNumber);
        if (live && live.importer && Date.now() - live.ts < 10000) {
          agentRows.unshift({ data: JSON.stringify(live), lastSeen: new Date(live.ts).toISOString() });
        }
        const effectiveRow = agentRows[0];
        const age = effectiveRow && effectiveRow.lastSeen ? Date.now() - new Date(effectiveRow.lastSeen).getTime() : Infinity;
        if (effectiveRow && age >= 0 && age < 120000) {
          let snap = {};
          try { snap = JSON.parse(effectiveRow.data || '{}'); } catch {}
          const importer = snap.importer || {};
          const health = importer.health || importer.maintenanceHealth || importer;
          const task = importer.task && importer.task.id ? importer.task : null;
          const machineConfig = importer.machine || importer.machineConfig || health.machine_config || {};
          const episodesRaw = importer.episodes || importer.episodeRecords || [];
          const episodes = Array.isArray(episodesRaw) ? episodesRaw : (episodesRaw.items || []);
          const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || new Date().setHours(0, 0, 0, 0) / 1000;
          const until = Number(new URL(req.url, 'http://x').searchParams.get('until')) || (since + 86400);
          const uploaded = episodes.filter(item => { const at = Number(item.occurred_at ?? item.updated_at ?? 0); return !at || (at >= since && at < until); });
          const overview = importer.overview || importer.operationsOverview || {};
          const processor = importer.processorOverview || importer.dataProcessing || importer.processingOverview || importer.processing || {};
          const quality = importer.quality || overview.quality || null;
          const operator = task?.operator || {};
          const template = task?.template || {};
          return sendJSON(res, {
            success: true, machineNumber, generatedAt: Date.now() / 1000,
            period: { since, until, timezone: 'local' },
            login: { loggedIn: health.is_logged_in ?? importer.loggedIn ?? null, idleTimeSecs: health.idle_time_secs ?? null, activity: health.activity ?? null },
            machine: { machineId: machineConfig?.misc?.machine_id || importer.machineId || null, computerId: machineConfig?.misc?.computer_id || importer.computerId || null, importerVersion: health.version || importer.importerVersion || importer.version || null, workflow: machineConfig?.collector?.workflow || importer.workflow || null, collectorType: machineConfig?.collector?.type || importer.collectorType || null },
            task: task ? { id: task.id, state: task.state || null, name: template.ref_name || template.name || null, training: !!template.is_training, operator: { id: task.operator_id || operator.id || null, name: operator.name || operator.localized_name || null, localizedName: operator.localized_name || null, level: operator.level ?? null } } : null,
            processing: { workers: importer.workers || processor.workers || [], queue: importer.queue || null, workflows: importer.processing?.workflows || importer.workflows || [], pending: processor.pending ?? null, busy: processor.busy ?? null, stalled: processor.stalled ?? null, done: processor.done ?? null, total: processor.total ?? null, episodes: processor.episodes || [] },
            uploads: { episodeCount: uploaded.length, sizeBytes: 0, sizeKnown: false, returnedCount: episodes.length, nextCursor: episodesRaw?.next_cursor ?? null },
            sessions: { attendedSeconds: overview.attended_seconds ?? null, items: overview.sessions || [], runs: overview.runs || [], attempts: overview.attempts || {} },
            quality: { pass: quality?.pass ?? null, fail: quality?.fail ?? null, error: quality?.error ?? null },
            qualityPassRate: importer.qualityPassRate ?? overview.quality_pass_rate ?? null,
            latestMcapReport: importer.latestMcapReport ?? overview.latest_mcap_report ?? null,
            recentMcapReports: importer.recentMcapReports || overview.recent_mcap_reports || [],
            recentFailures: importer.recentFailures || overview.recent_failures || [],
            faults: importer.faults || overview.faults || {},
            source: 'agent', dataAgeSec: Math.round(age / 1000), sourceErrors: importer.endpointErrors || snap.sourceErrors || {},
          }, 200);
        }
      } catch (agentErr) {
        console.warn('[Operations Center] Agent snapshot unavailable:', agentErr.message);
      }

      // 运营中心统一使用 Agent 快照，避免服务端直接连接目标机造成竞争和阻塞。
      return sendJSON(res, {
        success: false,
        machineNumber,
        source: 'agent',
        error: 'Agent 尚未上报运营中心数据',
      }, 503);

      const query = new URL(req.url, 'http://x').searchParams;
      const now = Date.now() / 1000;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const nextDay = new Date(startOfDay.getTime() + 86400000);
      const since = Number(query.get('since')) || startOfDay.getTime() / 1000;
      const until = Number(query.get('until')) || nextDay.getTime() / 1000;
      const base = `http://${ip}:5025`;
      const requests = {
        health: `${base}/api/maintenance/health`,
        task: `${base}/api/config/task`,
        machine: `${base}/api/config/machine`,
        workers: `${base}/api/data/processing/workers/status`,
        queue: `${base}/api/data/processing/process_queue/status`,
        processing: `${base}/api/data/processing/overall`,
        episodes: `${base}/api/data/episodes/records`,
        overview: `${base}/api/operations/overview?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      };
      const entries = Object.entries(requests);
      const settled = await Promise.allSettled(entries.map(([, url]) => _fetchCollectorJSON(url, 8000)));
      const raw = {};
      const errors = {};
      entries.forEach(([name], i) => {
        if (settled[i].status === 'fulfilled') raw[name] = settled[i].value;
        else errors[name] = settled[i].reason?.message || '请求失败';
      });

      const task = raw.task && raw.task.id ? raw.task : null;
      const template = task?.template || {};
      const operator = task?.operator || {};
      const machineConfig = raw.machine || raw.health?.machine_config || {};
      const episodes = Array.isArray(raw.episodes) ? raw.episodes : (raw.episodes?.items || []);
      const uploadedEpisodes = episodes.filter(item => {
        if (item.category && item.category !== 'episode') return false;
        const at = Number(item.occurred_at ?? item.updated_at ?? 0);
        return !at || (at >= since && at < until);
      });
      const sizeBytes = uploadedEpisodes.reduce((sum, item) => {
        const value = item?.payload?.size_bytes;
        const n = value == null ? NaN : Number(value);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const sizeKnown = uploadedEpisodes.some(item => {
        const value = item?.payload?.size_bytes;
        return value != null && Number.isFinite(Number(value));
      });
      const overview = raw.overview || {};
      const health = raw.health || {};
      const workflow = machineConfig?.collector?.workflow || health?.machine_config?.collector?.workflow || null;

      sendJSON(res, {
        success: true,
        machineNumber,
        generatedAt: now,
        period: { since, until, timezone: 'local' },
        login: {
          loggedIn: health.is_logged_in ?? null,
          idleTimeSecs: health.idle_time_secs ?? null,
          activity: health.activity ?? null,
        },
        machine: {
          machineId: machineConfig?.misc?.machine_id || null,
          computerId: machineConfig?.misc?.computer_id || null,
          importerVersion: health.version || null,
          workflow,
          collectorType: machineConfig?.collector?.type || null,
        },
        task: task ? {
          id: task.id,
          state: task.state || null,
          name: template.ref_name || template.name || null,
          training: !!template.is_training,
          operator: {
            id: task.operator_id || operator.id || null,
            name: operator.name || operator.localized_name || null,
            localizedName: operator.localized_name || null,
            level: operator.level ?? null,
          },
        } : null,
        processing: {
          workers: raw.workers || raw.processing?.workers || [],
          queue: raw.queue || null,
          workflows: raw.processing?.workflows || [],
        },
        uploads: {
          episodeCount: uploadedEpisodes.length,
          sizeBytes: sizeKnown ? sizeBytes : null,
          sizeKnown,
          returnedCount: episodes.length,
          nextCursor: raw.episodes?.next_cursor ?? null,
        },
        sessions: {
          attendedSeconds: overview.attended_seconds ?? null,
          items: overview.sessions || [],
          runs: overview.runs || [],
          attempts: overview.attempts || {},
        },
        quality: {
          pass: overview.quality?.pass ?? null,
          fail: overview.quality?.fail ?? null,
          error: overview.quality?.error ?? null,
        },
        qualityPassRate: overview.quality_pass_rate ?? null,
        latestMcapReport: overview.latest_mcap_report ?? null,
        recentMcapReports: overview.recent_mcap_reports || [],
        recentFailures: overview.recent_failures || [],
        faults: overview.faults || {},
        sourceErrors: errors,
      });
    } catch (e) {
      console.error('[Operations Center] Error:', e);
      sendJSON(res, { error: e.message || '读取运营状态失败' }, 502);
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

      const tick = async () => {
        if (closed || fastBusy) return;
        fastBusy = true;
        try {
          const presence = await loadAgentPresence();
          const snap = presence[machineNumber];
          if (!snap || !snap.hostOnline) {
            if (!closed) res.write(`data: ${JSON.stringify({ success: false, machineNumber, hostOnline: false, source: 'agent' })}\n\n`);
            fastBusy = false;
            return;
          }
          const hermes = snap.hermes || {};
          const fulfilled = value => ({ status: 'fulfilled', value });
          const body = _composeLiveInfo(machineNumber, [
            fulfilled(snap.importer || {}), fulfilled(hermes.health || {}),
            fulfilled(hermes.version || {}), fulfilled(hermes.state || {}), fulfilled(hermes.sensors || {}),
          ], _edgeInfoFromPresence(snap));
          body.source = 'agent';
          body.dataAgeSec = snap.hostLastSeen
            ? Math.max(0, Math.round((Date.now() - new Date(snap.hostLastSeen).getTime()) / 1000)) : null;
          if (!closed) res.write(`data: ${JSON.stringify(body)}\n\n`);
        } catch { }
        fastBusy = false;
      };

      const kill = () => {
        if (closed) return;
        closed = true;
        clearInterval(fastTimer);
        clearTimeout(maxTimer);
        try { res.end(); } catch { }
      };
      req.on('close', kill);

      const fastTimer = setInterval(() => { tick(); }, 2000);
      const maxTimer = setTimeout(kill, 30 * 60 * 1000);

      if (!closed) await tick();
    } catch (e) {
      console.error('[Machine Live] Error:', e);
      try { res.end(); } catch { }
    }
  }

  return {
    handleListAgentHosts,
    handleGetMachineCode,
    handleMobileGetMachines,
    handleGetMachineStatus,
    handleGetMachineInfo,
    handleGetOperationsCenter,
    handleGetMachineLive,
    handleStopCollector,
    handleStopExodus,
    handleFixQuest,
    handleQuestControl,
    handleDiagnoseHands,
    handleDiagnoseProgress,
    handleMachineConfig,
    handleMachineProbe,
    handleMachineCommands,
    handleMachineCommand,
    handleArmControl,
    handleGetMachines,
    handleAddMachine,
    handleDeleteMachine,
    handleBindMachine,
    handleUnbindMachine,
    handleGetMachineBindings,
    handleSyncMachineState,
    handleSetProductionStatus,
    handleGetProductionHistory,
    handleGetStatusTimeline,
    recordStatusInterval,
    setProductionStatus,
  };
};
