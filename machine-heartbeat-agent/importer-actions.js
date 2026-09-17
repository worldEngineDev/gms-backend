'use strict';

// Agent-side allowlist for Importer maintenance operations. The backend sends
// only an action key and validated fields; arbitrary URLs and methods are never
// accepted by the Agent.
const ACTIONS = {
  collection_start: { method: 'GET', path: '/api/collection/runtime/start', fields: ['is_autopilot'], timeout: 120000 },
  collection_stop: { method: 'GET', path: '/api/collection/runtime/stop', fields: ['is_autopilot'], timeout: 120000 },
  clear_marvin_error: { method: 'GET', path: '/api/maintenance/robots/clear_marvin_error' },
  reset_piper_arm: { method: 'GET', path: '/api/maintenance/robots/reset_piper_arm', timeout: 60000 },
  container_start: { method: 'POST', path: '/api/maintenance/containers/start', fields: ['container_name'], timeout: 120000 },
  container_stop: { method: 'POST', path: '/api/maintenance/containers/stop', fields: ['container_name'], timeout: 60000 },
  container_kill: { method: 'POST', path: '/api/maintenance/containers/kill', fields: ['container_name'] },
  container_remove: { method: 'DELETE', path: '/api/maintenance/containers/remove', fields: ['container_name'] },
  containers_clear_all: { method: 'POST', path: '/api/maintenance/containers/clear_all', timeout: 120000 },
  tool_start: { method: 'POST', path: '/api/maintenance/tools/start', fields: ['name'], timeout: 60000 },
  tool_stop: { method: 'POST', path: '/api/maintenance/tools/stop', fields: ['name'], timeout: 60000 },
  tool_kill: { method: 'POST', path: '/api/maintenance/tools/kill', fields: ['name'] },
  tools_stop_all: { method: 'POST', path: '/api/maintenance/tools/stop_all', timeout: 60000 },
  maintenance_on: { method: 'POST', path: '/api/maintenance/admin/maintenance' },
  maintenance_off: { method: 'DELETE', path: '/api/maintenance/admin/maintenance' },
  disk_clean: { method: 'GET', path: '/api/maintenance/admin/disk/clean', timeout: 180000 },
  update_stage: { method: 'POST', path: '/api/maintenance/admin/update/request', fields: ['password', 'channel', 'override_config_channel', 'requested_by'] },
  update_confirm: { method: 'POST', path: '/api/maintenance/admin/update/confirm', fields: ['confirmed_by'], timeout: 60000 },
  update_cancel: { method: 'DELETE', path: '/api/maintenance/admin/update/request' },
  update_self: { method: 'POST', path: '/api/maintenance/admin/update_self', fields: ['password', 'channel', 'override_config_channel', 'requested_by'] },
  update_images: { method: 'POST', path: '/api/maintenance/admin/update_images', fields: ['password', 'channel', 'override_config_channel', 'requested_by'] },
  set_engine: { method: 'POST', path: '/api/maintenance/containers/engine', fields: ['engine'] },
  set_rig: { method: 'POST', path: '/api/maintenance/containers/rig', fields: ['rig'] },
  set_shape: { method: 'POST', path: '/api/maintenance/containers/shape', fields: ['shape'] },
  set_channel: { method: 'POST', path: '/api/maintenance/containers/channel', fields: ['channel'] },
  set_launch: { method: 'POST', path: '/api/maintenance/containers/launch', fields: ['engine', 'task', 'params'] },
  check_launch: { method: 'POST', path: '/api/maintenance/containers/launch/check', fields: ['engine', 'task', 'params'] },
};

function cleanPayload(action, input) {
  const payload = {};
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const field of action.fields || []) {
    if (Object.prototype.hasOwnProperty.call(source, field)) payload[field] = source[field];
  }
  for (const key of ['container_name', 'name']) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && !/^[a-zA-Z0-9_.-]{1,128}$/.test(String(payload[key]))) {
      throw new Error(`${key} 格式无效`);
    }
  }
  return payload;
}

async function executeImporterAction({ actionKey, input, importerUrl, fetchImpl = global.fetch }) {
  const action = ACTIONS[String(actionKey || '')];
  if (!action) throw new Error('操作不在 Agent 白名单内');
  if (typeof fetchImpl !== 'function') throw new Error('Agent 运行时不支持 fetch');
  const payload = cleanPayload(action, input);
  let path = action.path;
  if (actionKey === 'collection_start' || actionKey === 'collection_stop') {
    path += `?is_autopilot=${payload.is_autopilot === true ? 'true' : 'false'}`;
    delete payload.is_autopilot;
  }
  const hasBody = !['GET', 'HEAD'].includes(action.method);
  const response = await fetchImpl(`${String(importerUrl || '').replace(/\/$/, '')}${path}`, {
    method: action.method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: hasBody ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(action.timeout || 30000),
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; }
  catch { result = { message: text }; }
  if (!response.ok) {
    const detail = result && (result.detail || result.error || result.message);
    throw new Error(typeof detail === 'string' ? detail : `Importer HTTP ${response.status}`);
  }
  if (result && (result.ok === false || result.success === false)) {
    const detail = result.error || result.message || result.output;
    throw new Error(typeof detail === 'string' && detail ? detail : 'Importer 操作未成功');
  }
  return { action: actionKey, method: action.method, path, result };
}

module.exports = { ACTIONS, cleanPayload, executeImporterAction };
