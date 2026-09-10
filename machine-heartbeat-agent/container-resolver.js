const { exec } = require('child_process');
const { promisify } = require('util');

const defaultExecAsync = promisify(exec);

const CONTAINER_CANDIDATES = {
  importer: ['importer-staging', 'importer-preview', 'importer-production'],
  collector: [
    'mono-staging',
    'main-preview',
    'world-preview',
    'aux-iris_helper-preview',
    'mono-production',
  ],
  exodus: ['exodus-staging', 'aux-exodus-preview', 'exodus-preview', 'exodus-production'],
};

const ROLE_ENV_KEYS = {
  importer: 'IMPORTER_CONTAINER',
  collector: 'COLLECTOR_CONTAINER',
  exodus: 'EXODUS_CONTAINER',
};

const ROLE_LABELS = {
  importer: ['importer'],
  collector: ['mono', 'main', 'world', 'iris_helper', 'iris-helper', 'collector', 'rdc'],
  exodus: ['exodus'],
};

function safeContainerName(name) {
  const value = String(name || '').trim();
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : '';
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function explicitContainerForRole(role, env = process.env) {
  const key = ROLE_ENV_KEYS[role];
  if (!key) return '';
  return safeContainerName(env[key]);
}

function candidateContainers(role, env = process.env) {
  return uniq([
    explicitContainerForRole(role, env),
    ...(CONTAINER_CANDIDATES[role] || []),
  ]);
}

function imageBase(image) {
  return String(image || '').toLowerCase().split('/').pop() || '';
}

function textOf(row) {
  return [
    row && row.name,
    row && row.image,
    row && row.service,
    row && row.project,
    row && row.labels,
  ].filter(Boolean).join(' ').toLowerCase();
}

function hasStageMarker(row) {
  const text = textOf(row);
  return /(^|[-_:.=])(?:staging|preview|production|prod)(?:$|[-_:.=])/.test(text);
}

function lifecycleRank(row) {
  const text = textOf(row);
  if (/(^|[-_:.=])staging(?:$|[-_:.=])/.test(text) || /:staging(?:$|[-_.])/.test(text)) return 0;
  if (/(^|[-_:.=])preview(?:$|[-_:.=])/.test(text) || /:preview(?:$|[-_.])/.test(text)) return 1;
  if (/(^|[-_:.=])(?:production|prod)(?:$|[-_:.=])/.test(text) || /:(?:production|prod)(?:$|[-_.])/.test(text)) return 2;
  return 3;
}

function nameHasToken(name, tokens) {
  const lower = String(name || '').toLowerCase();
  return tokens.some(token => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[-_.])${escaped}($|[-_.])`).test(lower);
  });
}

function labelHasToken(row, tokens) {
  const text = [row && row.service, row && row.project, row && row.labels]
    .filter(Boolean).join(' ').toLowerCase();
  return tokens.some(token => text.includes(token));
}

function roleMatchesContainer(role, row) {
  if (!row || !safeContainerName(row.name)) return false;

  const name = String(row.name || '').toLowerCase();
  const base = imageBase(row.image);
  const labels = ROLE_LABELS[role] || [];

  if (role === 'importer') {
    return name.includes('importer') || base.includes('importer') || labelHasToken(row, labels);
  }

  if (role === 'collector') {
    return nameHasToken(name, labels)
      || base.includes('rdc-exodus')
      || base.includes('collector')
      || labelHasToken(row, labels);
  }

  if (role === 'exodus') {
    // rdc-exodus is the collector image, not the exodus control container.
    return nameHasToken(name, labels)
      || base === 'exodus'
      || base.startsWith('exodus:')
      || labelHasToken(row, labels);
  }

  return false;
}

function allowedManagedRoleForName(name) {
  const safe = safeContainerName(name);
  if (!safe) return null;
  if (safe === 'gms-heartbeat-agent') return 'agent';
  if (!hasStageMarker({ name: safe })) return null;
  for (const role of Object.keys(CONTAINER_CANDIDATES)) {
    if (roleMatchesContainer(role, { name: safe, image: '', labels: '' })) return role;
  }
  return null;
}

function isAllowedManagedContainerName(name) {
  return !!allowedManagedRoleForName(name);
}

class ContainerResolver {
  constructor(options = {}) {
    this.execAsync = options.execAsync || defaultExecAsync;
    this.env = options.env || process.env;
    this.logger = options.logger || console;
    this.cacheTtlMs = Number.isFinite(options.cacheTtlMs)
      ? options.cacheTtlMs
      : Math.max(1000, parseInt(this.env.CONTAINER_CACHE_TTL_MS || '30000', 10));
    this.inspectTimeoutMs = options.inspectTimeoutMs || 3000;
    this.psTimeoutMs = options.psTimeoutMs || 5000;
    this.now = options.now || (() => Date.now());
    this.cache = {};
    this.lastLogged = {};
  }

  clear(role) {
    if (role) delete this.cache[role];
    else this.cache = {};
  }

  async inspectContainer(name) {
    const safe = safeContainerName(name);
    if (!safe) return null;
    try {
      const template = [
        '{{.Id}}',
        '{{.State.Running}}',
        '{{.Config.Image}}',
        '{{if .Config.Labels}}{{index .Config.Labels "com.docker.compose.service"}}{{end}}',
        '{{if .Config.Labels}}{{index .Config.Labels "com.docker.compose.project"}}{{end}}',
      ].join('\t');
      const { stdout } = await this.execAsync(
        `docker inspect -f '${template}' ${safe}`,
        { timeout: this.inspectTimeoutMs }
      );
      const line = String(stdout || '').trim().split('\n')[0] || '';
      if (!line) return null;
      const [id, running, image, service, project] = line.split('\t');
      return {
        name: safe,
        id: id || null,
        running: String(running).trim() === 'true',
        image: image || '',
        service: service || '',
        project: project || '',
        labels: '',
      };
    } catch (error) {
      return null;
    }
  }

  parseDockerPsJSON(stdout) {
    const rows = [];
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        const names = String(row.Names || row.Name || '').split(',').map(s => s.trim());
        for (const name of names) {
          const safe = safeContainerName(name);
          if (!safe) continue;
          rows.push({
            name: safe,
            image: row.Image || '',
            labels: row.Labels || '',
            service: '',
            project: '',
          });
        }
      } catch { }
    }
    return rows;
  }

  parseDockerPsTable(stdout) {
    const rows = [];
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, image, labels] = trimmed.split('\t');
      const safe = safeContainerName(name);
      if (!safe) continue;
      rows.push({ name: safe, image: image || '', labels: labels || '', service: '', project: '' });
    }
    return rows;
  }

  async listRunningContainers() {
    try {
      const { stdout } = await this.execAsync(
        "docker ps --filter status=running --format '{{json .}}'",
        { timeout: this.psTimeoutMs, maxBuffer: 1024 * 1024 }
      );
      const rows = this.parseDockerPsJSON(stdout);
      if (rows.length) return rows;
    } catch { }

    try {
      const { stdout } = await this.execAsync(
        "docker ps --filter status=running --format '{{.Names}}\\t{{.Image}}\\t{{.Labels}}'",
        { timeout: this.psTimeoutMs, maxBuffer: 1024 * 1024 }
      );
      return this.parseDockerPsTable(stdout);
    } catch {
      return [];
    }
  }

  async resolve(role, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(CONTAINER_CANDIDATES, role)) return null;
    if (options.force) this.clear(role);

    // Explicit role configuration is authoritative. Check it before the cache
    // so an operator can switch preview/staging containers without restarting
    // the agent or waiting for the cache TTL to expire.
    const envKey = ROLE_ENV_KEYS[role];
    const rawExplicit = envKey ? this.env[envKey] : '';
    const explicit = explicitContainerForRole(role, this.env);
    if (explicit) {
      const inspected = await this.inspectContainer(explicit);
      if (inspected && inspected.running && roleMatchesContainer(role, inspected)) {
        return this.remember(role, inspected, 'env');
      }
      if (inspected && inspected.running) {
        this.logMiss(role, `显式容器 ${explicit} 不像 ${role} 角色，已忽略`);
      } else {
        this.logMiss(role, `显式容器 ${explicit} 未运行，继续自动发现`);
      }
      this.clear(role);
    } else if (envKey && rawExplicit) {
      this.logMiss(role, `${ROLE_ENV_KEYS[role]} 容器名不安全，已忽略`);
    }

    const cached = this.cache[role];
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      const inspected = await this.inspectContainer(cached.name);
      if (inspected && inspected.running) {
        this.cache[role] = { ...inspected, at: this.now() };
        this.logResolution(role, inspected, inspected.id === cached.id ? 'cache' : 'cache-refresh');
        return inspected.name;
      }
      this.clear(role);
      this.logMiss(role, `缓存容器 ${cached.name} 已停止或不存在，重新发现`);
    }

    const fixed = candidateContainers(role, this.env).filter(name => name !== explicit);
    for (const name of fixed) {
      const inspected = await this.inspectContainer(name);
      if (inspected && inspected.running) {
        return this.remember(role, inspected, 'fixed');
      }
    }

    const fixedSet = new Set(fixed);
    const running = await this.listRunningContainers();
    const dynamic = running
      .filter(row => !fixedSet.has(row.name))
      .filter(row => roleMatchesContainer(role, row))
      .sort((a, b) => {
        const la = lifecycleRank(a);
        const lb = lifecycleRank(b);
        if (la !== lb) return la - lb;
        return a.name.localeCompare(b.name);
      });

    for (const row of dynamic) {
      const inspected = await this.inspectContainer(row.name);
      if (inspected && inspected.running && roleMatchesContainer(role, { ...row, ...inspected })) {
        return this.remember(role, { ...row, ...inspected }, 'dynamic');
      }
    }

    this.clear(role);
    this.logMiss(role, '未找到运行中的候选容器');
    return null;
  }

  remember(role, row, source) {
    const value = {
      name: row.name,
      id: row.id || null,
      image: row.image || '',
      service: row.service || '',
      project: row.project || '',
      at: this.now(),
    };
    this.cache[role] = value;
    this.logResolution(role, value, source);
    return value.name;
  }

  logResolution(role, row, source) {
    const key = `${row.name}|${row.id || ''}|${source}`;
    if (this.lastLogged[role] === key) return;
    this.lastLogged[role] = key;
    const image = row.image ? ` image=${row.image}` : '';
    this.logger.log(`[ContainerResolver] ${role} -> ${row.name} (${source}${image})`);
  }

  logMiss(role, reason) {
    const key = `miss|${reason}`;
    if (this.lastLogged[role] === key) return;
    this.lastLogged[role] = key;
    const log = this.logger.warn || this.logger.log;
    log.call(this.logger, `[ContainerResolver] ${role}: ${reason}`);
  }
}

function createContainerResolver(options = {}) {
  return new ContainerResolver(options);
}

module.exports = {
  CONTAINER_CANDIDATES,
  ContainerResolver,
  allowedManagedRoleForName,
  candidateContainers,
  createContainerResolver,
  isAllowedManagedContainerName,
  lifecycleRank,
  roleMatchesContainer,
  safeContainerName,
};
