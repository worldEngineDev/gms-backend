'use strict';

const crypto = require('crypto');

const PRESENCE_FRESH_MS = 120 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const TICKET_RULES = {
  hand_mismatch:        { faultType: '手套接线错误（左右手接反）', priority: 'P2' },
  sn_unusable:          { faultType: '设备状态异常（不可投入使用）', priority: 'P1' },
  sn_bound_elsewhere:   { faultType: '设备串用（SN 绑定在其他机器）', priority: 'P2' },
  unregistered_sn:      { faultType: '设备未登记入库', priority: 'P3' },
  bound_but_disconnected: { faultType: '绑定设备未连接', priority: 'P3' },
  glove_no_sn:          { faultType: '手套 SN 无法识别', priority: 'P3' },
  importer_unreachable: { faultType: 'Importer 采集服务不可达', priority: 'P2' },
  hermes_unreachable:   { faultType: 'Hermes 采集程序不可达', priority: 'P1' },
  collector_degraded:   { faultType: '采集组件降级', priority: 'P1' },
  emergency_stopped:    { faultType: '采集机处于急停状态', priority: 'P1' },
  recorder_not_ready:   { faultType: '录制器未就绪', priority: 'P2' },
  hermes_errors:        { faultType: 'Hermes 采集程序报错', priority: 'P1' },
};

const DEFAULT_TICKET_CODES = ['hand_mismatch', 'sn_unusable', 'sn_bound_elsewhere', 'unregistered_sn', 'collector_degraded'];
const TICKET_RETRY_MS = 10 * 60 * 1000;
const IMMEDIATE_ALERT_CODES = new Set(['emergency_stopped']);

function normalizedAlertPart(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, 240);
}

function alertFingerprint(alert) {
  const details = alert && alert.details && typeof alert.details === 'object' ? alert.details : {};
  const components = Array.isArray(alert && alert.components) ? [...alert.components].map(String).sort().join(',') : '';
  const errors = Array.isArray(details.errors)
    ? details.errors.slice(0, 10).map(item => normalizedAlertPart(
      typeof item === 'string' ? item : (item && (item.code || item.message || item.error || JSON.stringify(item)))
    )).sort().join('|')
    : '';
  return [alert && alert.code, alert && alert.kind, alert && alert.hand, alert && alert.snCode, components, errors]
    .map(normalizedAlertPart).join(':');
}

// 告警仍会立即展示；只有持续两个心跳的非急停告警才标记为 confirmed，
// 供自动工单和外部通知使用，避免短暂的 API/设备抖动制造工单风暴。
function applyAlertLifecycle(alerts, previousAlerts, now) {
  const previous = new Map((Array.isArray(previousAlerts) ? previousAlerts : []).map(alert => [
    alert.fingerprint || alertFingerprint(alert), alert,
  ]));
  const active = [];
  const events = [];
  const seen = new Set();
  for (const raw of Array.isArray(alerts) ? alerts : []) {
    const fingerprint = alertFingerprint(raw);
    const prior = previous.get(fingerprint);
    const occurrenceCount = Number(prior && prior.occurrenceCount || 0) + 1;
    const confirmed = IMMEDIATE_ALERT_CODES.has(raw.code) || occurrenceCount >= 2;
    const alert = {
      ...raw,
      fingerprint,
      firstDetectedAt: prior && prior.firstDetectedAt || now,
      lastDetectedAt: now,
      occurrenceCount,
      confirmed,
    };
    active.push(alert);
    seen.add(fingerprint);
    if (!prior) events.push({ type: 'raised', alert });
    else if (!prior.confirmed && confirmed) events.push({ type: 'confirmed', alert });
  }
  for (const [fingerprint, prior] of previous) {
    if (seen.has(fingerprint)) continue;
    const started = Date.parse(prior.firstDetectedAt || prior.lastDetectedAt || now);
    events.push({
      type: 'resolved',
      alert: {
        ...prior,
        fingerprint,
        resolvedAt: now,
        durationSec: Number.isFinite(started) ? Math.max(0, Math.round((Date.parse(now) - started) / 1000)) : null,
      },
    });
  }
  return { alerts: active, events };
}

