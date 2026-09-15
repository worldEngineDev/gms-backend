'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createMachinesHandlers = require('../../src/handlers/machines');

test('operations center aggregates importer status and does not treat null size as zero', async () => {
  const originalFetch = global.fetch;
  const responses = {
    '/api/maintenance/health': { is_logged_in: true, idle_time_secs: 82, activity: 'running', version: '3.3.20' },
    '/api/config/task': { id: 'task-1', operator_id: 'operator-1', state: 'active', template: { name: 'Training task', is_training: true }, operator: { name: 'Xiaohui Lin', level: 1 } },
    '/api/config/machine': { misc: { machine_id: 'szx3-iris-105', computer_id: 'szx3-105' }, collector: { workflow: 'hermes', type: 'rdc-exodus' } },
    '/api/data/processing/workers/status': [{ name: 'nas_sync', busy: 1, pending: 2 }],
    '/api/data/processing/process_queue/status': { name: 'process_queue', busy: 1, pending: 3 },
    '/api/data/processing/overall': { workers: [], workflows: [{ name: 'hermes', busy: 1 }] },
    '/api/data/episodes/records': { items: [{ category: 'episode', episode_id: 'ep-1', occurred_at: 150, payload: { size_bytes: null } }] },
  };
  global.fetch = async url => {
    const parsed = new URL(url);
    const data = parsed.pathname === '/api/operations/overview'
      ? { attended_seconds: 3600, sessions: [{}], runs: [{}], attempts: {} }
      : responses[parsed.pathname];
    return { ok: true, json: async () => data };
  };

  let result;
  const handlers = createMachinesHandlers({
    pool: {},
    sendJSON: (res, body, status = 200) => { result = { body, status }; },
  });
  try {
    await handlers.handleGetOperationsCenter(
      { url: '/api/machines/szx3-105/operations-center?since=100&until=200' },
      {},
      {},
      'szx3-105',
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.login.loggedIn, true);
  assert.equal(result.body.machine.workflow, 'hermes');
  assert.equal(result.body.task.operator.id, 'operator-1');
  assert.equal(result.body.processing.queue.pending, 3);
  assert.equal(result.body.uploads.episodeCount, 1);
  assert.equal(result.body.uploads.sizeBytes, null);
  assert.equal(result.body.uploads.sizeKnown, false);
  assert.equal(result.body.sessions.attendedSeconds, 3600);
});
