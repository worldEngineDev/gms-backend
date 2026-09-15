/**
 * Security Headers — Helmet-style 安全响应头（零依赖）
 *
 * 接入点：sendJSON / serveStatic / OPTIONS 预飞 / SSE 握手 / favicon
 * 设计要点：
 *   - CSP 支持两种模式：
 *       1. 宽松模式（默认）：'unsafe-inline' + 'unsafe-eval'，兼容现有内联脚本
 *       2. 严格模式（CSP_NONCE_ENABLED=true）：nonce 模式，移除 'unsafe-inline'
 *   - HSTS 仅当 HTTPS_ENABLED=true 时下发（避免 HTTP 下把浏览器锁死）
 *   - 去掉已废弃的 X-XSS-Protection（现代浏览器已移除，反而可能引入风险）
 *   - 不覆盖已有头（尊重调用方传入的 extraHeaders，如 CORS 定制）
 */

const crypto = require('crypto');

// CSP（Content-Security-Policy）— 宽松模式（默认，兼容现有内联脚本）
const PERMISSIVE_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "img-src * data: blob:",
  "connect-src *",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// S7: CSP 严格模式模板 — nonce 模式，准备好后通过 CSP_NONCE_ENABLED=true 启用
// 使用 {NONCE} 和 {CDN_WHITELIST} 占位符，运行时替换为实际值
const STRICT_CSP_TEMPLATE = [
  "default-src 'self'",
  "script-src 'self' 'nonce-{NONCE}' {CDN_WHITELIST}",
  "style-src 'self' 'unsafe-inline'",  // 保留内联样式兼容（渐进式移除）
  "img-src * data: blob:",
  "connect-src *",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// S7: CDN 白名单（tesseract.js / qrcode.js 通过 jsdelivr CDN 加载）
// 严格模式下需要显式声明，否则会被 CSP 拦截
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
];

/**
 * 生成 32 字节 base64url nonce（CSP nonce 每个响应必须唯一）
 */
function generateNonce() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * 根据环境变量选择 CSP 模式
 * @param {string} [nonce] — nonce 值（严格模式必需）
 * @returns {string}
 */
function buildCSP(nonce) {
  if (process.env.CSP_NONCE_ENABLED === 'true' && nonce) {
    // 严格 nonce 模式 — 用 nonce 替换 {NONCE} 占位符，添加 CDN 白名单
    const cdnWhitelist = CDN_HOSTS.map(h => `'https://${h}'`).join(' ');
    return STRICT_CSP_TEMPLATE
      .replace('{NONCE}', nonce)
      .replace('{CDN_WHITELIST}', cdnWhitelist);
  }
  return PERMISSIVE_CSP;
}

/**
 * 给响应对象注入安全响应头。
 * 仅设置尚未设置的头（避免覆盖调用方定制值，如上传场景的额外头）。
 *
 * @param {import('http').ServerResponse} res
 * @param {object} [opts]
 * @param {boolean} [opts.hsts] — 是否下发 HSTS（HTTPS 场景应传 true）
 * @param {boolean} [opts.coop] — 是否下发 COOP（仅可信来源，如 HTTPS/localhost）
 * @param {string} [opts.nonce] — S7: CSP nonce（严格模式必需，宽松模式忽略）
 */
function applySecurityHeaders(res, opts = {}) {
  if (!res || typeof res.setHeader !== 'function') return;
  const set = (name, value) => {
    try {
      if (!res.hasHeader(name)) res.setHeader(name, value);
    } catch { /* 响应已发送则忽略 */ }
  };

  set('X-Content-Type-Options', 'nosniff');
  set('X-Frame-Options', 'DENY');
  set('Referrer-Policy', 'strict-origin-when-cross-origin');
  set('X-DNS-Prefetch-Control', 'off');
  set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (opts.coop !== false) {
    set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  }
  // Permissions-Policy — 禁用敏感设备权限
  set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // S7: CSP — 根据 CSP_NONCE_ENABLED 环境变量选择宽松/严格模式
  set('Content-Security-Policy', buildCSP(opts.nonce));

  // HSTS — 仅 HTTPS 场景下发
  if (opts.hsts || process.env.HTTPS_ENABLED === 'true') {
    set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
}

/**
 * 判断 CSP nonce 模式是否启用
 */
function isNonceMode() {
  return process.env.CSP_NONCE_ENABLED === 'true';
}

module.exports = {
  applySecurityHeaders,
  generateNonce,
  isNonceMode,
  // 导出常量供测试和模板注入使用
  PERMISSIVE_CSP,
  STRICT_CSP_TEMPLATE,
  CDN_HOSTS,
};
