#!/usr/bin/env node
/**
 * 摄像头监控模块
 *
 * 功能：
 * 1. 检测系统中的摄像头设备
 * 2. 监控摄像头实时帧率
 * 3. 检测掉帧情况（实际帧率 < 预期帧率）
 * 4. 上报异常到 GMS 后端
 *
 * 支持平台：Linux (V4L2)、Windows (DirectShow)、macOS (AVFoundation)
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

class CameraMonitor {
  constructor(options = {}) {
    this.platform = os.platform();
    this.checkInterval = options.checkInterval || 5000; // 检查间隔（毫秒）
    this.expectedFPS = options.expectedFPS || 30;       // 期望帧率
    this.fpsThreshold = options.fpsThreshold || 0.8;    // 掉帧阈值（80%）
    this.sampleFrames = options.sampleFrames || 30;
    this.commandTimeout = options.commandTimeout || Math.max(5000, this.checkInterval - 500);
    this.cameras = [];
    this.monitoring = false;
    this.checkTimer = null;
  }

  // ==================== 检测摄像头设备 ====================
  async detectCameras() {
    try {
      if (this.platform === 'linux') {
        return await this.detectCamerasLinux();
      } else if (this.platform === 'win32') {
        return await this.detectCamerasWindows();
      } else if (this.platform === 'darwin') {
        return await this.detectCamerasMacOS();
      } else {
        console.warn(`[Camera] 不支持的平台: ${this.platform}`);
        return [];
      }
    } catch (error) {
      console.error('[Camera] 检测摄像头失败:', error.message);
      return [];
    }
  }

  // Linux: 使用 v4l2-ctl
  async detectCamerasLinux() {
    const cameras = [];

    // 检查 /dev/video* 设备
    try {
      const { stdout } = await execAsync('ls /dev/video* 2>/dev/null || echo ""');
      const devices = stdout.trim().split('\n').filter(d => d);

      for (const device of devices) {
        try {
          // 使用 v4l2-ctl 获取设备信息
          const { stdout: info } = await execAsync(`v4l2-ctl --device=${device} --all 2>/dev/null || echo ""`, { timeout: 5000 });

          // Metadata-only nodes (for example RealSense metadata) cannot provide FPS.
          if (!/Device Caps\s*:[\s\S]*Video Capture/i.test(info)) continue;

          // 解析设备名称
          const nameMatch = info.match(/Card type\s*:\s*(.+)/);
          const name = nameMatch ? nameMatch[1].trim() : device;

          // 读取当前 V4L2 stream 参数；--all 的输出在不同驱动上格式不一致，
          // 所以优先匹配 Frames per second，失败时再使用默认值。
          const fpsMatch = info.match(/Frames per second\s*:\s*(\d+(?:\.\d+)?)/i)
            || info.match(/(\d+(?:\.\d+)?)\s*fps/i);
          const maxFPS = fpsMatch ? parseFloat(fpsMatch[1]) : 30;
          const sizeMatch = info.match(/Width\/Height\s*:\s*(\d+)\s*\/\s*(\d+)/i);
          const pixelFormatMatch = info.match(/Pixel Format\s*:\s*'([^']+)'/i);

          cameras.push({
            device,
            name,
            maxFPS,
            width: sizeMatch ? parseInt(sizeMatch[1], 10) : null,
            height: sizeMatch ? parseInt(sizeMatch[2], 10) : null,
            pixelFormat: pixelFormatMatch ? pixelFormatMatch[1].trim() : null,
            currentFPS: 0,
            status: 'unknown',
          });
        } catch (e) {
          console.warn(`[Camera] 无法读取设备信息: ${device}`);
        }
      }
    } catch (error) {
      console.error('[Camera] Linux 摄像头检测失败:', error.message);
    }

    // 将宿主机设备节点映射为业务相机。RealSense 的深度/红外节点不是
    // 前置视频流，选择彩色节点作为 ego_camera；两个 USB Camera 按稳定的
    // 设备节点顺序对应左右手腕相机。
    const realsense = cameras.filter(camera => /realsense/i.test(camera.name));
    const ego = realsense
      .filter(camera => !/^Z16/i.test(camera.pixelFormat || ''))
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0]
      || realsense[realsense.length - 1];
    const usb = cameras
      .filter(camera => /usb camera/i.test(camera.name))
      .sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }));
    for (const camera of cameras) camera.cameraId = null;
    if (ego) ego.cameraId = 'ego_camera';
    if (usb[0]) usb[0].cameraId = 'wrist_left';
    if (usb[1]) usb[1].cameraId = 'wrist_right';
    return cameras;
  }

  // Windows: 使用 PowerShell
  async detectCamerasWindows() {
    const cameras = [];

    try {
      const script = `
        Get-CimInstance Win32_PnPEntity |
        Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' } |
        Select-Object Name, DeviceID, Status |
        ConvertTo-Json
      `;

      const { stdout } = await execAsync(`powershell -Command "${script}"`, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      });

      const devices = JSON.parse(stdout);
      const deviceArray = Array.isArray(devices) ? devices : [devices];

      deviceArray.forEach((device, index) => {
        if (device && device.Name) {
          cameras.push({
            device: `camera${index}`,
            name: device.Name,
            deviceID: device.DeviceID,
            maxFPS: 30, // Windows 默认假设 30fps
            currentFPS: 0,
            status: device.Status === 'OK' ? 'active' : 'error',
          });
        }
      });
    } catch (error) {
      console.error('[Camera] Windows 摄像头检测失败:', error.message);
    }

    return cameras;
  }

  // macOS: 使用 system_profiler
  async detectCamerasMacOS() {
    const cameras = [];

    try {
      const { stdout } = await execAsync('system_profiler SPCameraDataType -json');
      const data = JSON.parse(stdout);

      if (data.SPCameraDataType && data.SPCameraDataType.length > 0) {
        data.SPCameraDataType.forEach((camera, index) => {
          cameras.push({
            device: `camera${index}`,
            name: camera._name || `Camera ${index}`,
            maxFPS: 30,
            currentFPS: 0,
            status: 'active',
          });
        });
      }
    } catch (error) {
      console.error('[Camera] macOS 摄像头检测失败:', error.message);
    }

    return cameras;
  }

  // ==================== 监控摄像头帧率 ====================
  async checkCameraFPS(camera) {
    try {
      if (this.platform === 'linux') {
        return await this.checkFPSLinux(camera);
      } else if (this.platform === 'win32') {
        return await this.checkFPSWindows(camera);
      } else if (this.platform === 'darwin') {
        return await this.checkFPSMacOS(camera);
      }
      return null;
    } catch (error) {
      console.error(`[Camera] 检测帧率失败 ${camera.device}:`, error.message);
      return null;
    }
  }

  // Linux: 先实际拉取固定数量的帧，再用耗时计算 FPS。
  async checkFPSLinux(camera) {
    const startedAt = Date.now();
    try {
      await execAsync(
        `v4l2-ctl --device=${camera.device} --stream-mmap --stream-count=${this.sampleFrames} --stream-to=/dev/null`,
        { timeout: this.commandTimeout, maxBuffer: 1024 * 1024 }
      );
      const elapsed = Math.max(Date.now() - startedAt, 1) / 1000;
      const measuredFPS = this.sampleFrames / elapsed;
      // 某些 UVC 驱动会把已排队的帧瞬间吐出，不能把这个 burst
      // 当成真实帧率；以 V4L2 当前模式上限作保护。
      const fps = Math.min(measuredFPS, camera.maxFPS || this.expectedFPS);
      return {
        fps,
        isDropping: fps < this.expectedFPS * this.fpsThreshold,
        timestamp: new Date().toISOString(),
        method: 'v4l2-stream',
      };
    } catch (error) {
      // Some drivers do not support v4l2-ctl streaming; ffmpeg is the fallback.
      try {
        const { stdout, stderr } = await execAsync(
          `ffmpeg -hide_banner -loglevel info -f v4l2 -i ${camera.device} -frames:v ${this.sampleFrames} -f null - 2>&1`,
          { timeout: this.commandTimeout, maxBuffer: 4 * 1024 * 1024 }
        );
        const output = `${stdout}\n${stderr}`;
        const frameMatches = [...output.matchAll(/frame=\s*(\d+)/g)];
        const frames = frameMatches.length ? parseInt(frameMatches[frameMatches.length - 1][1], 10) : this.sampleFrames;
        const elapsed = Math.max(Date.now() - startedAt, 1) / 1000;
        const measuredFPS = frames / elapsed;
        const fps = Math.min(measuredFPS, camera.maxFPS || this.expectedFPS);
        if (Number.isFinite(fps) && frames > 0) {
          return {
            fps,
            isDropping: fps < this.expectedFPS * this.fpsThreshold,
            timestamp: new Date().toISOString(),
            method: 'ffmpeg-stream',
          };
        }
      } catch (fallbackError) {
        // The device may be busy or disconnected; report an error instead of fabricating FPS.
      }
    }

    return null;
  }

  // Windows: 使用 ffmpeg
  async checkFPSWindows(camera) {
    try {
      // Windows 使用 DirectShow
      const cmd = `ffmpeg -f dshow -i video="${camera.name}" -vframes 30 -f null - 2>&1`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 3000 });
      const output = stdout + stderr;

      const fpsMatch = output.match(/fps=\s*([0-9.]+)/);
      if (fpsMatch) {
        const fps = parseFloat(fpsMatch[1]);
        return {
          fps,
          isDropping: fps < this.expectedFPS * this.fpsThreshold,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      // 超时或错误
    }

    return null;
  }

  // macOS: 使用 ffmpeg
  async checkFPSMacOS(camera) {
    try {
      const cmd = `ffmpeg -f avfoundation -i "${camera.device}" -vframes 30 -f null - 2>&1`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 3000 });
      const output = stdout + stderr;

      const fpsMatch = output.match(/fps=\s*([0-9.]+)/);
      if (fpsMatch) {
        const fps = parseFloat(fpsMatch[1]);
        return {
          fps,
          isDropping: fps < this.expectedFPS * this.fpsThreshold,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      // 超时或错误
    }

    return null;
  }

  // ==================== 启动监控 ====================
  async startMonitoring(callback) {
    if (this.monitoring) {
      console.warn('[Camera] 监控已在运行');
      return;
    }

    console.log('[Camera] 开始监控摄像头...');
    this.monitoring = true;

    // 初始检测
    this.cameras = await this.detectCameras();

    if (this.cameras.length === 0) {
      console.warn('[Camera] ⚠️  未检测到摄像头设备');
      this.monitoring = false;
      return;
    }

    console.log(`[Camera] 检测到 ${this.cameras.length} 个摄像头设备`);
    this.cameras.forEach(cam => {
      console.log(`  - ${cam.name} (${cam.device})`);
    });

    // 定期检查
    const checkLoop = async () => {
      if (!this.monitoring) return;

      await Promise.all(this.cameras.map(async (camera) => {
        const result = await this.checkCameraFPS(camera);

        if (result) {
          camera.currentFPS = result.fps;
          camera.lastCheck = result.timestamp;

          // 判断状态
          if (result.isDropping) {
            camera.status = 'dropping';
            console.warn(`[Camera] ⚠️  ${camera.name} 掉帧: ${result.fps.toFixed(1)} fps (期望 ${this.expectedFPS} fps)`);
          } else {
            camera.status = 'normal';
            console.log(`[Camera] ✅ ${camera.name} 正常: ${result.fps.toFixed(1)} fps`);
          }

          // 回调通知
          if (callback) {
            callback({
              camera: camera.name,
              device: camera.device,
              fps: result.fps,
              expectedFPS: this.expectedFPS,
              isDropping: result.isDropping,
              status: camera.status,
              method: result.method || null,
              timestamp: result.timestamp,
            });
          }
        } else {
          camera.currentFPS = 0;
          camera.lastCheck = new Date().toISOString();
          camera.status = 'error';
          console.error(`[Camera] ❌ ${camera.name} 检测失败`);
        }
      }));

      // 继续下一次检查
      this.checkTimer = setTimeout(checkLoop, this.checkInterval);
    };

    // 开始第一次检查
    checkLoop();
  }

  // ==================== 停止监控 ====================
  stopMonitoring() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    this.monitoring = false;
    console.log('[Camera] 监控已停止');
  }

  // ==================== 获取当前状态 ====================
  getStatus() {
    return {
      monitoring: this.monitoring,
      camerasCount: this.cameras.length,
        cameras: this.cameras.map(cam => ({
        cameraId: cam.cameraId || null,
          name: cam.name,
          device: cam.device,
          currentFPS: cam.currentFPS,
          maxFPS: cam.maxFPS,
          width: cam.width || null,
          height: cam.height || null,
          pixelFormat: cam.pixelFormat || null,
        status: cam.status,
        lastCheck: cam.lastCheck,
        isDropping: cam.status === 'dropping',
      })),
    };
  }
}

module.exports = CameraMonitor;

// ==================== 独立运行测试 ====================
if (require.main === module) {
  const monitor = new CameraMonitor({
    checkInterval: 5000,  // 5秒检查一次
    expectedFPS: 30,
    fpsThreshold: 0.8,
  });

  monitor.startMonitoring((status) => {
    console.log('[Status Update]', JSON.stringify(status, null, 2));
  });

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n正在退出...');
    monitor.stopMonitoring();
    process.exit(0);
  });
}
