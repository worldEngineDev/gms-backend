'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createMachinesHandlers = require('../../src/handlers/machines');

test('operations user cannot access machine status center endpoints', async () => {
  const responses = [];
  const handlers = createMachinesHandlers({
    pool: {},
    sendJSON: (_res, body, status = 200) => responses.push({ body, status }),
  });
  const user = { system: 'operations', role: 'user' };

  await handlers.handleGetMachineInfo({ url: '/' }, {}, user, 'we-105');
  await handlers.handleGetOperationsCenter({ url: '/' }, {}, user, 'we-105');
  await handlers.handleGetProductionHistory({ url: '/api/machines/production-history' }, {}, user);
  await handlers.handleGetStatusTimeline({ url: '/' }, {}, user, 'we-105');
  await handlers.handleSetProductionStatus({ url: '/' }, {}, user, { machineNumber: 'we-105', status: 'ready' });
  await handlers.handleGetMachineLive({ on() {} }, {}, user, 'we-105');
  await handlers.handleGetImporterConsole({ url: '/?section=collection' }, {}, user, 'we-105');

  assert.equal(responses.length, 7);
  for (const response of responses) {
    assert.equal(response.status, 403);
    assert.equal(response.body.error, '仅运营管理员可查看机器状态中心');
  }
});

test('only maintenance admins can run importer actions and secrets are not audited', async () => {
  const originalFetch = global.fetch;
  const originalEdgeToken = process.env.EDGE_TOKEN;
  process.env.EDGE_TOKEN = 'test-edge-token';
  const responses = [];
  const audits = [];
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true, executionChannel: 'agent-importer-api', result: { message: 'scheduled' } }),
    };
  };
  const handlers = createMachinesHandlers({
    pool: {},
    sendJSON: (_res, body, status = 200) => responses.push({ body, status }),
    saveJSON: async (_table, _id, value) => audits.push(value),
    broadcastChange: () => {},
  });
  try {
    await handlers.handleImporterAction({}, {}, { system: 'operations', role: 'admin' }, 'we-105', {
      action: 'disk_clean', payload: {},
    });
    await handlers.handleImporterAction({}, {}, { system: 'maintenance', role: 'user' }, 'we-105', {
      action: 'disk_clean', payload: {},
    });
    await handlers.handleImporterAction({}, {}, { system: 'maintenance', role: 'admin', username: 'maint', userId: 'u1' }, 'we-105', {
      action: 'update_stage', payload: { password: 'fleet-secret', channel: 'preview' },
    });
  } finally {
    global.fetch = originalFetch;
    if (originalEdgeToken === undefined) delete process.env.EDGE_TOKEN;
    else process.env.EDGE_TOKEN = originalEdgeToken;
  }

  assert.equal(responses[0].status, 403);
  assert.equal(responses[1].status, 403);
  assert.equal(responses[2].status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://10.5.51.105:3000/importer-action');
  assert.equal(requests[0].options.headers['x-edge-token'], 'test-edge-token');
  const agentBody = JSON.parse(requests[0].options.body);
  assert.equal(agentBody.action, 'update_stage');
  assert.equal(agentBody.payload.requested_by, 'maint');
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits[0]).includes('fleet-secret'), false);
});

test('status center uses current Importer conditions and warnings do not block collection', async () => {
  const originalFetch = global.fetch;
  let result;
  global.fetch = async url => {
    const parsed = new URL(url);
    let body;
    if (parsed.pathname === '/api/maintenance/health') {
      const critical = parsed.hostname.endsWith('.18');
      body = {
        version: '3.3.45', activity: 'running', is_collector_alive: true,
        machine_config: { misc: { machine_id: critical ? 'szx3-018' : 'szx3-105' }, collector: { type: 'rdc-exodus', workflow: 'hermes' } },
        collector_info: { info: { preconditions_ok: true, commander_state: 'ACTIVE', condition_levels: critical ? {
          'camera/ego_camera': { ok: false, severity: 'critical', status: 'missing' },
        } : {
          'pipeline/glove_frames': { ok: false, severity: 'warning', status: 'missing' },
        } } },
      };
    } else if (parsed.pathname.endsWith('/process_queue/status')) body = { busy: 1, pending: 2, utilization_percent: 3 };
    else body = { status: 'pass', episode_id: 'ep-1' };
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const handlers = createMachinesHandlers({
    pool: { execute: async sql => [sql.includes('edge_hosts') ? [{ machineNumber: 'we-018' }] : [{ machineNumber: 'we-105' }]] },
    sendJSON: (_res, body, status = 200) => { result = { body, status }; },
  });
  try {
    await handlers.handleGetStatusCenterLive({}, {}, { system: 'operations', role: 'admin' });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.machines['we-105'].canCollect, true);
  assert.equal(result.body.machines['we-105'].warnings.length, 1);
  assert.equal(result.body.machines['we-105'].blockers.length, 0);
  assert.equal(result.body.machines['we-018'].canCollect, false);
  assert.equal(result.body.machines['we-018'].blockers[0].id, 'camera/ego_camera');
});
