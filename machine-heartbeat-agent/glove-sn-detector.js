const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');

const execAsync = promisify(exec);

class GloveSNDetector {
  constructor(options = {}) {
    this.machineNumber = options.machineNumber;
    this.gmsBackend = options.gmsBackend || 'http://10.5.51.216:8765';

    this.rdc2Path = '/var/.rdc2';
    this.wujiCalibPath = '/var/.rdc2/wuji_calib';
    this.containerName = options.containerName || 'importer-staging';
    this.collectorContainer = options.collectorContainer || process.env.COLLECTOR_CONTAINER || 'mono-staging';
    this.resolveContainer = typeof options.resolveContainer === 'function' ? options.resolveContainer : null;
    this.execAsync = options.execAsync || execAsync;

    this.gloveIPs = {
      left: '192.168.1.100:50001',
      right: '192.168.1.101:50001',
    };

    this.detectedSN = {
      left: null,
      right: null,
    };
  }

  async getContainer(role, fallback) {
    if (this.resolveContainer) {
      try {
        const resolved = await this.resolveContainer(role);
        if (resolved) return resolved;
        return null;
      } catch (error) {
        console.warn(`[SN Detector] ${role} 容器解析失败: ${error.message}`);
        return null;
      }
    }
    return fallback || null;
  }

  async runContainerCommand(role, fallback, commandFactory, options = {}) {
    let container = await this.getContainer(role, fallback);
    if (!container) return { container: null, stdout: '' };
    try {
      const result = await this.execAsync(commandFactory(container), options);
      return { container, stdout: result.stdout || '' };
    } catch (error) {
      const text = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
      if (!/No such container|No such object|is not running|not found/i.test(text) || !this.resolveContainer) throw error;
      try {
        container = await this.resolveContainer(role, { force: true });
        if (!container) return { container: null, stdout: '' };
        const result = await this.execAsync(commandFactory(container), options);
        return { container, stdout: result.stdout || '' };
      } catch (retryError) {
        throw retryError;
      }
    }
  }

