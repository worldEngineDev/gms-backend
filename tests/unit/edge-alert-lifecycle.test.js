'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edge = require('../../src/handlers/edge');

test('alert lifecycle confirms a persistent non-emergency alert on its second heartbeat', () => {
  const first = edge.applyAlertLifecycle([
    { level: 'error', code: 'collector_degraded', components: ['camera/wrist_left'] },
  ], [], '2026-09-16T00:00:00.000Z');

  assert.equal(first.alerts[0].confirmed, false);
  assert.equal(first.alerts[0].occurrenceCount, 1);
  assert.deepEqual(first.events.map(event => event.type), ['raised']);

  const second = edge.applyAlertLifecycle([
    { level: 'error', code: 'collector_degraded', components: ['camera/wrist_left'] },
  ], first.alerts, '2026-09-16T00:00:30.000Z');

  assert.equal(second.alerts[0].confirmed, true);
  assert.equal(second.alerts[0].occurrenceCount, 2);
  assert.equal(second.alerts[0].firstDetectedAt, '2026-09-16T00:00:00.000Z');
  assert.deepEqual(second.events.map(event => event.type), ['confirmed']);
});

test('emergency stop is confirmed immediately and emits a resolution event with duration', () => {
  const raised = edge.applyAlertLifecycle([
    { level: 'error', code: 'emergency_stopped' },
  ], [], '2026-09-16T00:00:00.000Z');

  assert.equal(raised.alerts[0].confirmed, true);

  const resolved = edge.applyAlertLifecycle([], raised.alerts, '2026-09-16T00:02:05.000Z');
  assert.equal(resolved.events.length, 1);
  assert.equal(resolved.events[0].type, 'resolved');
  assert.equal(resolved.events[0].alert.durationSec, 125);
});

test('fingerprints change when the affected collector component changes', () => {
  const camera = edge.alertFingerprint({ code: 'collector_degraded', components: ['camera/wrist_left'] });
  const quest = edge.alertFingerprint({ code: 'collector_degraded', components: ['quest/overlay'] });
  assert.notEqual(camera, quest);
});
