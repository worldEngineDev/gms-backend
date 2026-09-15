const http = require('http');
const https = require('https');
const os = require('os');
const GloveSNDetector = require('./glove-sn-detector');
const DeviceStatusDetector = require('./device-detector');
const CameraMonitor = require('./camera-monitor');
const { CollectorApiPoller } = require('./collector-api');
const {
  createContainerResolver,
  isAllowedManagedContainerName,
  safeContainerName,
} = require('./container-resolver');

const AGENT_VERSION = '1.3.6';

const CONFIG = {
  backendUrl: process.env.GMS_BACKEND_URL || 'http://10.5.51.216:8765',
  edgeToken: process.env.EDGE_TOKEN || '',
  machineNumber: process.env.MACHINE_NUMBER || null,
  importerUrl: process.env.IMPORTER_API_URL || process.env.IMPORTER_URL || 'http://127.0.0.1:5025',
  hermesUrl: process.env.HERMES_API_URL || process.env.HERMES_URL || 'http://127.0.0.1:5006',
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30', 10) * 1000,
  deviceScanInterval: 120 * 1000,
  snRescanInterval: 10 * 60 * 1000,
  retryInterval: 10 * 1000,
  timeout: 8000,
  collectorTimeout: parseInt(process.env.COLLECTOR_API_TIMEOUT || '3000', 10),
};

const machineInfo = {
  machineNumber: null,
  hostname: os.hostname(),
  ipAddress: null,
  startTime: new Date().toISOString(),

  gloves: {
    left: { connected: false, lastCheck: null, snCode: null },
    right: { connected: false, lastCheck: null, snCode: null },
  },
  devices: null,
  // Wuji SDK 诊断快照：与 devices 中的连接状态同时上报到机器状态。
  wuji: {
    scannedAt: null,
    error: null,
    gloves: { left: null, right: null },
    dexterousHands: { left: null, right: null },
  },
  cameraFps: null,
  encoderFps: null,
  cameras: [],
  handStream: null,
  importer: null,
  hermes: null,
};

let deviceDetector = null;
let snDetector = null;
let cameraMonitor = null;
let wujiScanPromise = null;

function detectMachineNumber() {
  if (CONFIG.machineNumber) {

    const num = CONFIG.machineNumber.trim().toLowerCase();
    console.log(`[Config] 使用环境变量指定的机器编号: ${num}`);
    return num;
  }

  const hostname = os.hostname().toLowerCase();
  const match = hostname.match(/we-(\d+)/);
  if (match) {
    const num = match[1].padStart(3, '0');
    const machineNumber = `we-${num}`;
    console.log(`[Detect] 从 hostname 检测到机器编号: ${machineNumber}`);
    return machineNumber;
  }

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ipMatch = iface.address.match(/^10\.5\.51\.(\d+)$/);
        if (ipMatch) {
          const num = ipMatch[1].padStart(3, '0');
          const machineNumber = `we-${num}`;
          console.log(`[Detect] 从 IP 地址检测到机器编号: ${machineNumber} (${iface.address})`);
          machineInfo.ipAddress = iface.address;
          return machineNumber;
        }
      }
    }
  }

  console.warn('[Detect] ⚠️ 无法自动检测机器编号，请设置环境变量 MACHINE_NUMBER');
  return null;
}

function getPrimaryIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, options.headers || {});
    if (CONFIG.edgeToken && options.includeEdgeAuth !== false && !headers.Authorization) {
      headers.Authorization = `Bearer ${CONFIG.edgeToken}`;
    }

    const req = protocol.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || CONFIG.timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch {                     }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)}`);
          err.statusCode = res.statusCode;
          err.body = body;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

const collectorApi = new CollectorApiPoller({
  importerUrl: CONFIG.importerUrl,
  hermesUrl: CONFIG.hermesUrl,
  timeout: CONFIG.collectorTimeout,
  request: httpRequest,
});

let collectorPollAt = 0;
let collectorPollPromise = null;
const FAST_COLLECTOR_INTERVAL = parseInt(process.env.FAST_COLLECTOR_INTERVAL || '5', 10) * 1000;

async function pollCollectorApis(force = false) {
  const now = Date.now();
  if (!force && collectorPollAt && now - collectorPollAt < FAST_COLLECTOR_INTERVAL) return;
  if (collectorPollPromise) return collectorPollPromise;
  collectorPollPromise = collectorApi.poll()
    .then(snapshot => {
      machineInfo.importer = snapshot.importer;
      machineInfo.hermes = snapshot.hermes;
      collectorPollAt = Date.now();
      return snapshot;
    })
    .catch(error => {

      console.error('[Collector] API 轮询异常:', error.message);
      collectorPollAt = Date.now();
      return null;
    })
    .finally(() => { collectorPollPromise = null; });
  return collectorPollPromise;
}

function _execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    require('child_process').exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout || '';
        err.stderr = stderr || '';
        return reject(err);
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const containerResolver = createContainerResolver({
  logger: console,
  execAsync: _execAsync,
});

async function resolveContainer(role, options = {}) {
  return containerResolver.resolve(role, options);
}

function clearContainerCache(role) {
  containerResolver.clear(role);
}

function isDockerContainerStaleError(error) {
  const text = [
    error && error.message,
    error && error.stdout,
    error && error.stderr,
  ].filter(Boolean).join('\n');
  return /No such container|No such object|is not running|container .* is not running|not found/i.test(text);
}

async function withDockerContainer(role, actionName, operation) {
  const first = await resolveContainer(role);
  if (!first) throw new Error(`${role} 容器未运行，无法${actionName}`);

  try {
    return { container: first, result: await operation(first) };
  } catch (error) {
    if (!isDockerContainerStaleError(error)) throw error;

    clearContainerCache(role);
    const second = await resolveContainer(role, { force: true });
    if (!second) throw error;

    console.warn(`[ContainerResolver] ${role} 容器 ${first} 失效，切换到 ${second} 后重试 ${actionName}`);
    return { container: second, result: await operation(second) };
  }
}

async function execDockerForRole(role, actionName, commandFactory, opts) {
  const { container, result } = await withDockerContainer(role, actionName, async (name) => (
    _execAsync(commandFactory(name), opts)
  ));
  return { container, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function execDockerFilesForRole(role, actionName, files, commandFactory, opts) {
  const { container, result } = await withDockerContainer(role, actionName, async (name) => {
    for (const file of files || []) {
      await _execAsync(`docker cp ${file.local} ${name}:${file.remote}`, {
        timeout: file.timeout || 5000,
      });
    }
    return _execAsync(commandFactory(name), opts);
  });
  return { container, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// Mechanical-arm SDK is isolated in a long-lived broker inside importer.
// The importer container has the glibc runtime required by libMarvinSDK.so;
// the heartbeat agent only forwards JSON commands and never opens the robot
// controller port itself.
let armBrokerInitPromise = null;
async function runArmBrokerCommand(payload, timeout = 35000) {
  const importer = await resolveContainer('importer', { force: true });
  if (!importer) return { success: false, sdkCalled: false, error: '未找到运行中的 importer 容器' };
  if (!armBrokerInitPromise) {
    armBrokerInitPromise = (async () => {
      // heartbeat-agent 自身已经携带 Broker 脚本和 SDK 库，直接从
      // 通过 docker exec 管道传输文件，而不是 docker cp：Agent 运行在
      // 容器内时，宿主机 docker daemon 看不到 Agent 的 /app 路径。
      await _execAsync(`cat /app/marvin-sdk-broker.py | docker exec -i ${importer} sh -c 'cat > /tmp/marvin-sdk-broker.py'`, { timeout: 5000 });
      await _execAsync(`cat /app/libMarvinSDK.so | docker exec -i ${importer} sh -c 'cat > /tmp/libMarvinSDK.so'`, { timeout: 10000 });
      const stateCheck = `docker exec ${importer} python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:3011/state", timeout=1)'`;
      try {
        await _execAsync(stateCheck, { timeout: 3000 });
      } catch {
        await _execAsync(`docker exec -d ${importer} python3 /tmp/marvin-sdk-broker.py --lib /tmp/libMarvinSDK.so --robot-ip 192.168.1.190`, { timeout: 5000 });
        let ready = false;
        for (let attempt = 0; attempt < 15; attempt += 1) {
          try {
            await _execAsync(stateCheck, { timeout: 1000 });
            ready = true;
            break;
          } catch {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        if (!ready) throw new Error('SDK Broker 启动后未就绪');
      }
      return importer;
    })().catch(error => { armBrokerInitPromise = null; throw error; });
  }
  try { await armBrokerInitPromise; } catch (error) {
    return { success: false, sdkCalled: false, error: `机械臂 SDK Broker 启动失败: ${error.message}` };
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const command = `echo ${encoded} | base64 -d | docker exec -i ${importer} python3 -c 'import sys,urllib.request; d=sys.stdin.buffer.read(); r=urllib.request.Request("http://127.0.0.1:3011/command", data=d, headers={"Content-Type":"application/json"}); print(urllib.request.urlopen(r, timeout=30).read().decode())'`;
  try {
    const result = await _execAsync(command, { timeout, maxBuffer: 1024 * 1024 });
    const line = (result.stdout || '').trim().split(/\n/).pop();
    return JSON.parse(line || '{}');
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().slice(-500);
    return { success: false, sdkCalled: false, error: `机械臂 SDK Broker 调用失败: ${detail}` };
  }
}