function createEdgeHandlers(deps) {
  const { pool, redisClient, sendJSON, broadcastSSE } = deps;
  const broadcastChange = typeof deps.broadcastChange === 'function' ? deps.broadcastChange : null;
  const syncInventoryFromSN = typeof deps.syncInventoryFromSN === 'function' ? deps.syncInventoryFromSN : null;

  let _createSystemTicket = null;
  function setTicketCreator(fn) {
    _createSystemTicket = typeof fn === 'function' ? fn : null;
  }

  // 录制恢复自动关单（由 tech-support 域注入）：机器开始录制时自动完成采集类自动工单
  let _autoTicketCompleter = null;
  function setTicketCompleter(fn) {
    _autoTicketCompleter = typeof fn === 'function' ? fn : null;
  }

  function _ticketEnabledCodes() {
    const codes = new Set(DEFAULT_TICKET_CODES);
    for (const c of String(process.env.EDGE_AUTO_TICKET_EXTRA || '').split(',')) {
      const code = c.trim();
      if (code) codes.add(code);
    }
    return codes;
  }

  function authenticate(req, res) {
    if (!process.env.EDGE_TOKEN) {
      sendJSON(res, { error: '服务端未配置 EDGE_TOKEN，拒绝边缘接入' }, 503);
      return false;
    }
    const auth = String(req.headers['authorization'] || '');
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const expected = process.env.EDGE_TOKEN;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (!provided || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      sendJSON(res, { error: '边缘节点认证失败' }, 401);
      return false;
    }
    return true;
  }

  async function _setRedisPresence(machineNumber, payload) {
    if (!redisClient || typeof redisClient.set !== 'function') return;
    try {
      await redisClient.set(`edge:presence:${machineNumber}`, JSON.stringify(payload), 'EX', 120);
    } catch {                                  }
  }

  async function _clearRedisPresence(machineNumber) {
    if (!redisClient || typeof redisClient.del !== 'function') return;
    try { await redisClient.del(`edge:presence:${machineNumber}`); } catch {}
  }

  async function _recordAlertEvents(machineNumber, events) {
    if (!Array.isArray(events) || events.length === 0) return;
    for (const event of events.slice(0, 50)) {
      const alert = event.alert || {};
      try {
        await pool.execute(
          `INSERT INTO edge_alert_events (id, machineNumber, fingerprint, eventType, alertCode, level, data, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            machineNumber,
            String(alert.fingerprint || alertFingerprint(alert)).slice(0, 512),
            event.type,
            String(alert.code || '').slice(0, 64),
            String(alert.level || '').slice(0, 32),
            JSON.stringify(alert),
            new Date().toISOString(),
          ],
        );
      } catch (error) {
        // 事件审计不能影响心跳主链路；表升级期间也保持向后兼容。
        console.warn('[EDGE] 告警事件审计写入失败:', error.message);
      }
    }
  }

  // 依据库存 equipmentType（缺失时按 SN 前缀 WH=灵巧手，其余=手套）归类
  function _snKind(recOrSn, equipmentType) {
    const et = equipmentType !== undefined ? equipmentType : (recOrSn && recOrSn.equipmentType);
    const sn = typeof recOrSn === 'string' ? recOrSn : (recOrSn && recOrSn.snCode) || '';
    if (et === 'dexterous_hand' || (!et && String(sn).startsWith('WH'))) return 'dexterous_hand';
    return 'glove';
  }

  // 事务内按在库手套重算机器在线状态（在线规则以左/右手手套为准，灵巧手不参与）
  async function _cascadeMachineStatusByGloves(conn, machineNumber, now) {
    if (!machineNumber) return;
    const [mRows] = await conn.execute(
      'SELECT id, data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1 FOR UPDATE',
      [machineNumber]
    );
    if (mRows.length === 0) return;
    let d;
    try { d = JSON.parse(mRows[0].data); } catch { return; }
    if (d.status === 'waiting_repair' || d.status === 'repairing') return;
    const [cnt] = await conn.execute(
      "SELECT handType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' AND (equipmentType = 'glove' OR snCode LIKE 'WG%')",
      [machineNumber]
    );
    const hands = new Set(cnt.map(c => c.handType));
    let next = d.status;
    if (hands.has('left') && hands.has('right')) next = 'online';
    else if (hands.has('left') || hands.has('right')) next = 'partial';
    else next = 'offline';
    if (next === d.status) return;
    d.status = next;
    d.updatedAt = now;
    await conn.execute(
      "INSERT INTO machines (id, data, machineNumber, status, updatedAt) VALUES (?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE data = VALUES(data), status = VALUES(status), updatedAt = VALUES(updatedAt)",
      [mRows[0].id, JSON.stringify(d), d.machineNumber, d.status, d.updatedAt]
    );
    console.log('[EDGE][自动绑定] ' + machineNumber + ' 机器状态联动 -> ' + next);
  }

  // 心跳自动识别上架：库存匹配到且物理连在本机的手套/灵巧手自动绑定到当前机器；
  // 已绑其它机器的自动改绑到本机（以实际物理连接为准）。不自动解绑（瞬断不抖动）。
  // 同槽位替换：当已登记的新设备占用本机某槽位时，自动下架该槽位原绑旧设备（一个槽位只允许一台设备）。
  const AUTO_BIND_USABLE = new Set(["available", "repaired"]);
  const AUTO_BIND_BLOCKED = new Set(["damaged","transferred","shipped","scrapped","in_repair","repairing","waiting_repair"]);

  async function autoBindObserved(machineNumber, devices) {
    const out = [];
    const gloves = (devices && devices.gloves) || {};
    const dexHands = (devices && devices.dexterousHands) || {};
    const list = [];
    for (const hand of ['left', 'right']) {
      const g = gloves[hand];
      if (g && g.connected && g.snCode) list.push({ kind: 'glove', hand, snCode: String(g.snCode) });
      const h = dexHands && dexHands[hand];
      if (h && h.connected && h.snCode) list.push({ kind: 'dexterous_hand', hand, snCode: String(h.snCode) });
    }
    if (!list.length) return out;

    const conn = await pool.getConnection();
    let changed = false;
    try {
      await conn.beginTransaction();
      const sns = [...new Set(list.map(o => o.snCode))];
      const ph = sns.map(() => '?').join(',');
      const [rows] = await conn.execute(
        'SELECT snCode, equipmentType, handType, status, machineNumber FROM sn_registry WHERE snCode IN (' + ph + ') FOR UPDATE',
        sns
      );
      const map = Object.create(null);
      for (const r of rows) map[r.snCode] = r;

      const now = new Date().toISOString();
      const oldMachines = new Set();

      for (const o of list) {
        const rec = map[o.snCode];
        if (!rec) continue;
        if (rec.handType && rec.handType !== o.hand) continue;
        const equipmentType = rec.equipmentType || o.kind;

        if (!AUTO_BIND_BLOCKED.has(rec.status) && !(rec.status === 'in_use' && (rec.machineNumber || '') === machineNumber)) {
          let action = null;
          if (rec.status === 'in_use' && rec.machineNumber && rec.machineNumber !== machineNumber) {
            action = 'rebind';
            oldMachines.add(rec.machineNumber);
          } else if (AUTO_BIND_USABLE.has(rec.status) || !rec.machineNumber) {
            action = 'bind';
          }
          if (action) {
            await conn.execute(
              'UPDATE sn_registry SET equipmentType=?, handType=?, status=?, machineNumber=?, updatedAt=? WHERE snCode=?',
              [equipmentType, o.hand, 'in_use', machineNumber, now, o.snCode]
            );
            const hid = 'h-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '-' + o.snCode.slice(-6);
            const reason = action === 'rebind'
              ? '心跳检测到设备实际连接在机器' + machineNumber + '，由机器' + rec.machineNumber + '自动改绑'
              : '心跳自动识别设备连接并上架到当前机器';
            await conn.execute(
              'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?,?,?,?,?,?,?,?)',
              [hid, o.snCode, rec.status || 'available', 'in_use', 'edge-auto', reason, machineNumber, now]
            );
            changed = true;
            out.push({ snCode: o.snCode, kind: o.kind, hand: o.hand, action, fromMachine: action === 'rebind' ? rec.machineNumber : null });
          }
        }

        // 同槽位替换清理：本机该槽位被当前已登记设备占用，释放槽位上其他在用旧设备
        const [staleRows] = await conn.execute(
          "SELECT snCode FROM sn_registry WHERE machineNumber = ? AND status = 'in_use' AND equipmentType = ? AND handType = ? AND snCode <> ? FOR UPDATE",
          [machineNumber, equipmentType, o.hand, o.snCode]
        );
        for (const s of staleRows) {
          await conn.execute(
            "UPDATE sn_registry SET status = 'available', machineNumber = '', updatedAt = ? WHERE snCode = ?",
            [now, s.snCode]
          );
          const sid = 'h-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '-' + s.snCode.slice(-6);
          await conn.execute(
            'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?,?,?,?,?,?,?,?)',
            [sid, s.snCode, 'in_use', 'available', 'edge-auto', '同槽位检测到新设备 ' + o.snCode + '，旧设备自动下架', machineNumber, now]
          );
          changed = true;
          out.push({ snCode: s.snCode, kind: o.kind, hand: o.hand, action: 'release', replacedBy: o.snCode });
        }
      }

      if (!changed) { await conn.rollback(); return out; }

      await _cascadeMachineStatusByGloves(conn, machineNumber, now);
      for (const m of oldMachines) {
        if (m && m !== machineNumber) await _cascadeMachineStatusByGloves(conn, m, now);
      }
      if (syncInventoryFromSN) await syncInventoryFromSN(conn);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('[EDGE][自动绑定] 异常:', e.message);
      return out;
    } finally {
      try { conn.release(); } catch {}
    }

    for (const r of out) {
      const kindLabel = r.kind === 'dexterous_hand' ? '灵巧手' : '手套';
      const handLabel = r.hand === 'left' ? '左手' : '右手';
      let line;
      if (r.action === 'release') {
        line = '[EDGE][自动绑定] ' + machineNumber + ' 自动下架 ' + kindLabel + handLabel + ' ' + r.snCode + '（被 ' + r.replacedBy + ' 取代）';
      } else {
        line = '[EDGE][自动绑定] ' + machineNumber + ' ' + (r.action === 'rebind' ? '自动改绑' : '自动上架') + ' ' + kindLabel + handLabel + ' ' + r.snCode + (r.fromMachine ? '（原绑 ' + r.fromMachine + '）' : '');
      }
      console.log(line);
    }
    if (changed && broadcastChange) {
      try { broadcastChange('sn_registry', ['inventory', 'machines']); } catch {}
    }
    return out;
  }
  async function reconcile(machineNumber, devices, collector) {
    const alerts = [];
    const gloves = { ...((devices && devices.gloves) || {}) };
    const dexHands = { ...((devices && devices.dexterousHands) || {}) };
    // Wuji SDK 是设备连接的权威来源；网络 Ping 不通并不等于设备未连接。
    // Agent 上报的 SDK 结果只要带有 connected/healthy，就覆盖旧探测结果。
    const wuji = collector && collector.wuji && typeof collector.wuji === 'object' ? collector.wuji : {};
    for (const hand of ['left', 'right']) {
      const sdkGlove = wuji.gloves && wuji.gloves[hand];
      const sdkHand = wuji.dexterousHands && wuji.dexterousHands[hand];
      if (sdkGlove && (sdkGlove.connected === true || sdkGlove.healthy === true)) {
        gloves[hand] = { ...(gloves[hand] || {}), ...sdkGlove, connected: true, snCode: sdkGlove.sn || gloves[hand]?.snCode || null };
      }
      if (sdkHand && (sdkHand.connected === true || Number(sdkHand.onlineJoints || 0) > 0)) {
        dexHands[hand] = { ...(dexHands[hand] || {}), ...sdkHand, connected: true, snCode: sdkHand.sn || dexHands[hand]?.snCode || null };
      }
    }
    const observed = {
      left: {
        connected: !!(gloves.left && gloves.left.connected),
        snCode: (gloves.left && gloves.left.snCode) || null,
        ip: (gloves.left && gloves.left.ip) || '192.168.1.100',
      },
      right: {
        connected: !!(gloves.right && gloves.right.connected),
        snCode: (gloves.right && gloves.right.snCode) || null,
        ip: (gloves.right && gloves.right.ip) || '192.168.1.101',
      },
    };

    // 统一观测项：手套(WG) + 灵巧手(WH2)，分别按左右手对账
    const KIND_LABEL = { glove: '手套', dexterous_hand: '灵巧手' };
    const items = [];
    for (const hand of ['left', 'right']) {
      const g = gloves[hand];
      items.push({ kind: 'glove', hand, connected: !!(g && g.connected), snCode: (g && g.snCode) || null });
      const h = dexHands && dexHands[hand];
      if (h) items.push({ kind: 'dexterous_hand', hand, connected: !!h.connected, snCode: h.snCode || null });
    }

    const [dbRows] = await pool.execute(
      "SELECT snCode, handType, equipmentType FROM sn_registry WHERE machineNumber = ? AND status = 'in_use'",
      [machineNumber]
    );
    const dbBound = { glove: { left: null, right: null }, dexterous_hand: { left: null, right: null } };
    for (const r of dbRows) {
      if (r.handType !== 'left' && r.handType !== 'right') continue;
      dbBound[_snKind(r)][r.handType] = r.snCode;
    }

    const observedSNs = [...new Set(items.map(i => i.snCode).filter(Boolean))];
    const snMap = Object.create(null);
    if (observedSNs.length) {
      const placeholders = observedSNs.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT snCode, equipmentType, handType, status, machineNumber FROM sn_registry WHERE snCode IN (${placeholders})`,
        observedSNs
      );
      for (const r of rows) snMap[r.snCode] = r;
    }

    const UNUSABLE = new Set(['damaged', 'transferred', 'shipped', 'repairing', 'waiting_repair', 'scrapped', 'in_repair']);

    for (const it of items) {
      const handLabel = it.hand === 'left' ? '左手' : '右手';
      const base = `${KIND_LABEL[it.kind]}${handLabel}`;

      if (it.connected) {
        if (!it.snCode) {
          alerts.push({ level: 'info', code: 'glove_no_sn', kind: it.kind, hand: it.hand, snCode: null, message: `${base}已连接但未能识别 SN 码` });
        } else {
          const rec = snMap[it.snCode];
          if (!rec) {
            alerts.push({ level: 'error', code: 'unregistered_sn', kind: it.kind, hand: it.hand, snCode: it.snCode, message: `${base} SN ${it.snCode} 未在 SN 注册表登记` });
          } else {
            if (rec.handType && rec.handType !== it.hand) {
              alerts.push({ level: 'error', code: 'hand_mismatch', kind: it.kind, hand: it.hand, snCode: it.snCode, message: `${handLabel}网口检测到 ${KIND_LABEL[it.kind]} SN ${it.snCode}，注册表记录为${rec.handType === 'left' ? '左' : '右'}手设备，疑似接反` });
            }
            if (UNUSABLE.has(rec.status)) {
              alerts.push({ level: 'error', code: 'sn_unusable', kind: it.kind, hand: it.hand, snCode: it.snCode, message: `${base} SN ${it.snCode} 当前状态为 ${rec.status}，不可投入使用` });
            } else if (rec.status === 'in_use' && rec.machineNumber && rec.machineNumber !== machineNumber) {
              alerts.push({ level: 'error', code: 'sn_bound_elsewhere', kind: it.kind, hand: it.hand, snCode: it.snCode, message: `${base} SN ${it.snCode} 已绑定在机器 ${rec.machineNumber}` });
            }
          }
        }
      }

      if (dbBound[it.kind][it.hand] && !it.connected) {
        alerts.push({ level: 'warn', code: 'bound_but_disconnected', kind: it.kind, hand: it.hand, snCode: dbBound[it.kind][it.hand], message: `系统记录 ${base} ${dbBound[it.kind][it.hand]} 绑定中，但未检测到设备连接` });
      }
    }

    if (collector && hasOwn(collector, 'importer') && collector.importer) {
      const importer = collector.importer;
      if (importer.reachable === false || (importer.endpointStatus && importer.endpointStatus.machine === false)) {
        alerts.push({
          level: 'warn',
          code: 'importer_unreachable',
          message: `Importer API 不可达${importer.error ? `：${importer.error}` : ''}`,
          details: {
            error: importer.error || null,
            endpointStatus: importer.endpointStatus || null,
            endpointErrors: importer.endpointErrors || null,
            checkedAt: importer.checkedAt || null,
          },
        });
      }
    }
    if (collector && hasOwn(collector, 'hermes') && collector.hermes) {
      const hermes = collector.hermes;
      const importer = collector.importer || {};
      const roleStatus = collector.containerRoleStatus || {};
      const hasRoleSnapshot = Object.keys(roleStatus).length > 0;
      const collectorInactive = importer.collectorAlive === false
        || importer.is_collector_alive === false
        || importer.health?.is_collector_alive === false
        || (hasRoleSnapshot && roleStatus.collector?.running !== true);
      if (hermes.reachable === false && !collectorInactive) {
        alerts.push({
          level: 'error',
          code: 'hermes_unreachable',
          message: `Hermes API 不可达${hermes.error ? `：${hermes.error}` : ''}`,
          details: {
            error: hermes.error || null,
            endpointStatus: hermes.endpointStatus || null,
            endpointErrors: hermes.endpointErrors || null,
            checkedAt: hermes.checkedAt || null,
          },
        });
      }
      const health = hermes.health || {};
      const wuji = collector.importer?.wuji || collector.wuji || {};
      const sdkGloves = wuji.gloves || {};
      const taskState = String(importer.task && importer.task.state || '').toLowerCase();
      const captureActive = !!(hermes.state && hermes.state.isRecording)
        || ['active', 'running', 'in_progress', 'recording'].includes(taskState);
      const degraded = (Array.isArray(health.degraded) ? health.degraded : []).filter(component => {
        // Wuji 手套连接由 Wuji SDK 单独判定；Hermes 的 gello/wuji_glove
        // degraded 常是容器初始化残留，不能作为机器异常依据。
        if (component === 'gello/wuji_glove_l' || component === 'gello/wuji_glove_r') return false;
        if (component === 'gello/wuji_glove_l' && (sdkGloves.left?.connected === true || sdkGloves.left?.healthy === true)) return false;
        if (component === 'gello/wuji_glove_r' && (sdkGloves.right?.connected === true || sdkGloves.right?.healthy === true)) return false;
        // These are advisory calibration conditions. They do not mean the
        // collector or its device stream is disconnected.
        if (component === 'calibration/camera_pairing') return false;
        // 手套帧管道只会在任务采集期间产出；待机时没有帧属于预期状态。
        if (!captureActive && component === 'pipeline/glove_frames') return false;
        return true;
      });
      const healthFresh = !hermes.endpointStatus || hermes.endpointStatus.health !== false;
      // all_connected=false 可能仅由手套校准状态触发；手套连接/数据流由 Wuji SDK
      // 单独确认，不能因为 calibration_mismatch 把整台机器标成异常。只有存在
      // 非手套降级部件，或明确的非手套组件故障时，才生成 collector_degraded。
      const nonGloveFault = Object.entries(health.components || {}).some(([name, item]) => {
        if (name === 'calibration/camera_pairing') return false;
        if (/gello\/wuji_glove_[lr]/i.test(name)) return false;
        if (!captureActive && name === 'pipeline/glove_frames') return false;
        return item && ['faulty', 'disconnected', 'degraded', 'error'].includes(String(item.status || '').toLowerCase());
      });
      if (!collectorInactive && hermes.reachable !== false && healthFresh && (degraded.length || (health.allConnected === false && nonGloveFault))) {
        // 组件降级 → 友好中文描述（gello/ 前缀才是左右手套在 Hermes health 中的实际 key）
        const DEVICE_NAMES = {
          'robot/wuji_glove_l': '设备手套L', 'robot/wuji_glove_r': '设备手套R',
          'gello/wuji_glove_l': '设备手套L', 'gello/wuji_glove_r': '设备手套R',
          'robot/wuji_hand_l': '设备灵巧手L', 'robot/wuji_hand_r': '设备灵巧手R',
          'quest/overlay': '设备Quest', 'gello/quest_controller': '设备Quest手柄',
          'robot/marvin': '设备机械臂',
        };
        const CAMERA_NAMES = {
          'vst_left': '头显左眼相机', 'vst_right': '头显右眼相机',
          'wrist_left': '左手腕相机', 'wrist_right': '右手腕相机',
          'overlay': '合成画面相机',
        };
        const mapped = [];
        for (const k of degraded) {
          let name = DEVICE_NAMES[k];
          if (!name) {
            const m = /^camera\/(.+)$/.exec(k);
            if (m) name = CAMERA_NAMES[m[1]] || `相机${m[1]}`;
          }
          if (name && !mapped.includes(name)) mapped.push(name);
        }
        const desc = mapped.length ? `${mapped.join('、')}连接断开` : '采集组件降级';
        const cameraStats = ((collector.cameraFps && collector.cameraFps.cameras) || [])
          .filter(camera => camera && (camera.isDropping || camera.status === 'error' || camera.status === 'dropping'))
          .map(camera => ({
            id: camera.cameraId || null,
            name: camera.name || camera.device || 'camera',
            fps: Number.isFinite(Number(camera.currentFPS)) ? Number(camera.currentFPS) : null,
            expectedFps: Number.isFinite(Number(camera.maxFPS)) ? Number(camera.maxFPS) : null,
            status: camera.status || null,
          }));
        alerts.push({
          level: 'error',
          code: 'collector_degraded',
          components: degraded,
          message: desc,
          details: {
            components: degraded,
            affectedComponents: mapped,
            cameras: cameraStats,
            collectorAlive: importer.collectorAlive ?? null,
            healthCheckedAt: hermes.checkedAt || null,
          },
        });
      }
      const state = hermes.state || {};
      const stateFresh = !hermes.endpointStatus || hermes.endpointStatus.state !== false;
      if (!collectorInactive && hermes.reachable !== false && stateFresh && state.emergencyStopped === true) {
        alerts.push({ level: 'error', code: 'emergency_stopped', message: '采集机处于急停状态，请现场确认' });
      }
      if (!collectorInactive && hermes.reachable !== false && stateFresh && state.healthSummary && state.healthSummary.recorder && state.healthSummary.recorder !== 'ready') {
        alerts.push({ level: 'warn', code: 'recorder_not_ready', message: `录制器状态为 ${state.healthSummary.recorder}` });
      }
      if (!collectorInactive && hermes.reachable !== false && stateFresh && ((Number(state.errorCount) || 0) > 0 || (Array.isArray(state.errors) && state.errors.length > 0))) {
        const errors = (Array.isArray(state.errors) && state.errors.length ? state.errors : (health.errors || []))
          .slice(0, 10)
          .map(error => typeof error === 'string' ? { message: error } : error);
        alerts.push({
          level: 'error',
          code: 'hermes_errors',
          message: `Hermes 当前有 ${Number(state.errorCount) || errors.length} 个错误`,
          details: {
            errorCount: Number(state.errorCount) || errors.length,
            errors,
            controlState: state.controlState || null,
            isRecording: !!state.isRecording,
            checkedAt: hermes.checkedAt || null,
          },
        });
      }
    }

    return { observed, alerts };
  }

  async function _autoTicket(machineNumber, alerts, prevData, heartbeatPayload) {
    const ticketed = (prevData && prevData.ticketedAlerts) || {};
    if (String(process.env.EDGE_AUTO_TICKET || 'on').toLowerCase() === 'off') {
      return ticketed;
    }
    if (typeof _createSystemTicket !== 'function') return ticketed;

    const enabled = _ticketEnabledCodes();
    const now = Date.now();
    const activeKeys = new Set();

    const environmentInfo = heartbeatPayload ? {
      hostname: heartbeatPayload.hostname || null,
      ipAddress: heartbeatPayload.ipAddress || null,
      agentVersion: heartbeatPayload.agentVersion || null,
      lastHeartbeat: new Date().toISOString(),
      cpuCount: (heartbeatPayload.host && heartbeatPayload.host.cpus) || null,
      totalMemory: (heartbeatPayload.host && heartbeatPayload.host.totalMemory) || null,
      freeMemory: (heartbeatPayload.host && heartbeatPayload.host.freeMemory) || null,
      platform: (heartbeatPayload.host && heartbeatPayload.host.platform) || null,
    } : null;

    const devices = (heartbeatPayload && heartbeatPayload.devices) || {};
    const deviceSnapshot = {
      leftGlove: !!(devices.gloves && devices.gloves.left && devices.gloves.left.connected),
      leftGloveSN: (devices.gloves && devices.gloves.left && devices.gloves.left.snCode) || null,
      rightGlove: !!(devices.gloves && devices.gloves.right && devices.gloves.right.connected),
      rightGloveSN: (devices.gloves && devices.gloves.right && devices.gloves.right.snCode) || null,
      leftDexterous: !!(devices.dexterousHands && devices.dexterousHands.left && devices.dexterousHands.left.connected),
      rightDexterous: !!(devices.dexterousHands && devices.dexterousHands.right && devices.dexterousHands.right.connected),
      roboticArm: !!(devices.roboticArm && devices.roboticArm.connected),
      quest: !!(heartbeatPayload.quest && heartbeatPayload.quest.connected),
      questBattery: (heartbeatPayload.quest && heartbeatPayload.quest.battery)
        ? (typeof heartbeatPayload.quest.battery === 'object' ? heartbeatPayload.quest.battery.level : heartbeatPayload.quest.battery)
        : null,
    };

    for (const a of alerts) {
      if (!a || !a.code || !enabled.has(a.code)) continue;
      const rule = TICKET_RULES[a.code];
      if (!rule) continue;
      const key = `${a.code}:${a.hand || ''}:${a.snCode || ''}`;
      activeKeys.add(key);

      const prev = ticketed[key];
      if (prev && prev.ticketId) continue;
      if (prev && prev.skippedAt && now - new Date(prev.skippedAt).getTime() < TICKET_RETRY_MS) continue;

      const diagnostics = {};
      const collectorAlert = new Set([
        'importer_unreachable', 'hermes_unreachable', 'collector_degraded',
        'emergency_stopped', 'recorder_not_ready', 'hermes_errors',
      ]).has(a.code);
      if (a.snCode) diagnostics.observedSN = a.snCode;
      if (a.hand) diagnostics.actualHand = a.hand;
      if (collectorAlert) {
        const importer = heartbeatPayload && heartbeatPayload.importer;
        const hermes = heartbeatPayload && heartbeatPayload.hermes;
        diagnostics.collector = {
          importer: importer ? {
            reachable: importer.reachable,
            endpointStatus: importer.endpointStatus || null,
            error: importer.error || null,
          } : null,
          hermes: hermes ? {
            reachable: hermes.reachable,
            version: hermes.version || null,
            endpointStatus: hermes.endpointStatus || null,
            health: hermes.health ? {
              allConnected: hermes.health.allConnected,
              degraded: hermes.health.degraded || [],
              errors: hermes.health.errors || [],
            } : null,
            state: hermes.state ? {
              controlState: hermes.state.controlState,
              isRecording: hermes.state.isRecording,
              emergencyStopped: hermes.state.emergencyStopped,
              errorCount: hermes.state.errorCount,
              errors: hermes.state.errors || [],
            } : null,
          } : null,
        };
      }

      if (a.code === 'hand_mismatch') {

        diagnostics.expectedHand = a.hand === 'left' ? 'right' : 'left';
        diagnostics.possibleCause = '手套网线接错端口，或标定文件中左右手标记错误';
        diagnostics.suggestedAction = '检查192.168.1.100(左手)和192.168.1.101(右手)的网线连接是否正确';
      } else if (a.code === 'sn_unusable') {

        diagnostics.deviceStatus = '不可用（damaged/transferred/shipped/repairing等）';
        diagnostics.possibleCause = '设备在系统中标记为不可用状态';
        diagnostics.suggestedAction = '检查设备实际状态，必要时在系统中更新设备状态';
      } else if (a.code === 'sn_bound_elsewhere') {

        diagnostics.possibleCause = '设备可能从其他机器移动过来，但系统中未更新绑定关系';
        diagnostics.suggestedAction = '确认设备实际位置，在系统中解绑原机器并重新绑定';
      } else if (a.code === 'unregistered_sn') {

        diagnostics.possibleCause = '新设备尚未入库登记，或SN码识别错误';
        diagnostics.suggestedAction = '在"SN码管理"中登记该设备，或检查标定文件中的SN是否正确';
      } else if (a.code === 'bound_but_disconnected') {

        diagnostics.registeredSN = a.snCode;
        diagnostics.possibleCause = '设备断电、网线松动、或设备故障';
        diagnostics.suggestedAction = '检查设备电源和网线连接，尝试重启设备';
      } else if (a.code === 'glove_no_sn') {

        diagnostics.possibleCause = '标定文件缺失、格式错误、或采集器容器未运行';
        diagnostics.suggestedAction = '检查/var/.rdc2/wuji_calib/目录是否存在标定文件，或检查importer-staging容器状态';
      } else if (a.code === 'importer_unreachable') {
        diagnostics.possibleCause = 'Importer 进程未运行、端口被占用、或本机服务网络异常';
        diagnostics.suggestedAction = '检查采集机 5025 端口和 Importer 服务日志';
      } else if (a.code === 'hermes_unreachable') {
        diagnostics.possibleCause = 'Hermes 进程未运行或 5006 端口暂不可用';
        diagnostics.suggestedAction = '检查 Hermes 主程序状态和 5006 端口';
      } else if (a.code === 'collector_degraded') {
        diagnostics.possibleCause = '摄像头、手套、Quest 或录制器组件未连接';
        diagnostics.suggestedAction = '根据降级组件名称检查对应设备连接和采集程序日志';
      } else if (a.code === 'emergency_stopped') {
        diagnostics.possibleCause = '现场触发急停或采集程序检测到急停信号';
        diagnostics.suggestedAction = '现场确认安全后按流程解除急停，不要远程绕过安全机制';
      } else if (a.code === 'recorder_not_ready') {
        diagnostics.possibleCause = '录制器仍在预热或初始化失败';
        diagnostics.suggestedAction = '等待录制器就绪，若持续异常则检查磁盘和 Hermes 日志';
      } else if (a.code === 'hermes_errors') {
        diagnostics.possibleCause = 'Hermes 当前报告一个或多个运行错误';
        diagnostics.suggestedAction = '查看 Hermes 错误列表和对应组件状态';
      }

      const alertContext = {
        firstDetected: a.firstDetectedAt || new Date().toISOString(),
        lastDetected: a.lastDetectedAt || new Date().toISOString(),
        occurrenceCount: Number(a.occurrenceCount) || 1,
        confirmed: a.confirmed === true,
        relatedAlerts: alerts.filter(x => x.code !== a.code).map(x => `${x.code}(${x.hand || '-'})`),
      };

      try {
        const r = await _createSystemTicket({
          machineNumber,
          equipmentType: collectorAlert ? 'collector' : 'glove',
          equipmentTypeName: collectorAlert ? '采集程序' : '手套',
          faultType: rule.faultType,
          faultDescription: a.message,
          priority: rule.priority,
          alertCode: a.code,
          diagnostics,
          deviceSnapshot,
          environmentInfo,
          alertContext,
        });
        const ts = new Date().toISOString();
        if (r && r.ok) {
          ticketed[key] = { ticketId: r.item.id, at: ts };
        } else {

          ticketed[key] = { skipped: true, reason: (r && r.reason) || 'unknown', existingId: (r && r.existingId) || null, skippedAt: ts };
        }
      } catch (e) {
        console.error(`[EDGE] 自动建单失败 ${machineNumber} ${a.code}:`, e.message);
      }
    }

    for (const key of Object.keys(ticketed)) {
      if (!activeKeys.has(key)) {
        console.log(`[EDGE] ${machineNumber} 告警恢复: ${key}（对应工单需人工确认完成）`);
        delete ticketed[key];
      }
    }
    return ticketed;
  }

  async function handleHeartbeat(req, res, body) {
    if (!authenticate(req, res)) return;
    const b = body || {};

    const machineNumber = String(b.machineNumber || '').trim().toLowerCase();
    if (!machineNumber) return sendJSON(res, { error: 'machineNumber 为必填' }, 400);

    let observed = {
      left: { connected: false, snCode: null, ip: '192.168.1.100' },
      right: { connected: false, snCode: null, ip: '192.168.1.101' },
    };
    let alerts = [];
    try {
      await autoBindObserved(machineNumber, b.devices || {});
    } catch (e) {
      console.error("[EDGE] 自动识别上架异常:", e.message);
    }
    try {
      const r = await reconcile(machineNumber, b.devices || {}, b);
      observed = r.observed;
      alerts = r.alerts;
    } catch (e) {
      console.error('[EDGE] reconcile 失败:', e.message);
      alerts.push({ level: 'warn', code: 'reconcile_failed', message: '服务端比对异常，请人工核查' });
    }

    const now = new Date().toISOString();

    let prev = null;
    try {
      const [rows] = await pool.execute('SELECT status, data FROM edge_hosts WHERE machineNumber = ?', [machineNumber]);
      prev = rows[0] || null;
    } catch {              }
    let prevData = {};
    try { prevData = JSON.parse((prev && prev.data) || '{}'); } catch {}

    const alertLifecycle = applyAlertLifecycle(alerts, prevData.alerts, now);
    alerts = alertLifecycle.alerts;

    let ticketedAlerts = {};
    try {
      // 自动工单只由已持续确认的告警触发；急停属于立即确认的安全告警。
      ticketedAlerts = await _autoTicket(machineNumber, alerts.filter(alert => alert.confirmed), prevData, b);
    } catch (e) {
      console.error('[EDGE] 自动工单流程异常:', e.message);
    }

    // 录制恢复 → 自动完成采集类自动工单（采集员自修后重新录制，无需运维人工关单）
    // 边沿触发：仅在上一次心跳"未录制"、本次"开始录制"时执行，避免每次心跳都查库
    try {
      const prevHermes = prevData && prevData.hermes;
      const prevRecording = !!(prevHermes && prevHermes.state && prevHermes.state.isRecording === true);
      const nowRecording = !!(b.hermes && b.hermes.state && b.hermes.state.isRecording === true);
      if (nowRecording && !prevRecording && typeof _autoTicketCompleter === 'function') {
        const r = await _autoTicketCompleter(machineNumber);
        if (r && r.closed > 0) {
          console.log(`[EDGE] ${machineNumber} 开始录制，自动完成 ${r.closed} 张采集故障工单`);
        }
      }
    } catch (e) {
      console.error('[EDGE] 录制恢复自动关单异常:', e.message);
    }

    const data = {
      observed,
      alerts,
      alertEvents: alertLifecycle.events,
      recoveredAlerts: alertLifecycle.events.filter(event => event.type === 'resolved').map(event => event.alert),
      ticketedAlerts,
      devices: b.devices || {},
      quest: b.quest || null,
      machineType: b.machineType || null,
      deviceSnapshotAt: b.deviceSnapshotAt || null,
      cameraFps: b.cameraFps || null,
      // 兼容首次采样尚未产生 cameraFps 的情况；三路设备列表仍保留在机器状态。
      cameras: Array.isArray(b.cameras) ? b.cameras : [],
      encoderFps: b.encoderFps || null,
      handStream: b.handStream || null,
      wuji: b.wuji || null,
      containers: Array.isArray(b.containers) ? b.containers : [],
      containerRoles: b.containerRoles || {},
      containerRoleStatus: b.containerRoleStatus || {},
      host: b.host || {},
      performance: b.performance || null,
      importer: b.importer || null,
      hermes: b.hermes || null,
    };

    try {
      await pool.execute(
        `INSERT INTO edge_hosts (machineNumber, hostname, ipAddress, agentVersion, status, lastSeen, data, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE hostname = VALUES(hostname), ipAddress = VALUES(ipAddress),
           agentVersion = VALUES(agentVersion), status = 'online', lastSeen = VALUES(lastSeen),
           data = VALUES(data), updatedAt = VALUES(updatedAt)`,
        [
          machineNumber,
          String(b.hostname || ''),
          String(b.ipAddress || ''),
          String(b.agentVersion || ''),
          now,
          JSON.stringify(data),
          now, now,
        ]
      );
    } catch (e) {
      console.error('[EDGE] 心跳落库失败:', e.message);
      return sendJSON(res, { error: '心跳落库失败' }, 500);
    }

    await _setRedisPresence(machineNumber, {
      machineNumber,
      ts: now,
      observed,
      alerts,
      alertEvents: alertLifecycle.events,
      importer: b.importer || null,
      hermes: b.hermes || null,
      performance: b.performance || null,
      containers: Array.isArray(b.containers) ? b.containers : [],
      containerRoles: b.containerRoles || {},
      containerRoleStatus: b.containerRoleStatus || {},
    });

    await _recordAlertEvents(machineNumber, alertLifecycle.events);

    let prevAlertFingerprints = [];
    try { prevAlertFingerprints = (JSON.parse((prev && prev.data) || '{}').alerts || []).map(alert => alert.fingerprint || alertFingerprint(alert)); } catch {}
    const becameOnline = !prev || prev.status !== 'online';
    const alertsChanged = JSON.stringify(prevAlertFingerprints.sort()) !== JSON.stringify(alerts.map(alert => alert.fingerprint).sort());
    if (becameOnline || alertsChanged || alertLifecycle.events.some(event => event.type === 'confirmed' || event.type === 'resolved')) {
      try { broadcastSSE('machine_presence_updated', { machineNumber, alertEvents: alertLifecycle.events }); } catch {}
    }

    sendJSON(res, { success: true, machineNumber, serverTime: now, observed, alerts });
  }

  async function handleOffline(req, res, body) {
    if (!authenticate(req, res)) return;
    const b = body || {};
    const machineNumber = String(b.machineNumber || '').trim().toLowerCase();
    if (!machineNumber) return sendJSON(res, { error: 'machineNumber 为必填' }, 400);

    const now = new Date().toISOString();
    try {
      await pool.execute(
        "UPDATE edge_hosts SET status = 'offline', updatedAt = ? WHERE machineNumber = ?",
        [now, machineNumber]
      );
    } catch (e) {
      console.error('[EDGE] 下线落库失败:', e.message);
      return sendJSON(res, { error: '下线落库失败' }, 500);
    }
    await _clearRedisPresence(machineNumber);
    try { broadcastSSE('machine_presence_updated', { machineNumber, offline: true }); } catch {}
    console.log(`[EDGE] 主机 ${machineNumber} 主动下线`);
    sendJSON(res, { success: true });
  }

  async function handleListHosts(req, res) {
    const [rows] = await pool.execute(
      'SELECT machineNumber, hostname, ipAddress, agentVersion, status, lastSeen, data, createdAt, updatedAt FROM edge_hosts ORDER BY updatedAt DESC'
    );
    const now = Date.now();
    const hosts = rows.map(r => {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      const online = r.status === 'online' && r.lastSeen &&
        (now - new Date(r.lastSeen).getTime() < PRESENCE_FRESH_MS);
      return {
        machineNumber: r.machineNumber,
        hostname: r.hostname || '',
        ipAddress: r.ipAddress || '',
        agentVersion: r.agentVersion || '',
        online,
        lastSeen: r.lastSeen || null,
        observedGloves: d.observed || null,
        alerts: Array.isArray(d.alerts) ? d.alerts : [],
        quest: d.quest || null,
        machineType: d.machineType || null,
        cameraFps: d.cameraFps || null,
        camerasFps: d.cameraFps && Array.isArray(d.cameraFps.cameras) ? d.cameraFps.cameras : (Array.isArray(d.cameras) ? d.cameras : []),
        cameras: Array.isArray(d.cameras) ? d.cameras : [],
        encoderFps: d.encoderFps || null,
        wuji: d.wuji || null,
        devicesNet: d.devices || null,
        handStream: d.handStream || null,
        host: d.host || {},
        importer: d.importer || null,
        hermes: d.hermes || null,
        updatedAt: r.updatedAt || null,
      };
    });
    sendJSON(res, hosts);
  }

  async function loadEdgePresence() {
    const map = Object.create(null);
    try {
      const [rows] = await pool.execute(
        'SELECT machineNumber, hostname, ipAddress, agentVersion, status, lastSeen, data FROM edge_hosts'
      );
      const now = Date.now();
      for (const r of rows) {
        let d = {};
        try { d = JSON.parse(r.data || '{}'); } catch {}
        const online = r.status === 'online' && r.lastSeen &&
          (now - new Date(r.lastSeen).getTime() < PRESENCE_FRESH_MS);
        map[r.machineNumber] = {
          hostOnline: online,
          hostLastSeen: r.lastSeen || null,
          hostIp: r.ipAddress || '',
          hostName: r.hostname || '',
          agentVersion: r.agentVersion || '',
          observedGloves: d.observed || null,
          edgeAlerts: Array.isArray(d.alerts) ? d.alerts : [],
          edgeQuest: d.quest || null,
          edgeDevices: d.devices || null,
          edgeDeviceSnapshotAt: d.deviceSnapshotAt || null,
          machineType: d.machineType || null,
          edgeCameraFps: d.cameraFps || null,
          edgeCameras: Array.isArray(d.cameras) ? d.cameras : [],
          edgeEncoderFps: d.encoderFps || null,
          edgeHandStream: d.handStream || null,
          edgeWuji: d.wuji || null,
          edgeContainers: Array.isArray(d.containers) ? d.containers : [],
          edgeContainerRoles: d.containerRoles || {},
          edgeContainerRoleStatus: d.containerRoleStatus || {},
          performance: d.performance || null,
          importer: d.importer || null,
          hermes: d.hermes || null,
        };
      }
    } catch {                                          }
    return map;
  }

  function startSweeper() {
    const timer = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - PRESENCE_FRESH_MS).toISOString();
        const [rows] = await pool.execute(
          "SELECT machineNumber FROM edge_hosts WHERE status = 'online' AND (lastSeen IS NULL OR lastSeen < ?)",
          [cutoff]
        );
        if (!rows.length) return;
        const now = new Date().toISOString();
        for (const r of rows) {
          await pool.execute(
            "UPDATE edge_hosts SET status = 'offline', updatedAt = ? WHERE machineNumber = ? AND status = 'online'",
            [now, r.machineNumber]
          );
          try { broadcastSSE('machine_presence_updated', { machineNumber: r.machineNumber, offline: true }); } catch {}
        }
        console.log(`[EDGE] 心跳超时，${rows.length} 台主机标记离线: ${rows.map(r => r.machineNumber).join(', ')}`);
      } catch (e) {
        console.error('[EDGE] sweeper 异常:', e.message);
      }
    }, SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    handleHeartbeat,
    handleOffline,
    handleListHosts,
    loadEdgePresence,
    startSweeper,
    setTicketCreator,
    setTicketCompleter,
  };
}

module.exports = createEdgeHandlers;
module.exports.alertFingerprint = alertFingerprint;
module.exports.applyAlertLifecycle = applyAlertLifecycle;
