const net = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class DeviceStatusDetector {
  constructor(options = {}) {
    this.machineNumber = options.machineNumber;
    this.resolveContainer = typeof options.resolveContainer === 'function' ? options.resolveContainer : null;
    this.execAsync = options.execAsync || execAsync;

    this.devices = {

      glove_left: { ip: '192.168.1.100', port: 50001, type: 'glove' },
      glove_right: { ip: '192.168.1.101', port: 50001, type: 'glove' },

      dexterous_left: { ip: '192.168.1.110', port: 7447, type: 'dexterous_hand' },
      dexterous_right: { ip: '192.168.1.111', port: 7447, type: 'dexterous_hand' },

      robotic_arm: { ip: '192.168.1.190', port: 30003, type: 'robotic_arm' },

      quest: { type: 'quest' },
    };

    this.lastStatus = null;
  }

  async checkPingConnection(ip, timeout = 3000) {
    try {
      const startTime = Date.now();

      const timeoutSec = Math.ceil(timeout / 1000);
      const { stdout, stderr } = await execAsync(`ping -c 1 -W ${timeoutSec} ${ip}`, { timeout: timeout + 500 });

      const latency = Date.now() - startTime;

      if (stdout.includes('1 received') || stdout.includes('1 packets received')) {
        return { connected: true, latency };
      } else {
        return { connected: false, error: 'no_response' };
      }
    } catch (err) {
      return { connected: false, error: err.code || 'ping_failed' };
    }
  }

  async checkTCPConnection(ip, port, timeout = 3000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let isResolved = false;

      const cleanup = () => {
        if (!isResolved) {
          isResolved = true;
          socket.destroy();
        }
      };

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        cleanup();
        resolve({ connected: true, latency: Date.now() - startTime });
      });

      socket.on('timeout', () => {
        cleanup();
        resolve({ connected: false, error: 'timeout' });
      });

      socket.on('error', (err) => {
        cleanup();
        resolve({ connected: false, error: err.code });
      });

      const startTime = Date.now();
      socket.connect(port, ip);
    });
  }

  async getGloveSNFromDockerLogs() {
    try {
      console.log(`[Device Detector] [DEBUG] 开始提取 SN 码...`);
      let container = null;
      if (this.resolveContainer) container = await this.resolveContainer('collector');
      if (!container) {
        console.log(`[Device Detector] 未找到运行中的采集容器`);
        return { left: null, right: null };
      }
      console.log(`[Device Detector] 从采集容器 ${container} 提取 SN 码...`);
      const snCodes = { left: null, right: null };
      let logs;
      try {
        ({ stdout: logs } = await this.execAsync(`docker logs --tail 200000 ${container}`, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 }));
      } catch (error) {
        const text = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
        if (!this.resolveContainer || !/No such container|No such object|is not running|not found/i.test(text)) throw error;
        container = await this.resolveContainer('collector', { force: true });
        if (!container) return snCodes;
        ({ stdout: logs } = await this.execAsync(`docker logs --tail 200000 ${container}`, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 }));
      }

      const lines = String(logs || '').split('\n').filter(l => l.toLowerCase().includes('glove') && l.includes('sn='));
      console.log(`[Device Detector] 找到 ${lines.length} 行包含手套 SN 的日志`);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!snCodes.left) {
          const leftMatch = line.match(/wuji_glove_l.*sn=(WG[0-9A-Z]+)/);
          if (leftMatch) snCodes.left = leftMatch[1];
        }
        if (!snCodes.right) {
          const rightMatch = line.match(/wuji_glove_r.*sn=(WG[0-9A-Z]+)/);
          if (rightMatch) snCodes.right = rightMatch[1];
        }
        if (snCodes.left && snCodes.right) break;
      }
      if (snCodes.left) console.log(`[Device Detector] 左手 SN: ${snCodes.left}`);
      if (snCodes.right) console.log(`[Device Detector] 右手 SN: ${snCodes.right}`);

      return snCodes;
    } catch (error) {
      console.error(`[Device Detector] ❌ 从 Docker 日志提取手套 SN 码失败: ${error.message}`);
      console.error(`[Device Detector] ❌ 错误堆栈:`, error.stack);
      return { left: null, right: null };
    }
  }

  async checkQuestConnection() {
    try {

      const { stdout } = await execAsync('adb devices', { timeout: 5000 });

      const lines = stdout.split('\n').filter(line => line.trim() && !line.includes('List of devices'));

      if (lines.length === 0) {
        return {
          connected: false,
          error: 'no_device',
        };
      }

      const deviceLine = lines[0];
      const [serialNumber, status] = deviceLine.split('\t').map(s => s.trim());

      if (status !== 'device') {
        return {
          connected: false,
          error: status,
          serialNumber,
        };
      }

      const battery = await this.getQuestBattery();

      return {
        connected: true,
        serialNumber,
        battery,
      };

    } catch (error) {
      return {
        connected: false,
        error: error.message.includes('not found') ? 'adb_not_installed' : 'unknown',
      };
    }
  }

  async getQuestBattery() {
    try {
      const { stdout } = await execAsync('adb shell dumpsys battery', { timeout: 5000 });

      const levelMatch = stdout.match(/level: (\d+)/);
      const statusMatch = stdout.match(/status: (\d+)/);
      const temperatureMatch = stdout.match(/temperature: (\d+)/);

      const level = levelMatch ? parseInt(levelMatch[1]) : null;
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;
      const temperature = temperatureMatch ? parseInt(temperatureMatch[1]) / 10 : null;

      const statusMap = {
        1: 'unknown',
        2: 'charging',
        3: 'discharging',
        4: 'not_charging',
        5: 'full',
      };

      return {
        level,
        status: statusMap[statusCode] || 'unknown',
        temperature,
      };

    } catch (error) {
      return null;
    }
  }

  async getQuestControllerBattery() {
    try {

      const { stdout } = await execAsync(
        'adb shell "dumpsys battery | grep -E \'controller\'"',
        { timeout: 5000 }
      );

      if (stdout.trim()) {

        return {
          left: { level: null, charging: false },
          right: { level: null, charging: false },
        };
      }

      return null;

    } catch (error) {
      return null;
    }
  }

  async checkRoboticArm() {
    // 机械臂的 IP 可达与控制端口可用是两个独立状态。此前只检查 TCP
    // 端口，端口拒绝会被错误显示成「机械臂未连接」。
    const network = await this.checkPingConnection(this.devices.robotic_arm.ip);
    const control = await this.checkTCPConnection(
      this.devices.robotic_arm.ip,
      this.devices.robotic_arm.port
    );
    return {
      // connected 保持为硬件网络可达，供旧版消费端安全降级。
      connected: !!network.connected,
      networkConnected: !!network.connected,
      controlConnected: !!control.connected,
      ip: this.devices.robotic_arm.ip,
      port: this.devices.robotic_arm.port,
      latency: network.latency || null,
      controlLatency: control.latency || null,
      networkError: network.connected ? null : network.error || 'no_response',
      controlError: control.connected ? null : control.error || 'unavailable',
    };
  }

  async detectAll() {
    console.log('[Device Detector] ==========================================');
    console.log('[Device Detector] 开始检测设备状态');
    console.log('[Device Detector] ==========================================');
    console.log('');

    const status = {
      gloves: {
        left: null,
        right: null,
      },
      dexterousHands: {
        left: null,
        right: null,
      },
      roboticArm: null,
      quest: null,
      questControllers: null,
      machineType: null,
      timestamp: new Date().toISOString(),
    };

    console.log('[Device Detector] 检测手套（PING）...');
    status.gloves.left = await this.checkPingConnection(this.devices.glove_left.ip);
    status.gloves.right = await this.checkPingConnection(this.devices.glove_right.ip);
    console.log(`  左手 (${this.devices.glove_left.ip}): ${status.gloves.left.connected ? '✅' : '❌'}`);
    console.log(`  右手 (${this.devices.glove_right.ip}): ${status.gloves.right.connected ? '✅' : '❌'}`);

    if (status.gloves.left.connected || status.gloves.right.connected) {
      console.log('[Device Detector] 从 Docker 日志提取手套 SN 码...');
      const snCodes = await this.getGloveSNFromDockerLogs();
      if (snCodes.left) {
        status.gloves.left.snCode = snCodes.left;
        console.log(`  左手 SN: ${snCodes.left}`);
      }
      if (snCodes.right) {
        status.gloves.right.snCode = snCodes.right;
        console.log(`  右手 SN: ${snCodes.right}`);
      }
    }
    console.log('');

    const numMatch = /^(?:we|szx3)-(\d+)$/.exec(String(this.machineNumber || ''));
    const isGloveMachine = numMatch ? parseInt(numMatch[1], 10) < 100 : false;
    if (isGloveMachine) {
      status.dexterousHands = null;
      status.machineType = 'glove_only';
      console.log('[Device Detector] 纯手套机器（编号<100），无灵巧手/机械臂，跳过探测');
      console.log('');
    } else {
      console.log('[Device Detector] 检测灵巧手（PING）...');
      status.dexterousHands.left = await this.checkPingConnection(this.devices.dexterous_left.ip);
      status.dexterousHands.right = await this.checkPingConnection(this.devices.dexterous_right.ip);
      console.log(`  左手 (${this.devices.dexterous_left.ip}): ${status.dexterousHands.left.connected ? '✅' : '❌'}`);
      console.log(`  右手 (${this.devices.dexterous_right.ip}): ${status.dexterousHands.right.connected ? '✅' : '❌'}`);
      console.log('');

      const hasDexterous = status.dexterousHands.left.connected || status.dexterousHands.right.connected;
      status.machineType = numMatch ? (parseInt(numMatch[1], 10) >= 100 ? 'dexterous' : 'glove_only') : (hasDexterous ? 'dexterous' : 'glove_only');
      console.log(`[Device Detector] 机器类型: ${status.machineType === 'dexterous' ? '灵巧手机器' : '纯手套机器'}`);
      console.log('');
    }

    console.log('[Device Detector] 检测 Quest 头显...');
    status.quest = await this.checkQuestConnection();
    console.log(`  状态: ${status.quest.connected ? '✅' : '❌'}`);
    if (status.quest.connected) {
      console.log(`  序列号: ${status.quest.serialNumber}`);
      if (status.quest.battery) {
        console.log(`  电量: ${status.quest.battery.level}%`);
        console.log(`  状态: ${status.quest.battery.status}`);
        if (status.quest.battery.temperature) {
          console.log(`  温度: ${status.quest.battery.temperature}°C`);
        }
      }
    } else {
      console.log(`  错误: ${status.quest.error}`);
    }
    console.log('');

    if (status.quest.connected) {
      console.log('[Device Detector] 检测 Quest 手柄...');
      status.questControllers = await this.getQuestControllerBattery();
      if (status.questControllers) {
        console.log(`  左手柄: ${status.questControllers.left.level ? status.questControllers.left.level + '%' : '未知'}`);
        console.log(`  右手柄: ${status.questControllers.right.level ? status.questControllers.right.level + '%' : '未知'}`);
      } else {
        console.log(`  ⚠️  无法获取手柄电量（可能需要特定应用支持）`);
      }
      console.log('');
    }

    if (status.machineType === 'dexterous') {
      console.log('[Device Detector] 检测机械臂...');
      status.roboticArm = await this.checkRoboticArm();
      console.log(`  状态: ${status.roboticArm.connected ? '✅' : '❌'}`);
      if (status.roboticArm.connected) {
        console.log(`  延迟: ${status.roboticArm.latency}ms`);
      }
      console.log('');
    }

    console.log('[Device Detector] ==========================================');
    console.log('[Device Detector] 检测完成');
    console.log('[Device Detector] ==========================================');
    console.log('');

    this.lastStatus = status;
    return status;
  }

  getLastStatus() {
    return this.lastStatus;
  }

  getDeviceSummary() {
    if (!this.lastStatus) {
      return null;
    }

    const summary = {
      machineType: this.lastStatus.machineType,
      // 轻量网络探测的时间。前端用它判断设备状态是否仍然新鲜，
      // 不把上一轮成功结果误当成当前实时状态。
      checkedAt: this.lastStatus.timestamp,
      gloves: {
        left: { connected: !!this.lastStatus.gloves.left.connected, checkedAt: this.lastStatus.timestamp },
        right: { connected: !!this.lastStatus.gloves.right.connected, checkedAt: this.lastStatus.timestamp },
      },
      quest: {
        connected: this.lastStatus.quest?.connected || false,
        serialNumber: this.lastStatus.quest?.serialNumber || null,
        error: this.lastStatus.quest?.error || null,

        battery: this.lastStatus.quest?.battery || null,
      },
    };

    if (this.lastStatus.questControllers) {
      summary.questControllers = {
        left: this.lastStatus.questControllers.left.level,
        right: this.lastStatus.questControllers.right.level,
      };
    }

    if (this.lastStatus.dexterousHands && this.lastStatus.dexterousHands.left && this.lastStatus.dexterousHands.right) {
      summary.dexterousHands = {
        left: { connected: !!this.lastStatus.dexterousHands.left.connected, checkedAt: this.lastStatus.timestamp },
        right: { connected: !!this.lastStatus.dexterousHands.right.connected, checkedAt: this.lastStatus.timestamp },
      };
    }

    if (this.lastStatus.machineType === 'dexterous') {
      summary.roboticArm = {
        connected: this.lastStatus.roboticArm?.connected || false,
        networkConnected: this.lastStatus.roboticArm?.networkConnected || false,
        controlConnected: this.lastStatus.roboticArm?.controlConnected || false,
        ip: this.lastStatus.roboticArm?.ip || this.devices.robotic_arm.ip,
        port: this.lastStatus.roboticArm?.port || this.devices.robotic_arm.port,
        latency: this.lastStatus.roboticArm?.latency || null,
        controlLatency: this.lastStatus.roboticArm?.controlLatency || null,
        networkError: this.lastStatus.roboticArm?.networkError || null,
        controlError: this.lastStatus.roboticArm?.controlError || null,
        checkedAt: this.lastStatus.timestamp,
      };
    }

    return summary;
  }
}

module.exports = DeviceStatusDetector;

if (require.main === module) {
  const detector = new DeviceStatusDetector({
    machineNumber: 'we-105',
  });

  (async () => {
    const status = await detector.detectAll();

    console.log('完整状态 JSON:');
    console.log(JSON.stringify(status, null, 2));
    console.log('');

    console.log('心跳摘要 JSON:');
    console.log(JSON.stringify(detector.getDeviceSummary(), null, 2));
  })();
}
