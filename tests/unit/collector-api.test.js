'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CollectorApiPoller,
  normalizeImporterMachine,
  normalizeImporterTask,
  normalizeState,
} = require('../../machine-heartbeat-agent/collector-api');

test('collector adapter: normalizes Importer machine identity and excludes commands', () => {
  const result = normalizeImporterMachine({
    misc: { machine_id: 'szx3-001-hermes', computer_id: 'szx3-001' },
    collector: { type: 'rdc-exodus', workflow: 'hermes', aux: [{ command: 'secret command' }] },
    commander: { unit: 'hermes', gello: { wuji_glove_l: {}, wuji_glove_r: {} } },
    cameras: { overlay: { camera_source: 'quest' }, vst_left: { eye: 'left' } },
    storage: { format: { mcap_video: 'av1' } },
    vst: { fps: 60, width: 1280, height: 960 },
  });

  assert.equal(result.machineId, 'szx3-001-hermes');
  assert.equal(result.computerId, 'szx3-001');
  assert.deepEqual(result.gloveSlots, ['wuji_glove_l', 'wuji_glove_r']);
  assert.deepEqual(result.cameraIds, ['overlay', 'vst_left']);
  assert.equal(result.collectorType, 'rdc-exodus');
  assert.equal(result.cameras.overlay.cameraSource, 'quest');
  assert.equal(Object.hasOwn(result, 'aux'), false);
});

test('collector adapter: empty Importer task becomes null', () => {
  assert.equal(normalizeImporterTask({}), null);
  const task = normalizeImporterTask({
    id: 'task-1', state: 'active', hours: 4, hours_completed: 1,
    template: { name: 'internal', ref_name: '中文任务', steps: { payload: ['one', 'two'] }, is_training: false },
    operator: { name: 'Operator', level: 1, state: 'active' },
  });
  assert.equal(task.template.refName, '中文任务');
  assert.equal(task.template.stepCount, 2);
  assert.equal(task.operator.name, 'Operator');
});

test('collector adapter: flattens Hermes topic state while omitting high-frequency arrays', () => {
  const state = normalizeState({
    timestamp_posix: 123,
    robots: { robot_1: [
      { topic: 'control_state', data: 'RECORD' },
      { topic: 'is_recording', data: true },
      { topic: 'is_emergency_stopped', data: false },
      { topic: 'health/summary/recorder', data: 'ready' },
      { topic: 'quest/headset_connected', data: true },
      { topic: 'error_count', data: 0 },
      { topic: 'glove_left/joints', data: [1, 2, 3] },
    ] },
  });
  assert.equal(state.controlState, 'RECORD');
  assert.equal(state.isRecording, true);
  assert.equal(state.healthSummary.recorder, 'ready');
  assert.equal(state.quest.headsetConnected, true);
  assert.equal(Object.hasOwn(state, 'gloveLeftJoints'), false);
});

test('collector adapter: polls endpoints independently and preserves successful snapshots', async () => {
  const calls = [];
  const request = async url => {
    calls.push(url);
    if (url.endsWith('/api/config/machine')) return { body: { misc: { machine_id: 'm-1' } } };
    if (url.endsWith('/api/config/task')) throw new Error('task endpoint down');
    if (url.endsWith('/version')) return { body: { content: { version: '2.15.1' } } };
    if (url.endsWith('/health')) return { body: { status: 'ok', all_connected: true, degraded: [], errors: [], components: {} } };
    if (url.endsWith('/state')) return { body: { robots: { robot_1: [{ topic: 'control_state', data: 'ACTIVE' }] } } };
    if (url.endsWith('/sensors')) throw new Error('sensors endpoint down');
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new CollectorApiPoller({ request, importerUrl: 'http://importer:5025', hermesUrl: 'http://hermes:5006' });
  const first = await poller.poll();
  assert.equal(first.importer.reachable, true);
  assert.equal(first.importer.endpointStatus.task, false);
  assert.equal(first.importer.machineId, 'm-1');
  assert.equal(first.hermes.version, '2.15.1');
  assert.equal(first.hermes.state.controlState, 'ACTIVE');
  assert.equal(first.hermes.endpointStatus.sensors, false);
  assert.equal(calls.length, 7);
});