async function execStreamDockerForRole(role, actionName, commandFactory, onLine, opts) {
  const { container, result } = await withDockerContainer(role, actionName, async (name) => {
    const streamResult = await _execStream(commandFactory(name), onLine, opts);
    if (streamResult.code && isDockerContainerStaleError({
      message: streamResult.stderr || streamResult.stdout || '',
    })) {
      const staleError = new Error(streamResult.stderr || streamResult.stdout || 'container is not running');
      staleError.stdout = streamResult.stdout || '';
      staleError.stderr = streamResult.stderr || '';
      throw staleError;
    }
    return streamResult;
  });
  return { container, result };
}

async function execStreamDockerFilesForRole(role, actionName, files, commandFactory, onLine, opts) {
  const { container, result } = await withDockerContainer(role, actionName, async (name) => {
    for (const file of files || []) {
      await _execAsync(`docker cp ${file.local} ${name}:${file.remote}`, {
        timeout: file.timeout || 5000,
      });
    }
    const streamResult = await _execStream(commandFactory(name), onLine, opts);
    if (streamResult.code && isDockerContainerStaleError({
      message: streamResult.stderr || streamResult.stdout || '',
    })) {
      const staleError = new Error(streamResult.stderr || streamResult.stdout || 'container is not running');
      staleError.stdout = streamResult.stdout || '';
      staleError.stderr = streamResult.stderr || '';
      throw staleError;
    }
    return streamResult;
  });
  return { container, result };
}

