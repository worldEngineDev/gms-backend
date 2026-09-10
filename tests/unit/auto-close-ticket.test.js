/**
 * tests/unit/auto-close-ticket.test.js
 * 录制恢复自动关单：autoCompleteCollectorTickets 筛选逻辑
 *
 * 覆盖：
 * 1. 只关闭 autoCreated=true 且 alertCode 属于采集组件类的未完成工单
 * 2. 人工工单 / SN 绑定类自动工单不自动关闭
 * 3. 已完成的工单不重复关闭
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const createTechSupportHandlers = require('../../src/handlers/tech-support');

function makeTicket(overrides = {}) {
  const now = new Date().toISOString();
  return Object.assign({
    id: 'ts-test',
    submitterId: 'sa-002',
    submitterName: '系统监控（边缘代理）（系统自动）',
    machineNumber: 'we-101',
    faultType: '采集组件降级',
    faultDescription: '【系统自动检测】we-101 设备手套L连接断开',
    status: 'pending',
    submittedAt: now,
    autoCreated: true,
    alertCode: 'collector_degraded',
    source: 'edge_agent',
  }, overrides);
}

test('autoCompleteCollectorTickets: 只关闭自动创建的采集类工单', async t => {
  const saved = [];
  const now = new Date().toISOString();
  const collectorTicket = makeTicket({ id: 'ts-a1', alertCode: 'collector_degraded' });
  const snTicket = makeTicket({ id: 'ts-a2', alertCode: 'hand_mismatch' });            // 自动但非采集类 → 不关
  const manualTicket = Object.assign(makeTicket(), { id: 'ts-a3', autoCreated: false }); // 人工单 → 不关
  const doneTicket = makeTicket({ id: 'ts-a4', alertCode: 'collector_degraded', status: 'completed', completedAt: now }); // 已完成 → 不关

  const pool = {
    async execute(sql, params) {
      if (/FROM tech_support/.test(sql)) {
        return [[
          { id: collectorTicket.id, data: JSON.stringify(collectorTicket) },
          { id: snTicket.id, data: JSON.stringify(snTicket) },
          { id: manualTicket.id, data: JSON.stringify(manualTicket) },
          { id: doneTicket.id, data: JSON.stringify(doneTicket) },
        ]];
      }
      if (/FROM sn_registry/.test(sql)) return [[]];
      if (/FROM machines/.test(sql)) return [[]];
      return [[]];
    },
  };
  const handlers = createTechSupportHandlers({
    pool,
    sendJSON: () => {},
    _cached: () => Promise.resolve([]),
    readJSONById: () => null,
    deleteJSON: () => {},
    saveMachine: () => {},
    saveTechSupport: async (id, obj) => saved.push({ id, obj }),
    _syncInventoryFromSN: () => {},
    broadcastChange: () => {},
    realtime: {},
    feishu: {},
    fmtDuration: () => '',
  });

  const r = await handlers.autoCompleteCollectorTickets('we-101');
  assert.strictEqual(r.closed, 1, '只应关闭 1 张采集类自动工单');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].id, 'ts-a1');
  assert.strictEqual(saved[0].obj.status, 'completed');
  assert.ok(saved[0].obj.completedAt, '应记录完成时间');
  assert.strictEqual(saved[0].obj.autoCompletedBy, 'edge_agent_recording');
});

test('autoCompleteCollectorTickets: 无机器编号或空结果时不报错', async () => {
  const pool = {
    async execute(sql) {
      if (/FROM tech_support/.test(sql)) return [[]];
      return [[]];
    },
  };
  const handlers = createTechSupportHandlers({
    pool,
    sendJSON: () => {},
    _cached: () => Promise.resolve([]),
    readJSONById: () => null,
    deleteJSON: () => {},
    saveMachine: () => {},
    saveTechSupport: async () => {},
    _syncInventoryFromSN: () => {},
    broadcastChange: () => {},
    realtime: {},
    feishu: {},
    fmtDuration: () => '',
  });

  assert.deepEqual(await handlers.autoCompleteCollectorTickets(''), { closed: 0 });
  assert.deepEqual(await handlers.autoCompleteCollectorTickets('we-102'), { closed: 0 });
});
