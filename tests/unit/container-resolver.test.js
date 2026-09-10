'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ContainerResolver,
  isAllowedManagedContainerName,
  safeContainerName,
} = require('../../machine-heartbeat-agent/container-resolver');

function dockerMock(initialContainers = {}) {
  const containers = new Map(Object.entries(initialContainers));
  let nextId = 1;

  const execAsync = async command => {
    if (command.startsWith('docker inspect')) {
      const name = command.trim().split(/\s+/).pop();
      const row = containers.get(name);
      if (!row) throw new Error(`No such object: ${name}`);
      return {
        stdout: [
          row.id || `id-${nextId++}`,
          row.running === false ? 'false' : 'true',
          row.image || '',
          row.service || '',
          row.project || '',
        ].join('\t') + '\n',
      };
    }

    if (command.startsWith('docker ps --filter status=running')) {
      const rows = [];
      for (const [name, row] of containers) {
        if (row.running === false) continue;
        rows.push(JSON.stringify({
          Names: name,
          Image: row.image || '',
          Labels: row.labels || '',
        }));
      }
      return { stdout: rows.join('\n') };
    }

    throw new Error(`unexpected command: ${command}`);
  };

  return { containers, execAsync };
}

function resolver(containers, env = {}) {
  const mock = dockerMock(containers);
  return new ContainerResolver({
    env,
    execAsync: mock.execAsync,
    cacheTtlMs: 60_000,
    logger: { log() {}, warn() {} },
  });
}

test('container resolver: explicit environment container wins over staging candidate', async () => {
  const r = resolver({
    'importer-staging': { image: 'importer:staging' },
    'importer-preview': { image: 'importer:preview' },
  }, { IMPORTER_CONTAINER: 'importer-preview' });

  assert.equal(await r.resolve('importer'), 'importer-preview');
});

test('container resolver: automatically prefers running staging container', async () => {
  const r = resolver({
    'importer-staging': { image: 'importer:staging' },
    'importer-preview': { image: 'importer:preview' },
  });

  assert.equal(await r.resolve('importer'), 'importer-staging');
});

test('container resolver: falls back to preview when staging is absent', async () => {
  const r = resolver({
    'importer-preview': { image: 'importer:preview' },
  });

  assert.equal(await r.resolve('importer'), 'importer-preview');
});

test('container resolver: discovers dynamically named iris helper preview collector', async () => {
  const r = resolver({
    'aux-iris_helper-preview': { image: 'rdc-exodus:preview' },
  });

  assert.equal(await r.resolve('collector'), 'aux-iris_helper-preview');
});

test('container resolver: switches after cached container stops', async () => {
  const mock = dockerMock({
    'importer-staging': { id: 'old', image: 'importer:staging' },
    'importer-preview': { id: 'new', image: 'importer:preview', running: false },
  });
  const r = new ContainerResolver({
    env: {},
    execAsync: mock.execAsync,
    cacheTtlMs: 60_000,
    logger: { log() {}, warn() {} },
  });

  assert.equal(await r.resolve('importer'), 'importer-staging');
  mock.containers.get('importer-staging').running = false;
  mock.containers.get('importer-preview').running = true;
  assert.equal(await r.resolve('importer'), 'importer-preview');
});

test('container resolver: returns null when no matching container is running', async () => {
  const r = resolver({
    'unrelated-preview': { image: 'unrelated:preview' },
  });

  assert.equal(await r.resolve('importer'), null);
});

test('container resolver: rejects unsafe names and shell injection', () => {
  assert.equal(safeContainerName('importer-preview'), 'importer-preview');
  assert.equal(safeContainerName('importer-preview; touch /tmp/pwned'), '');
  assert.equal(safeContainerName('$(id)'), '');
  assert.equal(isAllowedManagedContainerName('aux-iris_helper-preview'), true);
  assert.equal(isAllowedManagedContainerName('importer-preview;id'), false);
  assert.equal(isAllowedManagedContainerName('random-preview'), false);
});
