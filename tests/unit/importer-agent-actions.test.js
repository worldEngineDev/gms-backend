'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeImporterAction } = require('../../machine-heartbeat-agent/importer-actions');

test('Agent importer action allowlist maps start to the local Importer API', async () => {
  let request;
  const output = await executeImporterAction({
    actionKey: 'collection_start',
    input: { is_autopilot: true, unexpected: 'drop-me' },
    importerUrl: 'http://127.0.0.1:5025/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, text: async () => JSON.stringify({ message: 'started' }) };
    },
  });
  assert.equal(request.url, 'http://127.0.0.1:5025/api/collection/runtime/start?is_autopilot=true');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.body, undefined);
  assert.equal(output.result.message, 'started');
});

test('Agent importer action forwards only allowed fields and rejects arbitrary actions', async () => {
  let request;
  await executeImporterAction({
    actionKey: 'container_start',
    input: { container_name: 'main-preview', command: 'rm -rf /' },
    importerUrl: 'http://127.0.0.1:5025',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, text: async () => '{}' };
    },
  });
  assert.deepEqual(JSON.parse(request.options.body), { container_name: 'main-preview' });
  await assert.rejects(
    executeImporterAction({ actionKey: 'arbitrary_url', importerUrl: 'http://127.0.0.1:5025', fetchImpl: async () => ({}) }),
    /白名单/
  );
});

test('Agent importer action surfaces Importer errors', async () => {
  await assert.rejects(
    executeImporterAction({
      actionKey: 'disk_clean',
      importerUrl: 'http://127.0.0.1:5025',
      fetchImpl: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ detail: 'busy' }) }),
    }),
    /busy/
  );
  await assert.rejects(
    executeImporterAction({
      actionKey: 'check_launch',
      importerUrl: 'http://127.0.0.1:5025',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, output: 'invalid config' }) }),
    }),
    /invalid config/
  );
});
