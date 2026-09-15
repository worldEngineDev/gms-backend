/**
 * Rate Limiting — Redis 滑动窗口限流 + 登录爆破防护（零依赖）
 *
 * 设计：
 *   - Redis 为主存储（3 个 PM2 实例共享计数才准确），INCR + EXPIRE 滑动窗口
 *   - Redis 不可用时降级到内存 Map（单实例内有效，跨 worker 不准确但保证可用）
 *   - 全局开关 RATE_LIMIT_ENABLED=false 即关闭（回滚用）
 *
 * 限流策略：
 *   - IP 级：200 req/s（突发达不到也够，超量才限）
 *   - 用户级：60 req/min（防止单用户拖垮系统）
 *   - 登录爆破：同 IP 10 分钟内 5 次失败 → 封禁 5 分钟
 *
 * Redis key 约定：
 *   rl:ip:{ip}        — IP 计数（TTL 1s）
 *   rl:u:{userId}     — 用户计数（TTL 60s）
 *   rl:login:{ip}     — 登录失败计数（TTL 600s）
 *   rl:blocked:{ip}   — 登录封禁标记（TTL 300s）
 */

// ============ 配置（可由 env 覆盖） ============
const IP_MAX = parseInt(process.env.RATE_LIMIT_IP_MAX || '200', 10);   // 每窗口最大请求数
const IP_WINDOW = parseInt(process.env.RATE_LIMIT_IP_WINDOW || '1', 10) * 1000; // 窗口大小(ms)
// Mobile dashboard refreshes fan out to several read endpoints; 60/min makes
// normal tab switching look like an intermittent outage. Keep a conservative
// 300/min default, overridable with RATE_LIMIT_USER_MAX.
const USER_MAX = parseInt(process.env.RATE_LIMIT_USER_MAX || '300', 10);
const USER_WINDOW = 60 * 1000;
const LOGIN_FAIL_MAX = 5;          // 失败阈值
const LOGIN_FAIL_WINDOW = 10 * 60 * 1000; // 10 分钟
const LOGIN_BLOCK_DURATION = 5 * 60 * 1000; // 封禁 5 分钟

const ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false'; // 默认开

// ============ 内存兜底（Redis 不可用时） ============
const memIpCounts = new Map();       // ip → { count, windowStart }
const memUserCounts = new Map();     // userId → { count, windowStart }
const memLoginFails = new Map();     // ip → { fails, windowStart, blockUntil }

// 定期清理过期内存记录（每 5 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memIpCounts) if (now - v.windowStart > IP_WINDOW * 2) memIpCounts.delete(k);
  for (const [k, v] of memUserCounts) if (now - v.windowStart > USER_WINDOW * 2) memUserCounts.delete(k);
  for (const [k, v] of memLoginFails) if (v.blockUntil < now && now - v.windowStart > LOGIN_FAIL_WINDOW * 2) memLoginFails.delete(k);
}, 5 * 60 * 1000).unref?.();

/**
 * 创建限流器实例（依赖注入便于测试）
 * @param {{ redisClient?: object }} deps
 */
function createRateLimiter({ redisClient } = {}) {
  const redisReady = () => redisClient && redisClient.isReady;

  /**
   * 通用计数限流（Redis 路径）
   * @returns {Promise<{allowed:boolean, remaining:number, retryAfter:number}>}
   */
  async function redisIncrement(key, max, windowSec) {
    try {
      const count = await redisClient.incr(key);
      if (count === 1) await redisClient.expire(key, windowSec);
      return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        retryAfter: count > max ? windowSec : 0,
      };
    } catch {
      return null; // 降级到内存
    }
  }

  function memIncrement(map, key, max, windowMs) {
    const now = Date.now();
    let rec = map.get(key);
    if (!rec || now - rec.windowStart > windowMs) {
      rec = { count: 0, windowStart: now };
      map.set(key, rec);
    }
    rec.count++;
    return {
      allowed: rec.count <= max,
      remaining: Math.max(0, max - rec.count),
      retryAfter: rec.count > max ? Math.ceil(windowMs / 1000) : 0,
    };
  }

  /** IP 级限流（全局，路由前调用） */
  async function checkIpLimit(ip) {
    if (!ENABLED || !ip) return { allowed: true, remaining: IP_MAX, retryAfter: 0 };
    const key = `rl:ip:${ip}`;
    if (redisReady()) {
      const r = await redisIncrement(key, IP_MAX, Math.ceil(IP_WINDOW / 1000));
      if (r) return r;
    }
    return memIncrement(memIpCounts, ip, IP_MAX, IP_WINDOW);
  }

  /** 用户级限流（requireAuth 后调用） */
  async function checkUserLimit(userId) {
    if (!ENABLED || !userId) return { allowed: true, remaining: USER_MAX, retryAfter: 0 };
    const key = `rl:u:${userId}`;
    if (redisReady()) {
      const r = await redisIncrement(key, USER_MAX, Math.ceil(USER_WINDOW / 1000));
      if (r) return r;
    }
    return memIncrement(memUserCounts, userId, USER_MAX, USER_WINDOW);
  }

  /** 登录是否被爆破封禁 */
  async function isLoginBlocked(ip) {
    if (!ENABLED || !ip) return false;
    if (redisReady()) {
      try {
        const blocked = await redisClient.get(`rl:blocked:${ip}`);
        if (blocked) return true;
      } catch {}
    }
    const rec = memLoginFails.get(ip);
    return !!(rec && rec.blockUntil > Date.now());
  }

  /** 记录一次登录失败；达到阈值则封禁 */
  async function recordLoginFailure(ip) {
    if (!ENABLED || !ip) return;
    // Redis 路径
    if (redisReady()) {
      try {
        const key = `rl:login:${ip}`;
        const count = await redisClient.incr(key);
        if (count === 1) await redisClient.expire(key, Math.ceil(LOGIN_FAIL_WINDOW / 1000));
        if (count >= LOGIN_FAIL_MAX) {
          // 封禁：写入 blocked 标记，TTL = 封禁时长
          await redisClient.set(`rl:blocked:${ip}`, '1', { EX: Math.ceil(LOGIN_BLOCK_DURATION / 1000) });
        }
        return;
      } catch {}
    }
    // 内存兜底
    const now = Date.now();
    let rec = memLoginFails.get(ip);
    if (!rec || now - rec.windowStart > LOGIN_FAIL_WINDOW) {
      rec = { fails: 0, windowStart: now, blockUntil: 0 };
      memLoginFails.set(ip, rec);
    }
    rec.fails++;
    if (rec.fails >= LOGIN_FAIL_MAX) rec.blockUntil = now + LOGIN_BLOCK_DURATION;
  }

  /** 登录成功后清空失败计数 */
  async function clearLoginFailures(ip) {
    if (!ip) return;
    if (redisReady()) {
      try {
        await redisClient.del(`rl:login:${ip}`);
        await redisClient.del(`rl:blocked:${ip}`);
        return;
      } catch {}
    }
    memLoginFails.delete(ip);
  }

  return {
    checkIpLimit,
    checkUserLimit,
    isLoginBlocked,
    recordLoginFailure,
    clearLoginFailures,
    // 暴露配置便于测试/监控
    config: { ENABLED, IP_MAX, USER_MAX, LOGIN_FAIL_MAX },
  };
}

module.exports = { createRateLimiter };