  async httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 5000,
      };

      const req = http.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode, body: data });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  async detectFromCalibration() {
    try {
      const calibPath = this.wujiCalibPath;

      try {
        await fs.access(calibPath);
      } catch {
        console.log('[SN Detector] wuji_calib 目录不存在');
        return null;
      }

      const result = { left: null, right: null };

      const leftPath = path.join(calibPath, 'left');
      try {
        const files = await fs.readdir(leftPath);

        for (const file of files) {
          if (file.includes('sn') || file.includes('serial') || file.endsWith('.json')) {
            const content = await fs.readFile(path.join(leftPath, file), 'utf8');

            const snMatch = content.match(/W[GH][0-9A-Z][JK][A-Z0-9]{6,}/i);
            if (snMatch) {
              result.left = snMatch[0].toUpperCase();
              break;
            }
          }
        }
      } catch (e) {

      }

      const rightPath = path.join(calibPath, 'right');
      try {
        const files = await fs.readdir(rightPath);
        for (const file of files) {
          if (file.includes('sn') || file.includes('serial') || file.endsWith('.json')) {
            const content = await fs.readFile(path.join(rightPath, file), 'utf8');
            const snMatch = content.match(/W[GH][0-9A-Z][JK][A-Z0-9]{6,}/i);
            if (snMatch) {
              result.right = snMatch[0].toUpperCase();
              break;
            }
          }
        }
      } catch (e) {

      }

      if (result.left || result.right) {
        console.log('[SN Detector] 从 wuji_calib 检测到 SN:');
        if (result.left) console.log(`  左手: ${result.left}`);
        if (result.right) console.log(`  右手: ${result.right}`);
        return result;
      }

      return null;
    } catch (error) {
      console.error('[SN Detector] 读取 wuji_calib 失败:', error.message);
      return null;
    }
  }

  async detectFromGloveAPI(hand) {
    try {
      const ip = this.gloveIPs[hand];
      if (!ip) return null;

      const [host, port] = ip.split(':');

      const url = `http://${host}:${port}/api/device/info`;

      try {
        const response = await this.httpRequest(url);
        if (response.body && response.body.serialNumber) {
          return response.body.serialNumber.toUpperCase();
        }
      } catch (e) {

      }

      return null;
    } catch (error) {
      return null;
    }
  }

  async detectFromContainer() {
    try {
      const { stdout } = await this.runContainerCommand(
        'importer',
        this.containerName,
        (container) => `docker exec ${container} cat /exchange/machine.jsonc`,
        { timeout: 5000 },
      );

      if (!stdout) return null;

      const result = { left: null, right: null };

      const leftMatch = stdout.match(/wuji_glove_l.*?sn[^:]*:\s*["']?([A-Z0-9]+)["']?/i);
      const rightMatch = stdout.match(/wuji_glove_r.*?sn[^:]*:\s*["']?([A-Z0-9]+)["']?/i);

      if (leftMatch) result.left = leftMatch[1].toUpperCase();
      if (rightMatch) result.right = rightMatch[1].toUpperCase();

      if (!result.left) {
        const snMatch = stdout.match(/left.*?(W[GH][0-9A-Z][JK][A-Z0-9]{6,})/i);
        if (snMatch) result.left = snMatch[1].toUpperCase();
      }
      if (!result.right) {
        const snMatch = stdout.match(/right.*?(W[GH][0-9A-Z][JK][A-Z0-9]{6,})/i);
        if (snMatch) result.right = snMatch[1].toUpperCase();
      }

      if (result.left || result.right) {
        console.log('[SN Detector] 从容器配置检测到 SN:');
        if (result.left) console.log(`  左手: ${result.left}`);
        if (result.right) console.log(`  右手: ${result.right}`);
        return result;
      }

      return null;
    } catch (error) {
      console.error('[SN Detector] 读取容器配置失败:', error.message);
      return null;
    }
  }

  async detectFromGMS() {
    try {
      if (!this.machineNumber) return null;

      const url = `${this.gmsBackend}/api/sn-registry?machineNumber=${this.machineNumber}&status=in_use`;

      const response = await this.httpRequest(url);

      if (response.body && Array.isArray(response.body)) {
        const result = { left: null, right: null };

        for (const item of response.body) {
          if (item.handType === 'left' && !result.left) {
            result.left = item.snCode;
          }
          if (item.handType === 'right' && !result.right) {
            result.right = item.snCode;
          }
        }

        if (result.left || result.right) {
          console.log('[SN Detector] 从 GMS 后端查询到 SN:');
          if (result.left) console.log(`  左手: ${result.left}`);
          if (result.right) console.log(`  右手: ${result.right}`);
          return result;
        }
      }

      return null;
    } catch (error) {
      console.error('[SN Detector] 查询 GMS 后端失败:', error.message);
      return null;
    }
  }

  async detectAll() {
    console.log('[SN Detector] 开始检测手套 SN 码...');
    console.log(`  机器编号: ${this.machineNumber}`);
    console.log('');

    const methods = [
      { name: 'wuji_calib', fn: () => this.detectFromCalibration() },
      { name: 'container', fn: () => this.detectFromContainer() },
      { name: 'GMS backend', fn: () => this.detectFromGMS() },
      { name: 'collector-logs', fn: () => this.detectFromCollectorLogs() },
    ];

    let finalResult = { left: null, right: null, handLeft: null, handRight: null };

    for (const method of methods) {
      console.log(`[SN Detector] 尝试方式: ${method.name}...`);
      const result = await method.fn();

      if (result) {

        if (result.left && !finalResult.left) {
          finalResult.left = result.left;
        }
        if (result.right && !finalResult.right) {
          finalResult.right = result.right;
        }
        if (result.handLeft && !finalResult.handLeft) {
          finalResult.handLeft = result.handLeft;
        }
        if (result.handRight && !finalResult.handRight) {
          finalResult.handRight = result.handRight;
        }

        if (finalResult.left && finalResult.right && finalResult.handLeft && finalResult.handRight) {
          break;
        }
      }
    }

    this.detectedSN = finalResult;

    console.log('');
    console.log('[SN Detector] 检测完成:');
    console.log(`  左手 SN: ${finalResult.left || '未检测到'}`);
    console.log(`  右手 SN: ${finalResult.right || '未检测到'}`);
    console.log('');

    return finalResult;
  }

  async detectFromCollectorLogs() {
    try {
      const { stdout } = await this.runContainerCommand(
        'collector',
        this.collectorContainer,
        (container) => `docker logs --tail 200000 ${container}`,
        { timeout: 9000, maxBuffer: 20 * 1024 * 1024 },
      );

      const result = { left: null, right: null, handLeft: null, handRight: null };
      const snRe = /W(?:G|H)[0-9A-Z][JK][A-Z0-9]{6,}/;

      for (const line of stdout.split('\n')) {
        const isLeft = /wuji_glove_l|hand_left|wuji_hand_l/.test(line);
        const isRight = /wuji_glove_r|hand_right|wuji_hand_r/.test(line);
        if (!isLeft && !isRight) continue;
        const m = line.match(snRe);
        if (!m) continue;
        const sn = m[0].toUpperCase();
        const isHand = /WujiHand|wuji_hand/.test(line) || sn.startsWith('WH');
        if (isHand) {
          if (isLeft) result.handLeft = sn;
          if (isRight) result.handRight = sn;
        } else {
          if (isLeft) result.left = sn;
          if (isRight) result.right = sn;
        }
      }

      if (result.left || result.right || result.handLeft || result.handRight) {
        console.log('[SN Detector] 从采集容器日志检测到 SN:', JSON.stringify(result));
        return result;
      }
      return null;
    } catch (error) {
      console.error('[SN Detector] 读取容器日志失败:', error.message);
      return null;
    }
  }

  async reportToGMS() {
    return true;
  }

  getDetectedSN() {
    return this.detectedSN;
  }
}

module.exports = GloveSNDetector;

if (require.main === module) {
  const detector = new GloveSNDetector({
    machineNumber: 'we-105',
    gmsBackend: 'http://10.5.51.216:8765',
    containerName: 'importer-staging',
  });

  (async () => {
    await detector.detectAll();
    await detector.reportToGMS();
  })();
}
