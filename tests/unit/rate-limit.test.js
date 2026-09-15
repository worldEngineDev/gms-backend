/**
 * Unit tests for lib/rate-limit.js — Redis 限流 + 内存兜底
 * Run: node --test tests/unit/rate-limit.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../../lib/rate-limit');

/** 构造 mock redis client（模拟 incr/expire/set/get/del + isReady） */
function mockRedis({ ready = true } = {}) {
  const store = {}; // key → value (string)
  const ttls = {};  // key → expire timestamp(ms)
  return {
    isReady: ready,
    async incr(key) {
      const v = parseInt(store[key] || '0', 10) + 1;
      store[key] = String(v);
      return v;
    },
    async expire(key, seconds) { ttls[key] = Date.now() + seconds * 1000; return 1; },
    async set(key, value, opts) {
      store[key] = String(value);
      if (opts && opts.EX) ttls[key] = Date.now() + opts.EX * 1000;
      return 'OK';
    },
    async get(key) {
      if (ttls[key] && Date.now() > ttls[key]) return null;
      return store[key] ?? null;
    },
    async del(key) { delete store[key]; delete ttls[key]; return 1; },
    _store: store,
  };
}

describe('createRateLimiter', () => {
  describe('IP 限流（Redis 路径）', () => {
    test('默认 200 阈值：第 200 次放行，第 201 次拒绝', async () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      for (let i = 0; i < 200; i++) {
        const r = await rl.checkIpLimit('1.2.3.4');
        assert.strictEqual(r.allowed, true, `第 ${i + 1} 次应放行`);
      }
      const blocked = await rl.checkIpLimit('1.2.3.4');
      assert.strictEqual(blocked.allowed, false);
      assert.ok(blocked.retryAfter > 0);
    });

    test('不同 IP 独立计数', async () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      await rl.checkIpLimit('1.1.1.1');
      const r = await rl.checkIpLimit('2.2.2.2');
      assert.strictEqual(r.allowed, true);
      assert.strictEqual(r.remaining > 0, true);
    });
  });

  describe('用户限流', () => {
    test('默认 300 阈值：第 300 次放行，第 301 次拒绝', async () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      for (let i = 0; i < 300; i++) {
        const r = await rl.checkUserLimit('user-1');
        assert.strictEqual(r.allowed, true);
      }
      const blocked = await rl.checkUserLimit('user-1');
      assert.strictEqual(blocked.allowed, false);
    });
  });

  describe('登录爆破防护', () => {
    test('失败未达阈值不封禁', async () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      await rl.recordLoginFailure('5.5.5.5');
      await rl.recordLoginFailure('5.5.5.5');
      assert.strictEqual(await rl.isLoginBlocked('5.5.5.5'), false);
    });

    test('5 次失败后封禁', async () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      for (let i = 0; i < 5; i++) await rl.recordLoginFailure('6.6.6.6');
      assert.strictEqual(await rl.isLoginBlocked('6.6.6.6'), true);
    });

    test('登录成功清空失败计数', async () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      for (let i = 0; i < 4; i++) await rl.recordLoginFailure('7.7.7.7');
      await rl.clearLoginFailures('7.7.7.7');
      await rl.recordLoginFailure('7.7.7.7'); // 计数已清零，仅 1 次
      assert.strictEqual(await rl.isLoginBlocked('7.7.7.7'), false);
    });
  });

  describe('内存兜底（无 redis）', () => {
    test('redisClient 缺失时降级到内存且仍工作', async () => {
      const rl = createRateLimiter({}); // 无 redis
      const r = await rl.checkIpLimit('10.0.0.1');
      assert.strictEqual(r.allowed, true);
      for (let i = 0; i < 5; i++) await rl.recordLoginFailure('10.0.0.2');
      assert.strictEqual(await rl.isLoginBlocked('10.0.0.2'), true);
    });
  });

  describe('配置暴露', () => {
    test('config 暴露 ENABLED/阈值便于监控', () => {
      const rl = createRateLimiter({ redisClient: mockRedis() });
      assert.ok(typeof rl.config.ENABLED === 'boolean');
      assert.ok(rl.config.IP_MAX > 0);
      assert.ok(rl.config.USER_MAX > 0);
      assert.strictEqual(rl.config.LOGIN_FAIL_MAX, 5);
    });
  });
});
