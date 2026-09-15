/**
 * Unit tests for lib/security-headers.js — 安全响应头注入
 * Run: node --test tests/unit/security-headers.test.js
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { applySecurityHeaders, generateNonce, isNonceMode, PERMISSIVE_CSP, CDN_HOSTS } = require('../../lib/security-headers');

/** 最小化的 mock response，模拟 http.ServerResponse 的 setHeader/hasHeader */
function mockRes(initial = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(initial)) headers[k.toLowerCase()] = v;
  return {
    headers,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    hasHeader(name) { return Object.prototype.hasOwnProperty.call(this.headers, name.toLowerCase()); },
  };
}

describe('applySecurityHeaders', () => {
  test('设置所有预期的安全头', () => {
    const res = mockRes();
    applySecurityHeaders(res);
    assert.strictEqual(res.getHeader('X-Content-Type-Options'), 'nosniff');
    assert.strictEqual(res.getHeader('X-Frame-Options'), 'DENY');
    assert.strictEqual(res.getHeader('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.strictEqual(res.getHeader('X-DNS-Prefetch-Control'), 'off');
    assert.strictEqual(res.getHeader('Cross-Origin-Resource-Policy'), 'cross-origin');
    assert.strictEqual(res.getHeader('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
    assert.match(res.getHeader('Permissions-Policy'), /camera=\(\)/);
    assert.match(res.getHeader('Permissions-Policy'), /microphone=\(\)/);
    assert.match(res.getHeader('Permissions-Policy'), /geolocation=\(\)/);
    assert.strictEqual(res.getHeader('Content-Security-Policy'), PERMISSIVE_CSP);
  });

  test('CSP 含宽松指令（self + unsafe-inline + unsafe-eval）', () => {
    assert.match(PERMISSIVE_CSP, /default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:/);
    assert.match(PERMISSIVE_CSP, /object-src 'none'/);
    assert.match(PERMISSIVE_CSP, /base-uri 'self'/);
  });

  test('不设置已废弃的 X-XSS-Protection', () => {
    const res = mockRes();
    applySecurityHeaders(res);
    assert.strictEqual(res.getHeader('X-XSS-Protection'), undefined);
  });

  test('HTTPS_ENABLED 未设置时不下发 HSTS', () => {
    delete process.env.HTTPS_ENABLED;
    const res = mockRes();
    applySecurityHeaders(res);
    assert.strictEqual(res.getHeader('Strict-Transport-Security'), undefined);
  });

  test('HTTPS_ENABLED=true 时下发 HSTS', () => {
    process.env.HTTPS_ENABLED = 'true';
    const res = mockRes();
    applySecurityHeaders(res);
    const hsts = res.getHeader('Strict-Transport-Security');
    assert.ok(hsts, 'HSTS should be set');
    assert.match(hsts, /max-age=63072000/);
    assert.match(hsts, /includeSubDomains/);
    assert.match(hsts, /preload/);
    delete process.env.HTTPS_ENABLED;
  });

  test('opts.hsts=true 强制下发 HSTS（即使 env 未设置）', () => {
    delete process.env.HTTPS_ENABLED;
    const res = mockRes();
    applySecurityHeaders(res, { hsts: true });
    assert.ok(res.getHeader('Strict-Transport-Security'));
  });

  test('不覆盖调用方已设置的头（CORS 定制场景）', () => {
    const res = mockRes({ 'X-Frame-Options': 'SAMEORIGIN' });
    applySecurityHeaders(res);
    // 已存在的 X-Frame-Options 不应被覆盖
    assert.strictEqual(res.getHeader('X-Frame-Options'), 'SAMEORIGIN');
    // 其他未设置的头仍被注入
    assert.strictEqual(res.getHeader('X-Content-Type-Options'), 'nosniff');
  });

  test('不在不可信 HTTP 来源下发送 COOP', () => {
    const res = mockRes();
    applySecurityHeaders(res, { coop: false });
    assert.strictEqual(res.getHeader('Cross-Origin-Opener-Policy'), undefined);
  });

  test('null res 安全（不抛错）', () => {
    assert.doesNotThrow(() => applySecurityHeaders(null));
    assert.doesNotThrow(() => applySecurityHeaders(undefined));
  });

  // S7: CSP nonce mode tests

  test('generateNonce 返回 base64url 格式的 32 字节随机值', () => {
    const nonce = generateNonce();
    assert.ok(nonce);
    assert.ok(nonce.length > 30, 'nonce should be 32 bytes base64url');
    // 应为 base64url 格式（无 +/=）
    assert.doesNotMatch(nonce, /[+/=]/, 'nonce should be base64url');
  });

  test('generateNonce 每次调用返回不同的值', () => {
    const a = generateNonce();
    const b = generateNonce();
    assert.notStrictEqual(a, b, 'each nonce should be unique');
  });

  test('CSP_NONCE_ENABLED 默认 false — 使用宽松 CSP', () => {
    delete process.env.CSP_NONCE_ENABLED;
    const res = mockRes();
    applySecurityHeaders(res);
    const csp = res.getHeader('Content-Security-Policy');
    assert.ok(csp.includes("'unsafe-inline'"), 'default should be permissive');
    assert.ok(csp.includes('unsafe-eval'), 'default should allow eval');
  });

  test('CSP_NONCE_ENABLED=true + nonce 参数 — 使用严格 CSP 带 nonce', () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    const nonce = generateNonce();
    const res = mockRes();
    applySecurityHeaders(res, { nonce });
    const csp = res.getHeader('Content-Security-Policy');
    assert.ok(csp.includes(`'nonce-${nonce}'`), 'should include nonce');
    // script-src should NOT have unsafe-inline (but style-src retains it)
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"), 'style-src keeps unsafe-inline');
    assert.ok(!csp.includes("'unsafe-eval'"), 'should NOT have unsafe-eval');
    // CDN hosts should be whitelisted
    for (const host of CDN_HOSTS) {
      assert.ok(csp.includes(`https://${host}`), `should whitelist ${host}`);
    }
    delete process.env.CSP_NONCE_ENABLED;
  });

  test('CSP_NONCE_ENABLED=true 但无 nonce — 回退到宽松模式', () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    const res = mockRes();
    applySecurityHeaders(res, { nonce: null });
    const csp = res.getHeader('Content-Security-Policy');
    // 无 nonce 时 buildCSP 回退到 PERMISSIVE_CSP（包含 unsafe-eval）
    assert.ok(csp.includes('unsafe-eval'), 'should fallback to permissive when no nonce');
    delete process.env.CSP_NONCE_ENABLED;
  });

  test('isNonceMode() 反映环境变量', () => {
    delete process.env.CSP_NONCE_ENABLED;
    assert.strictEqual(isNonceMode(), false);
    process.env.CSP_NONCE_ENABLED = 'true';
    assert.strictEqual(isNonceMode(), true);
    delete process.env.CSP_NONCE_ENABLED;
  });

  test('严格 CSP 包含 frame-ancestors 禁用', () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    const nonce = generateNonce();
    const res = mockRes();
    applySecurityHeaders(res, { nonce });
    const csp = res.getHeader('Content-Security-Policy');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'should block framing');
    delete process.env.CSP_NONCE_ENABLED;
  });
});
