'use strict';

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}${path}`;
}

function stringOrNull(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error || '请求失败').slice(0, 240);
}

function normalizeImporterMachine(config) {
  const source = config && typeof config === 'object' ? config : {};
  const misc = source.misc || {};
  const collector = source.collector || {};
  const commander = source.commander || {};
  const storage = source.storage || {};
  const cameras = source.cameras && typeof source.cameras === 'object' ? source.cameras : {};
  const gello = commander.gello && typeof commander.gello === 'object' ? commander.gello : {};
  const robots = source.robot && typeof source.robot === 'object' ? source.robot : {};
  const machineId = stringOrNull(misc.machine_id);
  const configNames = [...Object.keys(gello), ...Object.keys(robots)];
  const machineType = String(commander.unit || '').toLowerCase() === 'iris'
    || /iris/i.test(machineId || '')
    || configNames.some(name => /wuji_hand|marvin|dexterous/i.test(name))
    ? 'dexterous'
    : configNames.some(name => /wuji_glove|glove/i.test(name)) ? 'glove_only' : null;

  return {
    machineId,
    machineType,
    computerId: stringOrNull(misc.computer_id),
    collectorType: stringOrNull(collector.type),
    workflow: stringOrNull(collector.workflow),
    commanderUnit: stringOrNull(commander.unit),
    gloveSlots: Object.keys(gello),
    robotSlots: Object.keys(robots),
    cameraIds: Object.keys(cameras),
    cameras: Object.fromEntries(Object.entries(cameras).map(([id, value]) => {
      const item = value && typeof value === 'object' ? value : {};
      return [id, {
        type: stringOrNull(item.type),
        eye: stringOrNull(item.eye),
        cameraSource: stringOrNull(item.camera_source),
        egoCamera: stringOrNull(item.ego_camera),
        questIp: stringOrNull(item.quest_ip),
      }];
    })),
    storageFormat: storage.format && typeof storage.format === 'object' ? storage.format : null,
    vst: source.vst && typeof source.vst === 'object' ? {
      fps: numberOrNull(source.vst.fps),
      width: numberOrNull(source.vst.width),
      height: numberOrNull(source.vst.height),
      path: stringOrNull(source.vst.path),
    } : null,
  };
}

function normalizeImporterTask(task) {
  if (!task || typeof task !== 'object' || Object.keys(task).length === 0) return null;
  const template = task.template && typeof task.template === 'object' ? task.template : {};
  const operator = task.operator && typeof task.operator === 'object' ? task.operator : {};
  const steps = template.steps && Array.isArray(template.steps.payload) ? template.steps.payload : [];

  return {
    id: stringOrNull(task.id),
    state: stringOrNull(task.state),
    hours: numberOrNull(task.hours),
    hoursCompleted: numberOrNull(task.hours_completed),
    createTime: stringOrNull(task.create_time),
    endTime: stringOrNull(task.end_time),
    template: {
      id: stringOrNull(template.id || task.template_id),
      name: stringOrNull(template.name),
      refName: stringOrNull(template.ref_name),
      description: stringOrNull(template.description),
      hoursTarget: numberOrNull(template.hours_target),
      isTraining: typeof template.is_training === 'boolean' ? template.is_training : null,
      stepCount: steps.length,
      verbs: Array.isArray(template.verbs) ? template.verbs : [],
      objects: Array.isArray(template.objects) ? template.objects : [],
    },
    operator: {
      id: stringOrNull(operator.id || task.operator_id),
      name: stringOrNull(operator.localized_name || operator.name),
      level: numberOrNull(operator.level),
      state: stringOrNull(operator.state),
    },
  };
}

function normalizeVersion(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return stringOrNull(source.content && source.content.version);
}

function normalizeHealth(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const components = source.components && typeof source.components === 'object' ? source.components : {};
  const normalizedComponents = Object.fromEntries(Object.entries(components).map(([name, value]) => {
    const item = value && typeof value === 'object' ? value : {};
    return [name, {
      kind: stringOrNull(item.kind),
      status: stringOrNull(item.status),
      ageS: numberOrNull(item.age_s),
      everSeen: typeof item.ever_seen === 'boolean' ? item.ever_seen : null,
    }];
  }));
  return {
    status: stringOrNull(source.status),
    timestamp: source.timestamp || null,
    allConnected: boolOrNull(source.all_connected),
    degraded: Array.isArray(source.degraded) ? source.degraded.map(String) : [],
    errors: Array.isArray(source.errors) ? source.errors : [],
    components: normalizedComponents,
  };
}

function flattenState(payload) {
  const robots = payload && payload.robots && typeof payload.robots === 'object' ? payload.robots : {};
  const entries = [];
  for (const value of Object.values(robots)) {
    if (Array.isArray(value)) entries.push(...value);
  }
  const result = Object.create(null);
  for (const entry of entries) {
    if (entry && entry.topic) result[entry.topic] = entry.data;
  }
  return result;
}

function normalizeState(payload) {
  const values = flattenState(payload);
  const has = key => Object.prototype.hasOwnProperty.call(values, key);
  const value = key => values[key];
  const healthSummary = {};
  const tactile = {};
  for (const [key, item] of Object.entries(values)) {
    if (key.startsWith('health/summary/')) healthSummary[key.slice('health/summary/'.length)] = item;
    if (key === 'health/glove/left/tactile') tactile.left = item;
    if (key === 'health/glove/right/tactile') tactile.right = item;
  }

  const quest = {
    headsetConnected: boolOrNull(value('quest/headset_connected')),
    starlight: boolOrNull(value('quest/starlight')),
    headTracked: boolOrNull(value('quest/head/tracked')),
    leftControllerTracked: boolOrNull(value('quest/left_controller/tracked')),
    rightControllerTracked: boolOrNull(value('quest/right_controller/tracked')),
  };

  return {
    timestampPosix: numberOrNull(payload && payload.timestamp_posix),
    controlState: stringOrNull(value('control_state')),
    controlStateDescription: stringOrNull(value('control_state_description')),
    isRecording: boolOrNull(value('is_recording')),
    emergencyStopped: boolOrNull(value('is_emergency_stopped')),
    teleopAligned: boolOrNull(value('teleop_aligned')),

    teleopDelay: {
      left: numberOrNull(value('teleop/hand_left/delay')),
      right: numberOrNull(value('teleop/hand_right/delay')),
    },
    healthAllConnected: boolOrNull(value('health/all_connected')),
    healthSummary,
    tactile,
    quest,
    errorCount: has('error_count') && Number.isFinite(Number(value('error_count'))) ? Number(value('error_count')) : null,
    errors: Array.isArray(value('errors')) ? value('errors') : [],
  };
}

function normalizeSensors(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map(item => {
    const source = item && typeof item === 'object' ? item : {};
    return {
      id: stringOrNull(source.id),
      dataType: stringOrNull(source.data_type),
      side: stringOrNull(source.side),
      width: numberOrNull(source.width),
      height: numberOrNull(source.height),
      codecs: Array.isArray(source.codecs) ? source.codecs.map(String) : [],
    };
  });
}

class CollectorApiPoller {
  constructor({ request, importerUrl, hermesUrl, timeout = 3000 } = {}) {
    if (typeof request !== 'function') throw new TypeError('CollectorApiPoller requires a request function');
    this.request = request;
    this.importerUrl = importerUrl || 'http://127.0.0.1:5025';
    this.hermesUrl = hermesUrl || 'http://127.0.0.1:5006';
    this.timeout = timeout;
    this.snapshot = { importer: null, hermes: null };
  }

  async requestImporter(paths) {
    const candidates = Array.isArray(paths) ? paths : [paths];
    let lastError;
    for (const path of candidates) {
      try {
        const response = await this.request(joinUrl(this.importerUrl, path), {
          timeout: this.timeout,
          includeEdgeAuth: false,
        });
        return { ...response, endpoint: path };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Importer API 请求失败');
  }

  async pollImporter() {
    const checkedAt = new Date().toISOString();
    const previous = this.snapshot.importer || {};
    const names = ['machine', 'task', 'health', 'workers', 'queue', 'processing', 'processor', 'episodes', 'recentEpisodes', 'overview'];
    const settled = await Promise.allSettled([
      this.requestImporter('/api/config/machine'),
      this.requestImporter('/api/config/task'),
      this.requestImporter(['/api/maintenance/health', '/api/core/health']),
      this.requestImporter('/api/data/processing/workers/status'),
      this.requestImporter('/api/data/processing/process_queue/status'),
      this.requestImporter(['/api/data/processing/overview', '/api/data/processing/overall']),
      this.requestImporter('/api/processor/overview'),
      this.requestImporter('/api/data/episodes/records'),
      this.requestImporter('/api/processor/episodes/recent'),
      this.requestImporter('/api/operations/overview'),
    ]);
    const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));
    const machineResult = results.machine;
    const taskResult = results.task;
    const coreResult = results.health;
    const workersResult = results.workers;
    const queueResult = results.queue;
    const processingResult = results.processing;
    const processorResult = results.processor;
    const episodesResult = results.episodes;
    const recentEpisodesResult = results.recentEpisodes;
    const overviewResult = results.overview;
    const machineOk = machineResult.status === 'fulfilled';
    const taskOk = taskResult.status === 'fulfilled';
    const coreOk = coreResult.status === 'fulfilled';
    const next = {
      ...previous,
      reachable: machineOk || taskOk,
      checkedAt,
      lastSuccessAt: machineOk || taskOk ? checkedAt : (previous.lastSuccessAt || null),
      endpointStatus: Object.fromEntries(names.map(name => [name, results[name].status === 'fulfilled'])),
      endpointErrors: Object.fromEntries(names.map(name => [name, results[name].status === 'fulfilled' ? null : errorMessage(results[name].reason)])),
      endpointPaths: Object.fromEntries(names.map(name => [name, results[name].status === 'fulfilled' ? results[name].value.endpoint : null])),
      machineConfigStale: !machineOk,
      taskStale: !taskOk,
      stale: !(machineOk || taskOk),
    };
    if (machineOk) Object.assign(next, normalizeImporterMachine(machineResult.value.body));
    if (taskOk) next.task = normalizeImporterTask(taskResult.value.body);
    if (workersResult.status === 'fulfilled') next.workers = workersResult.value.body;
    if (queueResult.status === 'fulfilled') next.queue = queueResult.value.body;
    if (processingResult.status === 'fulfilled') next.processing = processingResult.value.body;
    if (processorResult.status === 'fulfilled') next.processorOverview = processorResult.value.body;
    if (episodesResult.status === 'fulfilled') next.episodes = episodesResult.value.body;
    if (recentEpisodesResult.status === 'fulfilled') next.recentEpisodes = recentEpisodesResult.value.body;
    if (overviewResult.status === 'fulfilled') next.overview = overviewResult.value.body;
    if (coreOk) {
      const core = coreResult.value.body && typeof coreResult.value.body === 'object' ? coreResult.value.body : {};
      next.health = core;
      next.importerVersion = stringOrNull(core.version);
      next.channel = stringOrNull(core.channel);
      next.activity = stringOrNull(core.activity);
      next.collectorAlive = boolOrNull(core.is_collector_alive);
      next.observerAlive = boolOrNull(core.is_observer_alive);
      next.loggedIn = boolOrNull(core.is_logged_in);
      next.idleTimeSecs = numberOrNull(core.idle_time_secs);
    }
    const overview = next.overview && typeof next.overview === 'object' ? next.overview : {};
    next.quality = overview.quality && typeof overview.quality === 'object' ? overview.quality : null;
    next.qualityPassRate = numberOrNull(overview.quality_pass_rate);
    next.latestMcapReport = overview.latest_mcap_report || null;
    next.recentMcapReports = Array.isArray(overview.recent_mcap_reports) ? overview.recent_mcap_reports : [];
    next.recentFailures = Array.isArray(overview.recent_failures) ? overview.recent_failures : [];
    next.faults = overview.faults && typeof overview.faults === 'object' ? overview.faults : {};
    if (!machineOk && !taskOk) next.error = 'Importer API 不可达';
    else next.error = null;
    this.snapshot.importer = next;
    return next;
  }

  async pollHermes() {
    const checkedAt = new Date().toISOString();
    const previous = this.snapshot.hermes || {};
    const results = await Promise.allSettled([
      this.request(joinUrl(this.hermesUrl, '/version'), { timeout: this.timeout, includeEdgeAuth: false }),
      this.request(joinUrl(this.hermesUrl, '/health'), { timeout: this.timeout, includeEdgeAuth: false }),
      this.request(joinUrl(this.hermesUrl, '/state'), { timeout: this.timeout, includeEdgeAuth: false }),
      this.request(joinUrl(this.hermesUrl, '/sensors'), { timeout: this.timeout, includeEdgeAuth: false }),
    ]);
    const names = ['version', 'health', 'state', 'sensors'];
    const endpointStatus = {};
    const endpointErrors = {};
    let successCount = 0;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      endpointStatus[names[i]] = result.status === 'fulfilled';
      endpointErrors[names[i]] = result.status === 'fulfilled' ? null : errorMessage(result.reason);
      if (result.status === 'fulfilled') successCount += 1;
    }
    const next = {
      ...previous,
      reachable: successCount > 0,
      checkedAt,
      lastSuccessAt: successCount > 0 ? checkedAt : (previous.lastSuccessAt || null),
      endpointStatus,
      endpointErrors,
      healthStale: endpointStatus.health === false,
      stateStale: endpointStatus.state === false,
      sensorsStale: endpointStatus.sensors === false,
      stale: successCount === 0,
    };
    if (results[0].status === 'fulfilled') next.version = normalizeVersion(results[0].value.body);
    if (results[1].status === 'fulfilled') next.health = normalizeHealth(results[1].value.body);
    if (results[2].status === 'fulfilled') next.state = normalizeState(results[2].value.body);
    if (results[3].status === 'fulfilled') next.sensors = normalizeSensors(results[3].value.body);
    next.error = successCount === 0 ? 'Hermes API 不可达' : null;
    this.snapshot.hermes = next;
    return next;
  }

  async poll() {
    const [importer, hermes] = await Promise.all([this.pollImporter(), this.pollHermes()]);
    return { importer, hermes };
  }
}

module.exports = {
  CollectorApiPoller,
  flattenState,
  normalizeImporterMachine,
  normalizeImporterTask,
  normalizeHealth,
  normalizeSensors,
  normalizeState,
  normalizeVersion,
};