// 流式执行：按行回调（用于灵巧手诊断的实时进度）
function _execStream(cmd, onLine, opts) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    opts = opts || {};
    let stdout = '', stderr = '', pending = '';
    let timer = null;
    const child = spawn('sh', ['-c', cmd], { timeout: opts.timeout || 120000 });
    if (opts.timeout) {
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, opts.timeout + 5000);
    }
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (stdout.length > (opts.maxBuffer || 4 * 1024 * 1024)) stdout = stdout.slice(-(opts.maxBuffer || 4 * 1024 * 1024));
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const l of lines) {
        const t = l.trim();
        if (t) { try { onLine && onLine(t); } catch { } }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

// 灵巧手诊断实时进度（供 /diagnose-progress 轮询）
const diagStatus = {
  running: false,
  phase: 'idle',      // idle | scan | diag | done | error
  total: 0,
  current: 0,
  sn: null,
  message: '',
  startedAt: null,
  finishedAt: null,
};

async function scanEncoderFps() {
  try {
    const { container, stdout } = await execDockerForRole(
      'collector',
      '读取编码器日志',
      (name) => `docker logs --tail 4000 ${name} 2>&1 | grep -aE "Video encoder output" | tail -1`,
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    const line = (stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    const m = line.match(/Video encoder output\s+(\d+(?:\.\d+)?)\s*fps/i);
    if (!m) { machineInfo.encoderFps = null; return; }
    const fps = parseFloat(m[1]);

    let logTimeUnix = null, ageSec = null;
    const ts = line.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (ts) {
      const ms = ts[7] ? parseInt(String(ts[7]).slice(0, 3).padEnd(3, '0'), 10) : 0;
      logTimeUnix = Math.floor(Date.UTC(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5], +ts[6], ms) / 1000);
      const age = Math.round(Date.now() / 1000) - logTimeUnix;

      if (age >= -120 && age < 7 * 86400) ageSec = Math.max(0, age);
    }
    machineInfo.encoderFps = { fps, logTimeUnix, ageSec, container, source: 'collector-log' };
    console.log(`[CameraFps] 编码器输出 ${fps} fps${ageSec != null ? `（${ageSec} 秒前日志）` : ''}`);
  } catch (e) {
    console.error('[CameraFps] 日志提取失败:', e.message);
  }
}

function updateCameraSnapshot() {
  if (!cameraMonitor) return;
  const status = cameraMonitor.getStatus();
  const allCameras = status.cameras || [];
  // 只把业务上的三路相机上报给前端；RealSense 的深度/红外辅助节点
  // 仍由 CameraMonitor 采样，但不应被误显示成额外的“前置相机”。
  machineInfo.cameras = allCameras.filter(camera => camera.cameraId);
  const measured = machineInfo.cameras.filter(camera => Number.isFinite(camera.currentFPS) && camera.currentFPS > 0);
  if (measured.length) {
    const fps = measured.reduce((sum, camera) => sum + camera.currentFPS, 0) / measured.length;
    const dropping = measured.filter(camera => camera.isDropping).length;
    machineInfo.cameraFps = {
      fps,
      cameraCount: machineInfo.cameras.length,
      measuredCount: measured.length,
      droppingCount: dropping,
      cameras: machineInfo.cameras,
      timestamp: new Date().toISOString(),
      source: 'v4l2-stream',
    };
  } else {
    machineInfo.cameraFps = null;
  }
}

async function startCameraMonitoring() {
  const interval = Math.max(1000, parseInt(process.env.CAMERA_FPS_INTERVAL || '2000', 10));
  const expectedFPS = Math.max(1, parseFloat(process.env.CAMERA_EXPECTED_FPS || '30'));
  const threshold = Math.min(1, Math.max(0.1, parseFloat(process.env.CAMERA_FPS_THRESHOLD || '0.8')));
  cameraMonitor = new CameraMonitor({
    checkInterval: interval,
    expectedFPS,
    fpsThreshold: threshold,
    sampleFrames: Math.max(5, parseInt(process.env.CAMERA_SAMPLE_FRAMES || '20', 10)),
  });
  await cameraMonitor.startMonitoring(() => {
    updateCameraSnapshot();
  });
  updateCameraSnapshot();
  console.log(`[Camera] 实时帧率监控已启动（${interval}ms，期望 ${expectedFPS} fps）`);
}

async function scanHandStream() {
  const numMatch = /^(?:we|szx3)-(\d+)$/.exec(String(machineInfo.machineNumber || ''));
  if (numMatch && parseInt(numMatch[1], 10) < 100) { machineInfo.handStream = null; return; }
  try {
    const { stdout } = await execDockerForRole(
      'collector',
      '读取灵巧手数据流日志',
      (name) => `docker logs --tail 2000 ${name} 2>&1 | grep -aE "WujiHand2.*command stream" | tail -4`,
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    const out = {};
    for (const line of (stdout || '').trim().split('\n').filter(Boolean)) {
      const sideM = line.match(/wuji_hand_(l|r)/);
      if (!sideM) continue;
      const side = sideM[1] === 'l' ? 'left' : 'right';

      const hzM = line.match(/command stream(?:er)?\s+(?:at\s+)?([\d.]+)\s*Hz/i);
      const targetM = line.match(/\(target\s+([\d.]+)\)/i);
      const lateM = line.match(/(\d+)\s+of\s+(\d+)\s+ticks late/i);
      let logTimeUnix = null, ageSec = null;
      const ts = line.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
      if (ts) {
        const ms = ts[7] ? parseInt(String(ts[7]).slice(0, 3).padEnd(3, '0'), 10) : 0;
        logTimeUnix = Math.floor(Date.UTC(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5], +ts[6], ms) / 1000);
        const age = Math.round(Date.now() / 1000) - logTimeUnix;
        if (age >= -120 && age < 7 * 86400) ageSec = Math.max(0, age);
      }

      const prev = out[side];
      const isStats = !!(lateM || targetM);
      if (prev && !isStats && prev.logTimeUnix && logTimeUnix && prev.logTimeUnix >= logTimeUnix) continue;
      out[side] = {
        hz: hzM ? parseFloat(hzM[1]) : (prev && prev.hz) || null,
        target: targetM ? parseFloat(targetM[1]) : (isStats ? null : (prev && prev.target) || null),
        lateTicks: lateM ? parseInt(lateM[1], 10) : null,
        totalTicks: lateM ? parseInt(lateM[2], 10) : null,
        logTimeUnix, ageSec,
      };
    }
    machineInfo.handStream = (out.left || out.right) ? out : null;
    if (out.left || out.right) console.log(`[HandStream] ${JSON.stringify(machineInfo.handStream)}`);
  } catch (e) {
    console.error('[HandStream] 日志提取失败:', e.message);
  }
}

function buildPayload() {
  const summary = machineInfo.devices;
  const valueConnected = (value) => {
    if (value && typeof value === 'object') return value.connected === true;
    return !!value;
  };
  const glovePayload = (side, fallbackIp) => {
    const base = summary && summary.gloves ? summary.gloves[side] : null;
    const sdk = machineInfo.wuji && machineInfo.wuji.gloves ? machineInfo.wuji.gloves[side] : null;
    return {
      ...(base && typeof base === 'object' ? base : {}),
      ...(sdk || {}),
      connected: (sdk && sdk.connected === true) || valueConnected(base),
      snCode: (sdk && sdk.sn) || (base && typeof base === 'object' && base.snCode) || machineInfo.gloves[side].snCode || null,
      ip: (sdk && sdk.ip) || (base && typeof base === 'object' && base.ip) || fallbackIp,
    };
  };
  const handPayload = (side, fallbackIp) => {
    const base = summary && summary.dexterousHands ? summary.dexterousHands[side] : null;
    const sdk = machineInfo.wuji && machineInfo.wuji.dexterousHands
      ? machineInfo.wuji.dexterousHands[side] : null;
    return {
      ...(base && typeof base === 'object' ? base : {}),
      ...(sdk || {}),
      connected: (sdk && sdk.connected === true) || valueConnected(base),
      snCode: (sdk && sdk.sn) || (base && typeof base === 'object' && base.snCode)
        || (machineInfo.handsSN && machineInfo.handsSN[side]) || null,
      ip: (sdk && sdk.ip) || (base && typeof base === 'object' && base.ip) || fallbackIp,
    };
  };
  return {
    machineNumber: machineInfo.machineNumber,
    hostname: machineInfo.hostname,
    ipAddress: machineInfo.ipAddress || getPrimaryIPAddress(),
    agentVersion: AGENT_VERSION,
    timestamp: new Date().toISOString(),
    host: {
      uptime: process.uptime(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    machineType: (summary && summary.machineType) || null,
    cameraFps: machineInfo.cameraFps || machineInfo.encoderFps || null,
    encoderFps: machineInfo.encoderFps || null,
    cameras: machineInfo.cameras || [],
    handStream: machineInfo.handStream || null,
    wuji: machineInfo.wuji || null,
    devices: {
      gloves: {
        left: glovePayload('left', '192.168.1.100'),
        right: glovePayload('right', '192.168.1.101'),
      },
      dexterousHands: summary && summary.dexterousHands ? {
        left: handPayload('left', '192.168.1.110'),
        right: handPayload('right', '192.168.1.111'),
      } : null,
      roboticArm: summary && summary.roboticArm ? {
        connected: !!summary.roboticArm.connected, ip: '192.168.1.190',
      } : null,
    },
    quest: summary && summary.quest ? {
      connected: !!summary.quest.connected,
      serialNumber: summary.quest.serialNumber || null,
      adbStatus: summary.quest.error || (summary.quest.connected ? 'device' : null),
      battery: summary.quest.battery ?? null,
      controllers: summary.questControllers || null,
    } : null,
    importer: machineInfo.importer,
    hermes: machineInfo.hermes,
  };
}

// ==================== WebSocket 实时推送 ====================
const WS_PUSH_INTERVAL = parseInt(process.env.WS_PUSH_INTERVAL || '2', 10) * 1000;

function _httpGetJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function startWsPusher() {
  if (!CONFIG.edgeToken || !machineInfo.machineNumber) {
    console.log('[WS] 缺少 EDGE_TOKEN 或机器编号，实时推送未启用');
    return;
  }
  let WebSocket;
  try { WebSocket = require('ws').WebSocket; } catch (e) {
    console.log('[WS] ws 包未安装，实时推送未启用');
    return;
  }
  const wsUrl = CONFIG.backendUrl.replace(/^http/, 'ws')
    + '/api/edge/ws?token=' + encodeURIComponent(CONFIG.edgeToken)
    + '&machine=' + encodeURIComponent(machineInfo.machineNumber);
  let ws = null;
  let wsUp = false;
  let retryTimer = null;

  const connect = () => {
    try { ws = new WebSocket(wsUrl); } catch (e) { scheduleRetry(); return; }
    ws.on('open', () => { wsUp = true; console.log('[WS] 实时推送通道已建立'); });
    ws.on('close', () => { wsUp = false; scheduleRetry(); });
    ws.on('error', () => { try { ws.terminate(); } catch (e) { } });
  };
  const scheduleRetry = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 5000);
  };

  setInterval(async () => {
    if (!wsUp || !ws || ws.readyState !== 1) return;
    try {
      // WebSocket 实时通道独立刷新 Importer 运营数据，不等待 30 秒心跳。
      await pollCollectorApis();
      const [hermesHealth, core] = await Promise.all([
        _httpGetJSON(CONFIG.hermesUrl + '/health', 1500).catch(() => null),
        _httpGetJSON(CONFIG.importerUrl + '/api/core/health', 2500).catch(() => null),
      ]);
      const payload = buildPayload();
      payload.hermesHealth = hermesHealth;
      payload.core = core;
      payload.fast = true;
      ws.send(JSON.stringify({ type: 'fast', data: payload }));
    } catch (e) { }
  }, WS_PUSH_INTERVAL);

  connect();
}

async function sendHeartbeat() {
  if (!machineInfo.machineNumber) {
    console.error('[Heartbeat] ❌ 机器编号未设置，跳过心跳');
    return false;
  }
  try {
    await pollCollectorApis();
    await scanEncoderFps();
    await scanHandStream();
    const payload = buildPayload();
    console.log('[Heartbeat] 发送数据:', JSON.stringify(payload, null, 2));
    const res = await httpRequest(`${CONFIG.backendUrl}/api/edge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const alerts = (res.body && res.body.alerts) || [];
    if (alerts.length) {
      console.warn(`[Heartbeat] ⚠️ ${machineInfo.machineNumber} 服务端返回 ${alerts.length} 条告警:`);
      for (const a of alerts) console.warn(`   [${a.level}] ${a.message}`);
    } else {
      console.log(`[Heartbeat] ✅ ${machineInfo.machineNumber} 心跳成功`);
    }
    return true;
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      console.error('[Heartbeat] ❌ 边缘节点认证失败：请检查 EDGE_TOKEN 是否与服务端一致');
    } else {
      console.error(`[Heartbeat] ❌ 心跳发送失败: ${error.message}`);
    }
    return false;
  }
}

let heartbeatTimer = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

function heartbeatLoop() {
  sendHeartbeat().then((success) => {
    if (success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures === MAX_FAILURES) {
        console.error(`[Heartbeat] ⚠️ 连续失败 ${consecutiveFailures} 次，请检查网络/后端服务/EDGE_TOKEN`);
      }
    }
    heartbeatTimer = setTimeout(heartbeatLoop, success ? CONFIG.heartbeatInterval : CONFIG.retryInterval);
  });
}

async function scanDevices() {
  try {
    await deviceDetector.detectAll();
    machineInfo.devices = deviceDetector.getDeviceSummary();
    await scanWujiHands();
  } catch (e) {
    console.error('[Device] 设备探测异常:', e.message);
  }
}

async function scanWujiDevicesOnce() {
  const importerContainer = await resolveContainer('importer');
  if (!importerContainer) {
    machineInfo.wuji.error = 'importer 容器未运行';
    machineInfo.wuji.scannedAt = new Date().toISOString();
    console.warn('[Wuji SDK] 未找到运行中的 importer 容器，跳过扫描');
    return;
  }
  // 运行在 importer 容器的系统 Python 中。Wuji 的 scan() 返回的地址在
  // 现场可能是 zenoh://SN（不是 IP），因此按设备类型/SN 识别，不能丢弃该地址。
  const script = `import json, time
from wuji_sdk import SdkManager, DeviceType

def side_of(sn):
    sn = str(sn or '').upper()
    if len(sn) > 3 and sn[3] == 'J': return 'left'
    if len(sn) > 3 and sn[3] == 'K': return 'right'
    return None

def address_of(value):
    text = str(value or '')
    if text.startswith('zenoh://'): return None
    return text.split(':')[0] if text else None

def connected_of(device):
    value = getattr(device, 'is_connected', True)
    return bool(value() if callable(value) else value)

def sample_stream(device, name, seconds=0.8):
    frames = 0
    stream = getattr(device, name)()
    sub = stream.subscribe()
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            frame = sub.recv()
            if frame is not None: frames += 1
            time.sleep(0.01)
    finally:
        sub.close()
    return frames

manager = SdkManager.instance()
rows = []
try:
    for discovered in manager.scan():
        sn = str(getattr(discovered, 'sn', '') or '')
        upper = sn.upper()
        dtype = getattr(discovered, 'device_type', None)
        is_glove = dtype == DeviceType.WujiGlove or upper.startswith('WG1')
        is_hand = dtype in (DeviceType.WujiHand, DeviceType.WujiHand2) or upper.startswith('WH')
        if not (is_glove or is_hand): continue
        side = side_of(sn)
        if side is None: continue
        address = str(getattr(discovered, 'address', '') or '')
        # scan() also returns every Zenoh peer visible on the LAN as
        # zenoh://SN. Those entries are not directly connectable from this
        # host and can block connect()/stream sampling for tens of seconds.
        # Only concrete IP:port discoveries represent devices attached to
        # this machine; remote peers remain covered by the network detector.
        if not address or address.startswith('zenoh://'): continue
        row = {
            'kind': 'glove' if is_glove else 'dexterous_hand',
            'sn': sn,
            'side': side,
            'address': address,
            'ip': address_of(address),
            'connected': False,
            'healthy': False,
            'error': None,
        }
        try:
            device_name = 'heartbeat_' + sn[-4:]
            device = manager.connect(sn=sn, device_name=device_name)
            row['connected'] = connected_of(device)
            if is_glove:
                tactile = sample_stream(device, 'tactile')
                emf = sample_stream(device, 'emf_poses')
                row.update({
                    'tactileFrames': tactile,
                    'emfPosesFrames': emf,
                    'tactileOk': tactile > 0,
                    'emfPosesOk': emf > 0,
                    'dataStreamOk': tactile > 0 or emf > 0,
                    'healthy': row['connected'] and (tactile > 0 or emf > 0),
                })
                if row['connected'] and not row['dataStreamOk']:
                    row['error'] = '数据流无帧'
            else:
                online = int(device.online_joints_count().get() or 0)
                row.update({
                    'onlineJoints': online,
                    'expectedJoints': 20,
                    'healthy': row['connected'] and online == 20,
                })
                if row['connected'] and online < 20:
                    row['error'] = '在线关节数异常'
        except Exception as exc:
            row['error'] = str(exc)[:160]
        finally:
            try:
                manager.disconnect(device_name)
            except Exception:
                pass
        rows.append(row)
finally:
    try: manager.disconnect_all()
    except Exception: pass
print(json.dumps(rows, ensure_ascii=False))`;
  const tmp = `/tmp/wuji_scan_${Date.now()}.py`;
  const remote = `/tmp/wuji_scan_${Date.now()}.py`;
  const fs = require('fs');
  try {
    fs.writeFileSync(tmp, script);
    const { stdout: scanStdout } = await execDockerFilesForRole(
      'importer',
      '上传并执行 Wuji SDK 扫描',
      [{ local: tmp, remote }],
      (name) => `docker exec ${name} /usr/bin/timeout -k 5s 40s /usr/local/bin/python3 ${remote}`,
      { timeout: 50000, maxBuffer: 2 * 1024 * 1024 },
    );
    const r = { stdout: scanStdout };
    const rows = JSON.parse((r.stdout || '').trim().split('\n').pop() || '[]');
    if (!Array.isArray(rows) || !rows.length) {
      machineInfo.wuji.error = '扫描无结果';
      machineInfo.wuji.scannedAt = new Date().toISOString();
      console.warn('[Wuji SDK] 扫描为空，保留上一轮设备状态');
      return;
    }
    const gloves = { left: null, right: null };
    const hands = { left: null, right: null };
    for (const row of rows) {
      if (row.kind === 'glove' && (row.side === 'left' || row.side === 'right')) gloves[row.side] = row;
      if (row.kind === 'dexterous_hand' && (row.side === 'left' || row.side === 'right')) hands[row.side] = row;
    }
    // 一轮 SDK 扫描可能只拿到部分设备（例如 Zenoh 正在重连）。
    // 在短暂窗口内保留上一轮成功侧的详细数据，避免页面闪成“未发现”；
    // 当前轮真正返回的设备仍然优先，错误会保存在该侧的 error 字段中。
    const previousWuji = machineInfo.wuji || {};
    const previousScannedAt = previousWuji.scannedAt ? Date.parse(previousWuji.scannedAt) : NaN;
    const reusePrevious = Number.isFinite(previousScannedAt)
      && Date.now() - previousScannedAt < 5 * 60 * 1000;
    const reuseSide = (group, side, current) => (
      current || (reusePrevious && previousWuji[group] && previousWuji[group][side]) || null
    );
    const effectiveGloves = {
      left: reuseSide('gloves', 'left', gloves.left),
      right: reuseSide('gloves', 'right', gloves.right),
    };
    const effectiveHands = {
      left: reuseSide('dexterousHands', 'left', hands.left),
      right: reuseSide('dexterousHands', 'right', hands.right),
    };
    machineInfo.wuji = {
      scannedAt: new Date().toISOString(),
      error: null,
      gloves: effectiveGloves,
      dexterousHands: effectiveHands,
    };
    // 保持旧的设备摘要字段兼容已有 reconcile/自动绑定逻辑，同时携带详细诊断字段。
    if (machineInfo.devices) {
      const baseConnected = (value) => {
        if (value && typeof value === 'object') return value.connected === true;
        return !!value;
      };
      const mergeDetectedDevice = (base, sdk, previous) => {
        const baseObj = base && typeof base === 'object' ? base : {};
        const previousIsConnected = previous && previous.connected === true;
        if (!sdk) return {
          ...baseObj,
          connected: baseConnected(base) || previousIsConnected,
        };
        // SDK 诊断可能因为瞬时 Zenoh 超时失败；端口/PING 仍然在线时，
        // 不要把这种“诊断失败”降级成设备离线。详细错误保留在 wuji 中。
        return {
          ...baseObj,
          ...sdk,
          connected: sdk.connected === true || baseConnected(base) || previousIsConnected,
        };
      };
      machineInfo.devices.gloves = {
        left: mergeDetectedDevice(machineInfo.devices.gloves?.left, gloves.left, previousWuji.gloves?.left),
        right: mergeDetectedDevice(machineInfo.devices.gloves?.right, gloves.right, previousWuji.gloves?.right),
      };
      machineInfo.devices.dexterousHands = {
        left: mergeDetectedDevice(machineInfo.devices.dexterousHands?.left, hands.left, previousWuji.dexterousHands?.left),
        right: mergeDetectedDevice(machineInfo.devices.dexterousHands?.right, hands.right, previousWuji.dexterousHands?.right),
      };
    }
    const previousHandsSN = machineInfo.handsSN || {};
    machineInfo.handsSN = {
      left: hands.left?.sn || previousHandsSN.left || null,
      right: hands.right?.sn || previousHandsSN.right || null,
    };
    console.log(`[Wuji SDK] 手套L=${effectiveGloves.left ? `${effectiveGloves.left.sn} ${effectiveGloves.left.healthy ? '正常' : '异常'}` : '未发现'} 手套R=${effectiveGloves.right ? `${effectiveGloves.right.sn} ${effectiveGloves.right.healthy ? '正常' : '异常'}` : '未发现'}`);
    console.log(`[Wuji SDK] 灵巧手L=${effectiveHands.left ? `${effectiveHands.left.sn} ${effectiveHands.left.onlineJoints || 0}/20` : '未发现'} 右=${effectiveHands.right ? `${effectiveHands.right.sn} ${effectiveHands.right.onlineJoints || 0}/20` : '未发现'}`);
  } catch (e) {
    machineInfo.wuji.error = e.message;
    machineInfo.wuji.scannedAt = new Date().toISOString();
    console.warn(`[Wuji SDK] 实时扫描失败: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try {
      const cleanupContainer = await resolveContainer('importer');
      if (cleanupContainer) {
        await _execAsync(`docker exec ${cleanupContainer} rm -f ${remote}`, { timeout: 3000 });
      }
    } catch {}
  }
}

// SDK 的 Zenoh scan() 不是可并发调用的：并发扫描会让后一轮拿到空结果，
// 进而覆盖上一轮有效状态。启动重试和定时扫描统一复用同一个 promise。
async function scanWujiDevices() {
  if (wujiScanPromise) {
    console.log('[Wuji SDK] 扫描已在进行中，复用当前扫描任务');
    return wujiScanPromise;
  }
  wujiScanPromise = scanWujiDevicesOnce().finally(() => {
    wujiScanPromise = null;
  });
  return wujiScanPromise;
}

// 兼容旧调用名；所有新扫描统一覆盖手套和灵巧手。
const scanWujiHands = scanWujiDevices;

async function scanSN() {
  try {
    const result = await snDetector.detectAll();
    if (result.left) machineInfo.gloves.left.snCode = result.left;
    if (result.right) machineInfo.gloves.right.snCode = result.right;
    if (result.handLeft || result.handRight) {
      machineInfo.handsSN = { left: result.handLeft || null, right: result.handRight || null };
    }
  } catch (e) {
    console.error('[SN] SN 识别异常:', e.message);
  }
}

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agentVersion: AGENT_VERSION,
      machineNumber: machineInfo.machineNumber,
      uptime: process.uptime(),
      consecutiveFailures,
      gloves: machineInfo.gloves,
      wuji: machineInfo.wuji,
      devices: machineInfo.devices,
      cameraFps: machineInfo.cameraFps || machineInfo.encoderFps || null,
      cameras: machineInfo.cameras || [],
      handStream: machineInfo.handStream || null,
      importer: machineInfo.importer ? {
        reachable: machineInfo.importer.reachable,
        checkedAt: machineInfo.importer.checkedAt,
        error: machineInfo.importer.error || null,
      } : null,
      hermes: machineInfo.hermes ? {
        reachable: machineInfo.hermes.reachable,
        checkedAt: machineInfo.hermes.checkedAt,
        error: machineInfo.hermes.error || null,
      } : null,
    }));
  } else if (req.url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildPayload()));
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/stop-collector')) {
    req.resume();
    const armToken = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || armToken !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    (async () => {
      try {
        const container = await resolveContainer('collector');
        if (!container) throw new Error('未找到运行中的采集容器');
        console.log(`[StopCollector] 收到停止请求: ${container}`);
        const r = await _execAsync(`docker stop ${container}`, { timeout: 30000 });
        console.log(`[StopCollector] ${container} 已停止`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, container, output: (r.stdout || '').trim() }));
      } catch (e) {
        console.error(`[StopCollector] 停止失败: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/stop-exodus')) {
    req.resume();
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    (async () => {
      try {
        const container = await resolveContainer('exodus');
        if (!container) throw new Error('未找到运行中的 exodus 容器');
        console.log(`[StopExodus] 收到停止请求: ${container}`);
        const r = await _execAsync(`docker stop ${container}`, { timeout: 30000 });
        console.log(`[StopExodus] ${container} 已停止`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, container, output: (r.stdout || '').trim() }));
      } catch (e) {
        console.error(`[StopExodus] 停止失败: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/quest-control')) {
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) { res.writeHead(401, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'unauthorized'})); return; }
    let raw=''; req.on('data', c => { raw += c; }); req.on('end', async () => {
      try { const action = String((JSON.parse(raw || '{}')).action || ''); if (!['connect','disconnect'].includes(action)) throw new Error('无效操作');
        const cmd = action === 'connect' ? 'adb shell monkey -p com.picoar.questctrlpose 1' : 'adb shell am force-stop com.picoar.questctrlpose';
        const r = await _execAsync(cmd, {timeout:30000}); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, action, output:(r.stdout||'').trim()}));
      } catch(e) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    });
  } else if (req.method === 'GET' && req.url && req.url.startsWith('/machine-config')) {
    req.resume();
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    (async () => {
      try {
        let raw = null, lastErr = null;
        for (const role of ['collector', 'importer']) {
          try {
            const r = await execDockerForRole(
              role,
              '读取 machine.jsonc',
              (container) => `docker exec ${container} cat /exchange/machine.jsonc`,
              { timeout: 8000, maxBuffer: 1024 * 1024 }
            );
            if (r.stdout && r.stdout.trim()) { raw = r.stdout; break; }
          } catch (e) { lastErr = e; }
        }
        if (!raw) throw lastErr || new Error('machine.jsonc 未找到');
        let cfg;
        try { cfg = JSON.parse(raw); } catch { cfg = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, raw: raw.trim(), config: cfg }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `读取配置失败: ${e.message}` }));
      }
    })();
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/exec')) {
    req.resume();
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const cmd = String(body.cmd || '').trim();
        const timeout = Math.min(parseInt(body.timeout, 10) || 30000, 60000);
        const manageMatch = cmd.match(/^docker (start|stop|restart) ([A-Za-z0-9_.-]+)$/);
        const logsMatch = cmd.match(/^docker logs --tail ([1-9]\d{0,5}) ([A-Za-z0-9_.-]+)$/);
        const psAllowed = cmd === 'docker ps' || cmd === 'docker ps -a';
        const target = manageMatch ? manageMatch[2] : logsMatch ? logsMatch[2] : '';
        const allowed = psAllowed || (
          safeContainerName(target)
          && isAllowedManagedContainerName(target)
          && (!logsMatch || parseInt(logsMatch[1], 10) <= 200000)
        );
        if (!allowed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '命令不在白名单内，拒绝执行' }));
          return;
        }
        console.log(`[Exec] 执行命令: ${cmd}（timeout=${timeout}ms）`);
        try {
          const r = await _execAsync(cmd, { timeout, maxBuffer: 2 * 1024 * 1024 });
          console.log(`[Exec] 完成: ${cmd}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cmd, stdout: (r.stdout || '').slice(-8000) }));
        } catch (e) {
          console.error(`[Exec] 执行失败: ${cmd} ${e.message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, cmd, error: e.message.slice(-500), stderr: (e.stderr || '').slice(-2000) }));
        }
      })().catch((e) => {
        console.error(`[Exec] 异常: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    });
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/fix-quest')) {
    req.resume();
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    console.log('[FixQuest] 收到 Quest 修复请求');
    (async () => {
      const PKG = 'com.picoar.questctrlpose';
      const results = [];
      const runStep = async (cmd, timeout, tries) => {
        let lastErr = null;
        for (let i = 0; i < (tries || 1); i++) {
          try {
            return await _execAsync(cmd, { timeout });
          } catch (e) {
            lastErr = e;
            if (i < (tries || 1) - 1) await new Promise(r2 => setTimeout(r2, 2500));
          }
        }
        throw lastErr;
      };
      // check-device: 容器以 --network host 运行，adb 作为 client 连宿主机 daemon
      // 如果 daemon 不在线，先在容器内 start-server（作为 fallback）
      try {
        let r = await runStep('adb devices', 8000, 2);
        let out = (r.stdout || '').trim();
        let lines = out.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
        let ready = lines.some(l => l.endsWith('\tdevice'));
        if (!ready) {
          // daemon 可能不在线，尝试 start-server
          try { await _execAsync('adb start-server', { timeout: 10000 }); } catch {}
          await new Promise(r2 => setTimeout(r2, 2000));
          r = await runStep('adb devices', 8000, 2);
          out = (r.stdout || '').trim();
          lines = out.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
          ready = lines.some(l => l.endsWith('\tdevice'));
        }
        results.push({ step: 'check-device', ok: ready, out: lines.join('; ') || '无设备' });
        if (!ready) {
          console.error(`[FixQuest] 未检测到已授权设备: ${lines.join('; ') || '无设备'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `未检测到已授权的 Quest 设备（${lines.join('; ') || '无设备'}）`, steps: results }));
          return;
        }
      } catch (e) {
        results.push({ step: 'check-device', ok: false, out: e.message.slice(-300) });
        console.error(`[FixQuest] 设备检测失败: ${e.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `设备检测失败: ${e.message}`, steps: results }));
        return;
      }
      const steps = [
        { name: 'appops-camera', cmd: `adb shell appops set ${PKG} CAMERA allow`, timeout: 10000 },
        { name: 'appops-headset', cmd: `adb shell appops set ${PKG} HEADSET_CAMERA allow`, timeout: 10000 },
        { name: 'grant-camera', cmd: `adb shell pm grant ${PKG} android.permission.CAMERA`, timeout: 10000, optional: true },
        { name: 'grant-headset', cmd: `adb shell pm grant ${PKG} horizonos.permission.HEADSET_CAMERA`, timeout: 10000, optional: true },
        { name: 'compile', cmd: `adb shell cmd package compile -m speed -f ${PKG}`, timeout: 120000, optional: true },
        { name: 'force-stop', cmd: `adb shell am force-stop ${PKG}`, timeout: 10000 },
        { name: 'start', cmd: `adb shell am start -n ${PKG}/android.app.NativeActivity`, timeout: 15000 },
      ];
      for (const s of steps) {
        try {
          const r = await runStep(s.cmd, s.timeout, 1);
          const out = (r.stdout || '').trim();
          results.push({ step: s.name, ok: true, out: out.slice(-300) });
        } catch (e) {
          results.push({ step: s.name, ok: false, out: e.message.slice(-300) });
          if (!s.optional) {
            console.error(`[FixQuest] 步骤 ${s.name} 失败: ${e.message}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `步骤 ${s.name} 失败: ${e.message}`, steps: results }));
            return;
          }
        }
      }
      let pid = null;
      try {
        const r = await _execAsync(`adb shell pidof ${PKG}`, { timeout: 8000 });
        pid = (r.stdout || '').trim().split(/\s+/)[0] || null;
      } catch { }
      console.log(`[FixQuest] 修复完成${pid ? `，应用 pid=${pid}` : ''}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid, steps: results }));
    })().catch((e) => {
      console.error(`[FixQuest] 异常: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/diagnose-hands')) {
    req.resume();
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    console.log('[DiagHands] 收到灵巧手诊断请求');
    (async () => {
      const py = `import json, sys, time
from wuji_sdk import SdkManager, DeviceType
FINGERS = ["thumb","index","middle","ring","pinky"]
def jpath(nid): return FINGERS[(nid-1)//5]+"/S"+str((nid-1)%5+1)
def safe_float(v): return float(v) if v is not None else None
def safe_val(v):
    if isinstance(v, bytes): return v.decode('utf-8', errors='replace')
    if isinstance(v, (list, tuple)): return [safe_val(x) for x in v]
    if isinstance(v, dict): return {str(k): safe_val(x) for k, x in v.items()}
    return v
manager = SdkManager.instance()
print("===PROG:"+json.dumps({"phase":"scan","n":0}), flush=True)
devices = manager.scan()
# 只诊断本机设备：wuji_sdk 的 scan() 是全网络 Zenoh 扫描，会混入其它机器上
# 仅通过 zenoh:// 发现的设备（无实际 IP），不加以过滤会把别人的手算成本机的
hand_devs = [d for d in devices
             if (d.device_type == DeviceType.WujiHand2 or (d.sn or '').upper().startswith('WH2'))
             and not (d.address or '').startswith('zenoh://')]
if not hand_devs:
    print("===ERR:no hands")
    sys.exit(0)
hands = []
total_n = len(hand_devs)
print("===PROG:"+json.dumps({"phase":"diag","i":0,"n":total_n,"sn":""}), flush=True)
for idx, dev in enumerate(sorted(hand_devs, key=lambda d: d.sn)):
    sn = dev.sn
    ip = (dev.address or "").split(":")[0] if dev.address else ""
    handedness = "left" if sn[3:4]=="J" else ("right" if sn[3:4]=="K" else None)
    try:
        hand = manager.connect(sn=sn, device_name="diag_"+sn[-4:])
    except Exception as e:
        hands.append({"sn":sn,"handedness":handedness,"firmware":None,"ip":ip,"offline":True,
            "warningJoints":[],"faults":[],"jointsOnline":None,"tempMax":None,"tempMin":None,
            "voltMax":None,"voltMin":None,"minResponseRate":None,"commTimeouts":0,
            "healthStatus":None,"healthy":False,"error":str(e)[:200]})
        continue
    try:
        online = hand.online_joints_count().get()
        firmware = None
        try:
            fw = hand.firmware_version().get()
            firmware = safe_val(fw)
        except: pass
        sub = hand.joint_diagnostics().subscribe()
        joints = []
        deadline = time.monotonic()+15
        while time.monotonic() < deadline and not joints:
            time.sleep(0.2)
            fr = sub.recv()
            if fr and fr.joints: joints = fr.joints
        sub.close()
        warns, faults, temps, volts, rates, timeouts = [], [], [], [], [], 0
        for j in joints:
            nid = getattr(j, "nid", None)
            c = getattr(j, "error_code_current", 0) or 0
            if c and c < 256: warns.append(nid)
            t = safe_float(getattr(j, "mcu_temp_c_fb", None))
            v = safe_float(getattr(j, "vbus_v_fb", None))
            if t is not None: temps.append(t)
            if v is not None: volts.append(v)
            r = safe_float(getattr(j, "comm_response_rate_pct", None))
            if r is not None: rates.append(r)
            timeouts += getattr(j, "comm_timeout_total", 0) or 0
            if c >= 256:
                path = jpath(nid)
                sev = "stop"
                entries = []
                try:
                    info = hand.describe_error(c)
                    if isinstance(info, dict):
                        s = info.get("severity","")
                        if "fatal" in s: sev = "fatal"
                        elif "immediate" in s: sev = "immediate_stop"
                        elif "deferred" in s: sev = "deferred_stop"
                except: pass
                faults.append({"nid":nid,"joint":path,"code":c,"severity":sev,"log":entries})
        hs = None
        try:
            raw = hand.get("health_status")
            if isinstance(raw, (list, tuple)): hs = list(raw)
            elif isinstance(raw, bytes): hs = list(raw)
            else: hs = safe_val(raw)
        except: pass
        r1 = lambda v: round(v,1) if v is not None else None
        offline = not joints and online == 0
        valid_rates = [r for r in rates if r is not None and r > 0]
        healthy = False if offline else (None if not joints else (not faults and online==20 and (not valid_rates or min(valid_rates)>=99)))
        hands.append({"sn":sn,"handedness":handedness,"firmware":firmware,"ip":ip,"offline":offline,
            "warningJoints":warns,"faults":faults,"jointsOnline":online or None,
            "tempMax":r1(max(temps)) if temps else None,"tempMin":r1(min(temps)) if temps else None,
            "voltMax":r1(max(volts)) if volts else None,"voltMin":r1(min(volts)) if volts else None,
            "minResponseRate":r1(min(rates)) if rates else None,"commTimeouts":timeouts,
            "healthStatus":hs,"healthy":healthy})
    except Exception as e:
        hands.append({"sn":sn,"handedness":handedness,"firmware":None,"ip":ip,"offline":True,
            "warningJoints":[],"faults":[],"jointsOnline":None,"tempMax":None,"tempMin":None,
            "voltMax":None,"voltMin":None,"minResponseRate":None,"commTimeouts":0,
            "healthStatus":None,"healthy":False,"error":str(e)[:200]})
    finally:
        try: manager.disconnect(sn)
        except: pass
    print("===PROG:"+json.dumps({"phase":"diag","i":idx+1,"n":total_n,"sn":sn}), flush=True)
hands.sort(key=lambda h: h.get("handedness")!="left")
print("===PROG:"+json.dumps({"phase":"done","i":total_n,"n":total_n}), flush=True)
manager.disconnect_all()
print("===HANDS:"+json.dumps(safe_val(hands), ensure_ascii=False))`;
      const fs = require('fs');
      const tmpFile = '/tmp/wuji_diag_' + Date.now() + '.py';
      fs.writeFileSync(tmpFile, py);
      const importerContainer = await resolveContainer('importer');
      if (!importerContainer) {
        diagStatus.running = false;
        diagStatus.phase = 'error';
        diagStatus.message = '未找到运行中的 importer 容器';
        diagStatus.finishedAt = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未找到运行中的 importer 容器' }));
        try { fs.unlinkSync(tmpFile); } catch {}
        return;
      }
      const sdkCheck = await execDockerForRole(
        'importer',
        '检查 Wuji SDK',
        (container) => `docker exec ${container} sh -c 'ls /usr/local/lib/python3*/site-packages/wuji_sdk >/dev/null 2>&1 && echo yes || echo no'`,
        { timeout: 5000 }
      );
      if ((sdkCheck.stdout || '').trim() === 'no') {
        try {
          await execDockerForRole(
            'importer',
            '安装 Wuji SDK',
            (container) => `docker exec ${container} /usr/local/bin/pip install --quiet wuji-sdk`,
            { timeout: 60000 },
          );
        } catch { }
      }
      const remoteFile = '/tmp/wuji_diag_' + Date.now() + '.py';
      // 初始化诊断进度状态（供前端轮询 /diagnose-progress）
      diagStatus.running = true;
      diagStatus.phase = 'scan';
      diagStatus.total = 0;
      diagStatus.current = 0;
      diagStatus.sn = null;
      diagStatus.message = '正在扫描设备...';
      diagStatus.startedAt = Date.now();
      diagStatus.finishedAt = null;
      let out;
      try {
        const { result: r } = await execStreamDockerFilesForRole(
          'importer',
          '上传并执行灵巧手诊断',
          [{ local: tmpFile, remote: remoteFile }],
          (container) => `docker exec ${container} sh -c 'PYTHONPATH=$(ls -d /usr/local/lib/python3*/site-packages 2>/dev/null | tr "\\n" ":") exec /usr/bin/timeout -k 5s 110s /usr/local/bin/python3 -u ${remoteFile}'`,
          (line) => {
            if (!line.startsWith('===PROG:')) return;
            try {
              const p = JSON.parse(line.slice('===PROG:'.length).trim());
              diagStatus.phase = p.phase || diagStatus.phase;
              if (typeof p.n === 'number') diagStatus.total = p.n;
              if (typeof p.i === 'number') diagStatus.current = p.i;
              if (p.sn) diagStatus.sn = p.sn;
              if (diagStatus.phase === 'scan') diagStatus.message = '正在扫描网络中的灵巧手设备...';
              else if (diagStatus.phase === 'diag') {
                diagStatus.message = diagStatus.current > 0
                  ? '已完成 ' + diagStatus.current + '/' + diagStatus.total + ' 只手，正在读取诊断数据...'
                  : '准备诊断 ' + diagStatus.total + ' 只手...';
              }
            } catch { }
          },
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
        );
        out = r.stdout || '';
      } catch (e) {
        const stderr = (e.stderr || '').slice(-500);
        console.error(`[DiagHands] SDK 上传/执行失败: ${e.message} ${stderr}`);
        diagStatus.running = false;
        diagStatus.phase = 'error';
        diagStatus.message = '诊断执行失败';
        diagStatus.finishedAt = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `诊断执行失败: ${stderr || e.message}` }));
        try { fs.unlinkSync(tmpFile); } catch {}
        try {
          const cleanupContainer = await resolveContainer('importer');
          if (cleanupContainer) _execAsync(`docker exec ${cleanupContainer} rm -f ${remoteFile}`, { timeout: 3000 });
        } catch {}
        return;
      }
      try { fs.unlinkSync(tmpFile); } catch {}
      try {
        const cleanupContainer = await resolveContainer('importer');
        if (cleanupContainer) await _execAsync(`docker exec ${cleanupContainer} rm -f ${remoteFile}`, { timeout: 3000 });
      } catch {}
      const line = out.split('\n').find(l => l.startsWith('===HANDS:'));
      if (!line) {
        const isErr = out.includes('===ERR:');
        console.error(`[DiagHands] 未获取到灵巧手数据${isErr ? '（SDK 未发现设备）' : ''} stdout=${out.slice(-200)}`);
        diagStatus.running = false;
        diagStatus.phase = 'error';
        diagStatus.message = isErr ? '未发现已连接的灵巧手' : '诊断数据解析失败';
        diagStatus.finishedAt = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: isErr ? '未发现已连接的灵巧手' : '诊断数据解析失败' }));
        return;
      }
      let hands;
      try {
        hands = JSON.parse(line.slice('===HANDS:'.length));
      } catch (e) {
        console.error(`[DiagHands] JSON 解析失败: ${e.message}`);
        diagStatus.running = false;
        diagStatus.phase = 'error';
        diagStatus.message = '诊断数据解析失败';
        diagStatus.finishedAt = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '诊断数据解析失败' }));
        return;
      }
      diagStatus.running = false;
      diagStatus.phase = 'done';
      diagStatus.message = '检测完成，共 ' + hands.length + ' 只手';
      diagStatus.finishedAt = Date.now();
      console.log(`[DiagHands] 完成，${hands.length} 只手：` + hands.map(h => `${h.handedness}/${h.sn}${h.offline ? ' 离线无响应' : h.healthy ? ' 正常' : ` ${h.faults.length}处停止级故障`}`).join('；'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hands }));
    })().catch((e) => {
      console.error(`[DiagHands] 异常: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
  } else if (req.method === 'GET' && req.url && req.url.startsWith('/diagnose-progress')) {
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, progress: diagStatus }));
  } else if (req.method === 'POST' && req.url && req.url.startsWith('/arm-control')) {
    // Forward arm commands to the persistent SDK broker in importer.  This
    // branch intentionally returns before the legacy one-shot implementation
    // below, which is kept only for backwards source compatibility.
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, sdkCalled: false, error: 'unauthorized' }));
      return;
    }
    let armRaw = '';
    req.on('data', chunk => {
      armRaw += chunk;
      if (armRaw.length > 16384) req.destroy();
    });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(armRaw || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, sdkCalled: false, error: '请求参数不是有效 JSON' }));
        return;
      }
      try {
        const result = await runArmBrokerCommand(payload, 35000);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, sdkCalled: false, error: error.message }));
      }
    });
    return;

    /* Legacy one-shot implementation (unreachable; retained temporarily). */
    {
    req.resume();
    const token = req.headers['x-edge-token'] || '';
    if (!CONFIG.edgeToken || token !== CONFIG.edgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const action = body.action || '';
        const arm = (body.arm || 'A').toUpperCase();
        const state = parseInt(body.state, 10);
        const validActions = ['connect','disconnect','exit','set_state','clear_error','soft_stop','get_errors','disable','set_joint_mode','set_impedance_joint','set_impedance_cart','joint_drag','cart_drag','exit_drag','set_tool'];
        if (!validActions.includes(action)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '无效操作，支持: ' + validActions.join(', ') }));
          return;
        }
        if (!['A','B','AB'].includes(arm)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: "arm 必须为 A、B 或 AB" }));
          return;
        }
        if (action === 'set_state' && (isNaN(state) || state < 0 || state > 4)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'state 必须为 0-4: 0=下伺服 1=位置跟随 2=PVT 3=扭矩 4=协作释放' }));
          return;
        }
        console.log(`[ArmCtrl] 收到机械臂控制请求: action=${action} arm=${arm} state=${isNaN(state)?'N/A':state}`);

        // Python 脚本：通过 ctypes 加载 libMarvinSDK.so，连接机械臂并执行操作
        const py = `import json, sys, ctypes, os, time
ROBOT_IP = "192.168.1.190"
LIB_PATH = "/tmp/libMarvinSDK.so"
FAULT_DICT = {
  "0x2280":"驱动器短路","0x2310":"U相输出电流过大","0x2311":"V相输出电流过大","0x2320":"驱动器硬件过流",
  "0x2330":"驱动器输出对地短路","0x3130":"主电源输入异常","0x3210":"直流母线过压","0x3220":"直流母线欠压",
  "0x4210":"功率模块过热","0x6010":"CPU1看门狗溢出","0x6011":"CPU2看门狗溢出","0x7112":"能耗制动电阻过载",
  "0x8311":"电机持续过载","0x8611":"位置跟随误差过大","0x8612":"正向软限位","0x8613":"负向软限位",
  "0x8800":"编码器数据溢出","0xFF00":"CPU1工作异常","0xFF01":"CPU2工作异常","0xFF02":"CPU1内存异常",
  "0xFF03":"CPU2内存异常","0xFF04":"CPU内存冲突","0xFF05":"磁极定位错误","0xFF06":"编码器数据异常",
  "0xFF07":"编码器通信异常","0xFF08":"编码器通信超时","0xFF09":"编码器内部异常1","0xFF10":"驱动器其它轴异常",
  "0xFF11":"电机抱闸断线","0xFF14":"控制编码器超速","0xFF15":"驱动器持续过载","0xFF17":"驱动器输出缺相",
  "0xFF18":"电机失速","0xFF19":"协处理器通讯异常","0xFF20":"编码器AB信号变化异常","0xFF21":"电流跟随误差过大",
  "0xFF22":"位置目标值异常","0xFF23":"编码器上电位置异常","0xFF24":"位置目标值溢出","0xFF25":"电机抱闸异常",
  "0xFF26":"控制电源欠压","0xFF27":"STO1触发","0xFF28":"STO2触发","0xFF29":"正向硬限位开关触发",
  "0xFF30":"负向硬限位开关触发","0xFF31":"电机超速","0xFF32":"急停输入开关触发","0xFF33":"转矩饱和检测故障",
  "0xFF34":"速度跟随误差过大","0xFF35":"驱动器过流2","0xFF36":"寻原点失效","0xFF37":"EtherCAT过程数据错误",
  "0xFF38":"EtherCAT总线指令非法","0xFF39":"EtherCAT通讯周期错误","0xFF40":"位置规划运行错误","0xFF41":"EtherCAT非法同步模式",
  "0xFF42":"位置目标值超出设定范围","0xFF43":"整流模块过热","0xFF44":"散热器过热","0xFF45":"电机U相持续过载",
  "0xFF46":"电机V相持续过载","0xFF49":"驱动器内部异常","0xFF50":"限位开关异常","0xFF51":"EtherCAT总线通讯异常",
  "0xFF52":"接口编码器分辨率变更","0xFF53":"编码器过热","0xFF54":"编码器电池欠电压故障","0xFF57":"控制模式设定错误",
  "0xFF58":"上电位置偏差过大","0xFF59":"编码器加速度异常故障","0xFF60":"电机堵转","0xFF61":"电机过热",
  "0xFF62":"增量式编码器Z信号异常","0xFF63":"写EPROM数据异常","0xFF64":"读EPROM数据异常","0xFF65":"控制机功率异常",
  "0xFF66":"拖曳使能异常","0xFF67":"CPU过热","0xFF68":"CPU1过载","0xFF69":"CPU2过载",
  "0xFF70":"CPU1握手失效","0xFF71":"DriveMaster通讯超时","0xFF73":"力矩传感器异常","0xFF75":"ESC配置EEPROM异常",
  "0xFF76":"ESC内部访问错误","0xFF77":"伺服使能未准备好","0xFF78":"CPU2握手失败","0xFF79":"CPU1主任务超时",
  "0xFF80":"主电源掉电","0xFF81":"直流母线充电继电器异常","0xFF82":"CPU内部错误","0xFF83":"位置实际值溢出",
  "0xFF85":"编码器内部异常2","0xFF87":"编码器内部异常3","0xFF8A":"STO1电路诊断异常","0xFF8B":"STO2电路诊断异常",
  "0xFF8C":"霍尔信号异常","0xFF8D":"编码器霍尔-AB信号欠相异常","0xFF8E":"第2位置跟随误差过大","0xFF8F":"STO接线异常",
  "0xFF90":"第2速度跟随误差过大","0xFF91":"驱动器内部异常2",
}
ACTION = sys.argv[1] if len(sys.argv) > 1 else ""
ARM = sys.argv[2] if len(sys.argv) > 2 else "A"
STATE = int(sys.argv[3]) if len(sys.argv) > 3 else 0
try:
    lib = ctypes.CDLL(LIB_PATH)
except Exception as e:
    print(json.dumps({"ok": False, "error": f"加载 libMarvinSDK.so 失败: {e}"}))
    sys.exit(0)
ip_parts = [int(x) for x in ROBOT_IP.split(".")]
try:
    connected = lib.OnLinkTo(ctypes.c_ubyte(ip_parts[0]), ctypes.c_ubyte(ip_parts[1]),
                             ctypes.c_ubyte(ip_parts[2]), ctypes.c_ubyte(ip_parts[3]))
except Exception as e:
    print(json.dumps({"ok": False, "error": f"连接机械臂失败: {e}"}))
    sys.exit(0)
if not connected:
    print(json.dumps({"ok": False, "error": "无法连接机械臂(192.168.1.190)，请检查网络"}))
    sys.exit(0)
time.sleep(0.2)
result = {"ok": True, "action": ACTION, "arm": ARM}
try:
    if ACTION == "set_state":
        si = ctypes.c_int(STATE)
        if ARM == "A":
            r = lib.OnSetTargetState_A(si)
        elif ARM == "B":
            r = lib.OnSetTargetState_B(si)
        elif ARM == "AB":
            r1 = lib.OnSetTargetState_A(si)
            time.sleep(0.1)
            r2 = lib.OnSetTargetState_B(si)
            r = r1 and r2
        result["success"] = bool(r)
        result["state"] = STATE
        state_names = {0:"下伺服(IDLE)",1:"位置跟随(POSITION)",2:"PVT",3:"扭矩(TORQUE)",4:"协作释放(RELEASE)"}
        result["stateName"] = state_names.get(STATE, f"未知({STATE})")
    elif ACTION == "clear_error":
        if ARM == "A":
            lib.OnClearErr_A()
        elif ARM == "B":
            lib.OnClearErr_B()
        elif ARM == "AB":
            lib.OnClearErr_A()
            time.sleep(0.2)
            lib.OnClearErr_B()
        result["success"] = True
        time.sleep(0.2)
    elif ACTION == "soft_stop":
        if ARM == "A":
            lib.OnEMG_A()
        elif ARM == "B":
            lib.OnEMG_B()
        elif ARM == "AB":
            lib.OnEMG_AB()
        result["success"] = True
    elif ACTION == "disable":
        di = ctypes.c_int(0)
        if ARM == "A":
            r = lib.OnSetTargetState_A(di)
        elif ARM == "B":
            r = lib.OnSetTargetState_B(di)
        elif ARM == "AB":
            r1 = lib.OnSetTargetState_A(di)
            time.sleep(0.1)
            r2 = lib.OnSetTargetState_B(di)
            r = r1 and r2
        result["success"] = bool(r)
        result["stateName"] = "下伺服(IDLE)"
    elif ACTION == "get_errors":
        arms = ["A"] if ARM == "A" else (["B"] if ARM == "B" else ["A","B"])
        errors = {}
        for a in arms:
            err_arr = (ctypes.c_long * 7)()
            if a == "A":
                lib.OnGetServoErr_A(ctypes.byref(err_arr))
            else:
                lib.OnGetServoErr_B(ctypes.byref(err_arr))
            joint_errs = []
            for i in range(7):
                code = int(err_arr[i])
                if code == 0:
                    continue
                hex_code = hex(code).upper()
                desc = FAULT_DICT.get(hex_code, f"未知错误({hex_code})")
                joint_errs.append({"joint": i+1, "code": hex_code, "description": desc})
            errors[a] = joint_errs
        result["errors"] = errors
        result["hasError"] = any(len(v) > 0 for v in errors.values())
except Exception as e:
    result["ok"] = False
    result["error"] = str(e)
finally:
    try:
        lib.OnRelease()
    except:
        pass
print("===ARM:" + json.dumps(result, ensure_ascii=False))
`;
        const fs = require('fs');
        const tmpScript = '/tmp/marvin_arm_' + Date.now() + '.py';
        fs.writeFileSync(tmpScript, py);
        const importerContainer = await resolveContainer('importer');
        if (!importerContainer) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '未找到运行中的 importer 容器' }));
          try { fs.unlinkSync(tmpScript); } catch {}
          return;
        }
        const remoteScript = '/tmp/marvin_arm_' + Date.now() + '.py';
        const remoteLib = '/tmp/libMarvinSDK.so';
        try {
          // 拷贝 libMarvinSDK.so 和脚本到 importer 容器
          // 先从心跳代理容器拷到宿主机 /tmp，再从宿主机拷到 importer 容器
          const localLib = '/tmp/libMarvinSDK.so';
          try { await _execAsync(`docker cp gms-heartbeat-agent:/app/libMarvinSDK.so ${localLib}`, { timeout: 5000 }); } catch {}
        } catch (e) {
          console.error(`[ArmCtrl] docker cp 失败: ${e.message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `无法传输文件到容器: ${e.message}` }));
          try { fs.unlinkSync(tmpScript); } catch {}
          return;
        }
        let out;
        try {
          const r = await execDockerFilesForRole(
            'importer',
            '上传并执行机械臂控制',
            [
              { local: '/tmp/libMarvinSDK.so', remote: remoteLib },
              { local: tmpScript, remote: remoteScript },
            ],
            (container) => `docker exec ${container} sh -c 'export PYTHONPATH=$(ls -d /usr/local/lib/python3*/site-packages 2>/dev/null | head -1) && python3 ${remoteScript} ${action} ${arm} ${isNaN(state) ? 0 : state}'`,
            { timeout: 30000, maxBuffer: 1024 * 1024 }
          );
          out = r.stdout || '';
        } catch (e) {
          const stderr = (e.stderr || '').slice(-500);
          console.error(`[ArmCtrl] SDK 执行失败: ${e.message} ${stderr}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `执行失败: ${stderr || e.message}` }));
          try { fs.unlinkSync(tmpScript); } catch {}
          try {
            const cleanupContainer = await resolveContainer('importer');
            if (cleanupContainer) _execAsync(`docker exec ${cleanupContainer} rm -f ${remoteScript}`, { timeout: 3000 });
          } catch {}
          return;
        }
        try { fs.unlinkSync(tmpScript); } catch {}
        try {
          const cleanupContainer = await resolveContainer('importer');
          if (cleanupContainer) await _execAsync(`docker exec ${cleanupContainer} rm -f ${remoteScript}`, { timeout: 3000 });
        } catch {}
        const line = out.split('\n').find(l => l.startsWith('===ARM:'));
        if (!line) {
          console.error(`[ArmCtrl] 未获取到结果 stdout=${out.slice(-300)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '机械臂 SDK 未返回有效数据' }));
          return;
        }
        let armResult;
        try {
          armResult = JSON.parse(line.slice('===ARM:'.length));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '结果解析失败' }));
          return;
        }
        console.log(`[ArmCtrl] 完成: action=${action} arm=${arm} ok=${armResult.ok}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(armResult));
      })().catch((e) => {
        console.error(`[ArmCtrl] 异常: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    });
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] 收到信号 ${signal}，正在优雅关闭...`);
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  healthServer.close(() => console.log('[Shutdown] 健康检查服务已关闭'));

  httpRequest(`${CONFIG.backendUrl}/api/edge/offline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machineNumber: machineInfo.machineNumber }),
  })
    .then(() => console.log('[Shutdown] 离线通知已发送'))
    .catch((err) => console.error('[Shutdown] 离线通知发送失败:', err.message))
    .finally(() => process.exit(0));

  setTimeout(() => { console.error('[Shutdown] 超时，强制退出'); process.exit(1); }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main() {
  console.log('==========================================');
  console.log(`   GMS Machine Heartbeat Agent v${AGENT_VERSION}`);
  console.log('==========================================');
  console.log(`Backend URL: ${CONFIG.backendUrl}`);
  console.log(`Importer API: ${CONFIG.importerUrl}`);
  console.log(`Hermes API: ${CONFIG.hermesUrl}`);
  console.log(`Heartbeat Interval: ${CONFIG.heartbeatInterval / 1000}s`);
  console.log('------------------------------------------');

  if (!CONFIG.edgeToken) {
    console.error('❌ 启动失败: 未设置 EDGE_TOKEN 环境变量（需与服务端 .env 的 EDGE_TOKEN 一致）');
    process.exit(1);
  }

  machineInfo.machineNumber = detectMachineNumber();
  machineInfo.ipAddress = getPrimaryIPAddress();
  if (!machineInfo.machineNumber) {
    console.error('❌ 启动失败: 无法检测机器编号，请设置 MACHINE_NUMBER=we-100');
    process.exit(1);
  }
  console.log(`✅ 机器编号: ${machineInfo.machineNumber} / 主机: ${machineInfo.hostname} / IP: ${machineInfo.ipAddress}`);

  // 确保 adb daemon 在线（作为 client 连宿主机 daemon；如果不在线则在容器内 start-server 作为 fallback）
  try {
    const adbCheck = await _execAsync('adb devices', { timeout: 8000 });
    const adbOut = (adbCheck.stdout || '').trim();
    if (!adbOut.includes('\tdevice')) {
      console.log('[ADB] daemon 不在线或无设备，尝试 start-server...');
      try { await _execAsync('adb start-server', { timeout: 10000 }); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      const adbCheck2 = await _execAsync('adb devices', { timeout: 8000 });
      console.log('[ADB] daemon 已启动，设备:', (adbCheck2.stdout || '').trim().split('\n').slice(1).join('; ').trim() || '无');
    } else {
      console.log('[ADB] daemon 在线，设备:', adbOut.split('\n').slice(1).join('; ').trim());
    }
  } catch (e) {
    console.log('[ADB] adb 不可用:', e.message);
  }

  healthServer.listen(3000, () => console.log('[Health] http://localhost:3000/health'));

  snDetector = new GloveSNDetector({
    machineNumber: machineInfo.machineNumber,
    gmsBackend: CONFIG.backendUrl,
    resolveContainer,
    execAsync: _execAsync,
  });
  await scanSN();
  setInterval(scanSN, CONFIG.snRescanInterval);

  deviceDetector = new DeviceStatusDetector({
    machineNumber: machineInfo.machineNumber,
    resolveContainer,
    execAsync: _execAsync,
  });
  await scanDevices();
  setInterval(scanDevices, CONFIG.deviceScanInterval);
  setTimeout(() => scanWujiHands().catch(() => {}), 15000);
  await startCameraMonitoring();

  console.log('------------------------------------------');
  await pollCollectorApis(true);
  await sendHeartbeat();
  heartbeatLoop();
  console.log(`[Heartbeat] 心跳循环已启动（每 ${CONFIG.heartbeatInterval / 1000} 秒）\n`);
  startWsPusher();
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
