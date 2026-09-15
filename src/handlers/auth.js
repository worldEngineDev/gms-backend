/**
 * src/handlers/auth.js
 * Auth domain HTTP handlers — extracted from server.js (Phase 2.1).
 *
 * Design: factory / dependency-injection pattern.
 *   - server.js calls createAuthHandlers(deps) AFTER pool/redis are initialized
 *   - deps are destructured into the factory scope, so handler bodies reference
 *     pool / redisClient / tokens / hashPassword / ... as bare identifiers,
 *     exactly as they did in server.js. Bodies are copied verbatim — no logic
 *     changes, only the enclosing scope moved.
 *   - Why factory (not a global context module): explicit deps make the module
 *     unit-testable with mocks, avoid circular requires, and keep the extraction
 *     fully reversible (revert = re-inline the functions).
 *
 * Handlers in this domain (URL → handler):
 *   POST   /api/auth/login                 → handleLogin
 *   POST   /api/auth/verify                → handleTokenVerify
 *   POST   /api/mobile/auth                → handleMobileAuth
 *   POST   /api/logout                     → handleLogout      (S5.3: public, auth:'none')
 *   POST   /api/beacon-logout              → handleBeaconLogout
 *   POST   /api/change-password            → handleChangePassword
 *   POST   /api/users/:id/reset-password   → handleResetPassword
 *   GET    /api/users/:id/password          → handleGetUserPassword
 *
 * NOTE: handleGetMachineCode (hostname utility) and handleMobileGetMachines
 * (machines-domain query) are NOT auth — they remain in server.js for now.
 */
'use strict';

module.exports = function createAuthHandlers(deps) {
  // Destructure once; names match the bare identifiers used in the handler
  // bodies below so the verbatim copy from server.js resolves correctly.
  const {
    pool,
    redisClient,
    tokens,
    saveTokens,
    hashPassword,
    // S6: verifyPassword — scrypt + legacy SHA-256 auto-upgrade verification
    verifyPassword,
    encryptPassword,
    decryptPassword,
    createToken,
    validateToken,
    invalidateUserTokens,
    sendJSON,
    broadcastSSE,
    // S2: login brute-force protection (optional — defaults to no-op if not injected)
    rateLimiter,
    getClientIp,
    // S4.1: HTTPS detection for Secure cookie flag
    isHttps,
    // S5.1: cookie parsing for handleLogout cookie-token invalidation
    parseCookies,
  } = deps;

  // ==================== AUTH HANDLERS ====================

  async function handleLogin(req, res, body) {
    const { username, password, machineCode } = body;
    if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);
    // 登录爆破防护已关闭：输入错误不再限制登录（按用户要求）
    const ip = getClientIp ? getClientIp(req) : null;
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      return sendJSON(res, { error: '用户名或密码错误' }, 401);
    }
    const user = rows[0];
    // S6: verifyPassword handles both scrypt (new) and legacy SHA-256 (old) hashes.
    // If the stored hash is legacy SHA-256 and the password matches, auto-upgrade
    // to scrypt silently — no disruption to the user.
    const verifyResult = await verifyPassword(password, user.passwordHash);
    if (!verifyResult.valid) {
      return sendJSON(res, { error: '用户名或密码错误' }, 401);
    }
    // S6: auto-upgrade legacy SHA-256 → scrypt on next successful login
    if (verifyResult.upgraded && verifyResult.newHash) {
      await pool.execute('UPDATE users SET passwordHash = ? WHERE id = ?', [verifyResult.newHash, user.id]);
    }
    if (user.status === 'disabled') return sendJSON(res, { error: '账户已被禁用，请联系管理员' }, 403);

    let lockedDeviceType = null;
    if (user.role === 'user' && user.system === 'operations' && machineCode) {
      const [machineRows] = await pool.execute('SELECT data FROM machines WHERE data LIKE ? ORDER BY id DESC LIMIT 1', [`%${machineCode}%`]);
      if (machineRows.length > 0) {
        const machineData = JSON.parse(machineRows[0].data);
        if (machineData.deviceType === 'glove') {
          lockedDeviceType = 'glove';
        }
      }
    }

    // 仅失效相同来源（web）的旧会话，保留移动端会话 — 让浏览器与微信链接页可共存
    await invalidateUserTokens(user.id, 'web');
    const STALE_THRESHOLD = 3 * 60 * 1000;
    Object.keys(tokens).forEach(k => {
      const t = tokens[k];
      if (t.expires < Date.now() || (Date.now() - (t.lastActive || 0)) > STALE_THRESHOLD) delete tokens[k];
    });
    saveTokens();
    // S2: successful login — clear any failure counters for this IP
    if (rateLimiter && ip) await rateLimiter.clearLoginFailures(ip);
    // 记录登录时间和IP
    await pool.execute('UPDATE users SET lastLoginAt = NOW(), lastIp = ? WHERE id = ?', [ip || 'unknown', user.id]);
    const token = await createToken({ ...user, lockedDeviceType }, 'web');
    // S4.1: auth token cookie hardened — HttpOnly (XSS cannot read via document.cookie)
    // and Secure (only sent over HTTPS) when isHttps(req) is true.
    const secureFlag = isHttps && isHttps(req) ? '; Secure' : '';
    sendJSON(res, { token, user: { id: user.id, username: user.username, displayName: user.displayName || user.username, role: user.role, system: user.system || 'maintenance', lockedDeviceType, customRole: user.custom_role || null } }, 200, req, {
      'Set-Cookie': `gms_token=${token}; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly${secureFlag}`,
    });
  }

  async function handleMobileAuth(req, res, body) {
    const { username, password } = body;
    if (!username || !password) return sendJSON(res, { error: '请输入用户名和密码' }, 400);

    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) return sendJSON(res, { error: '用户名或密码错误' }, 401);

    const user = rows[0];
    // S6: verifyPassword handles both scrypt (new) and legacy SHA-256 (old) hashes
    const verifyResult = await verifyPassword(password, user.passwordHash);
    if (!verifyResult.valid) return sendJSON(res, { error: '用户名或密码错误' }, 401);
    // S6: auto-upgrade legacy hash → scrypt
    if (verifyResult.upgraded && verifyResult.newHash) {
      await pool.execute('UPDATE users SET passwordHash = ? WHERE id = ?', [verifyResult.newHash, user.id]);
    }

    if (user.status === 'disabled') return sendJSON(res, { error: '账户已被禁用，请联系管理员' }, 403);

    if (user.system !== 'maintenance' && user.system !== 'operations') {
      return sendJSON(res, { error: '仅运维或运营系统用户可使用此功能' }, 403);
    }

    // 仅失效相同来源（mobile）的旧会话，保留浏览器会话 — 让微信链接页与浏览器可共存
    await invalidateUserTokens(user.id, 'mobile');
    const STALE_THRESHOLD = 3 * 60 * 1000;
    Object.keys(tokens).forEach(k => {
      const t = tokens[k];
      if (t.expires < Date.now() || (Date.now() - (t.lastActive || 0)) > STALE_THRESHOLD) delete tokens[k];
    });
    saveTokens();

    const token = await createToken({ ...user }, 'mobile');

    const secureFlag = isHttps && isHttps(req) ? '; Secure' : '';
    sendJSON(res, {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
        system: user.system || 'maintenance'
      }
    }, 200, req, {
      // Keep a browser session as a durable fallback for mobile WebViews.
      // Bearer auth remains the primary client-side path.
      'Set-Cookie': [
        `gms_token=${token}; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly${secureFlag}`,
        `gms_mobile_token=${token}; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly${secureFlag}`,
      ],
    });
  }

  async function handleTokenVerify(req, res, body) {
    const { token } = body;
    if (!token) return sendJSON(res, { valid: false, error: 'Missing token' }, 400);
    const user = await validateToken(token);
    if (!user) return sendJSON(res, { valid: false, error: 'Invalid or expired token' }, 401);
    sendJSON(res, { valid: true, user: { userId: user.userId, username: user.username, role: user.role, system: user.system, lockedDeviceType: user.lockedDeviceType } });
  }

  async function handleLogout(req, res) {
    // S5.3: now a public endpoint (publicRouter, auth:'none') so it can clear the
    // HttpOnly cookie even when the session is expired. No authUser is passed.
    const auth = req.headers['authorization'];
    // S5.1: invalidate token from Bearer header (mobile/legacy) OR HttpOnly cookie (web).
    // Before S5, web stored token in localStorage and sent it as Bearer on logout;
    // now web relies on HttpOnly cookie, so we must also read gms_token from the cookie
    // to invalidate the server-side session. Otherwise the token stays valid until
    // natural expiry (3 min inactivity), defeating logout.
    let tokenToInvalidate = null;
    if (auth && auth.startsWith('Bearer ')) {
      const bearerToken = auth.slice(7).trim();
      // S5.1: defend against 'Bearer null'/'Bearer undefined' (see requireAuth)
      if (bearerToken && bearerToken !== 'null' && bearerToken !== 'undefined') {
        tokenToInvalidate = bearerToken;
      }
    }
    if (!tokenToInvalidate && parseCookies && req.headers['cookie']) {
      const cookies = parseCookies(req.headers['cookie']);
      if (cookies.gms_token) tokenToInvalidate = cookies.gms_token;
    }
    if (tokenToInvalidate) {
      if (redisClient) { try { await redisClient.del(`tk:${tokenToInvalidate}`); } catch {} }
      delete tokens[tokenToInvalidate];
      saveTokens();
    }
    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true }, 200, req, {
      'Set-Cookie': 'gms_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    });
  }

  async function handleBeaconLogout(req, res, body) {
    if (body && body.token) {
      if (redisClient) { try { await redisClient.del(`tk:${body.token}`); } catch {} }
      delete tokens[body.token];
      saveTokens();
      broadcastSSE('users_updated', {});
    }
    sendJSON(res, { success: true });
  }

  async function handleChangePassword(req, res, user, body) {
    const { oldPassword, newPassword } = body;
    if (!oldPassword || !newPassword) return sendJSON(res, { error: '请输入旧密码和新密码' }, 400);
    const trimmedPw = newPassword.trim();
    if (trimmedPw.length < 6) return sendJSON(res, { error: '新密码至少6个字符' }, 400);
    if (!/[A-Za-z]/.test(trimmedPw) || !/[0-9]/.test(trimmedPw)) return sendJSON(res, { error: '新密码需包含字母和数字' }, 400);
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [user.userId]);
    if (rows.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    // S6: use verifyPassword for oldPassword (handles both scrypt + legacy)
    const verifyResult = await verifyPassword(oldPassword, rows[0].passwordHash);
    if (!verifyResult.valid) return sendJSON(res, { error: '旧密码错误' }, 403);
    // S6: hashPassword is now async scrypt
    const newHash = await hashPassword(trimmedPw);
    await pool.execute('UPDATE users SET passwordHash = ?, encryptedPassword = ? WHERE id = ?', [newHash, encryptPassword(trimmedPw), user.userId]);
    sendJSON(res, { success: true });
  }

  // Reset another user's password (superadmin → admin, admin → group members)
  async function handleResetPassword(req, res, user, userId, body) {
    const { newPassword } = body;
    const trimmedPw = (newPassword || '').trim();
    if (!trimmedPw || trimmedPw.length < 6) return sendJSON(res, { error: '新密码至少6个字符' }, 400);

    // Only admin and superadmin can reset others' passwords
    if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);

    // Cannot reset own password through this endpoint
    if (user.userId === userId) return sendJSON(res, { error: '请使用修改密码功能修改自己的密码' }, 400);

    const [target] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    const targetUser = target[0];

    // Superadmin: can reset admin/user passwords, same-system only, cannot reset other superadmins
    if (user.role === 'superadmin') {
      if (targetUser.role === 'superadmin') return sendJSON(res, { error: '无法重置其他超级管理员的密码' }, 403);
      if (targetUser.system !== user.system) return sendJSON(res, { error: '只能重置本系统内用户的密码' }, 403);
    }

    // Admin: can only reset their own group members' passwords (not other admins)
    if (user.role === 'admin') {
      if (targetUser.role === 'admin' || targetUser.role === 'superadmin') return sendJSON(res, { error: '无法重置管理员或超级管理员的密码' }, 403);
      if (targetUser.parentId !== user.userId && targetUser.createdBy !== user.userId) {
        return sendJSON(res, { error: '只能重置自己组员的密码' }, 403);
      }
    }

    // S6: hashPassword is now async scrypt
    const newHash = await hashPassword(trimmedPw);
    await pool.execute('UPDATE users SET passwordHash = ?, encryptedPassword = ? WHERE id = ?', [newHash, encryptPassword(trimmedPw), userId]);

    // Invalidate target user's tokens (force re-login)
    await invalidateUserTokens(userId);
    saveTokens();

    broadcastSSE('users_updated', {});
    sendJSON(res, { success: true, message: '密码已重置' });
  }

  async function handleGetUserPassword(req, res, user, userId) {
    const [target] = await pool.execute('SELECT id, username, encryptedPassword FROM users WHERE id = ?', [userId]);
    if (target.length === 0) return sendJSON(res, { error: '用户不存在' }, 404);
    const targetUser = target[0];

    const canView = () => {
      if (user.userId === userId) return true;
      if (user.role === 'superadmin') {
        if (targetUser.role === 'superadmin') return false;
        if (targetUser.system !== user.system) return false;
        return true;
      }
      if (user.role === 'admin') {
        if (targetUser.role === 'admin' || targetUser.role === 'superadmin') return false;
        return targetUser.parentId === user.userId || targetUser.createdBy === user.userId;
      }
      return false;
    };

    if (!canView()) {
      return sendJSON(res, { error: '无权限查看此用户信息' }, 403);
    }

    // Security: Never return plaintext password. Return only whether password is set.
    const hasPassword = !!targetUser.encryptedPassword;
    sendJSON(res, { success: true, userId, username: targetUser.username, hasPassword });
  }

  async function handleGetUsers(req, res) {
    try {
      const [rows] = await pool.execute('SELECT DISTINCT username FROM users WHERE status = ? ORDER BY username', ['active']);
      sendJSON(res, rows.map(r => r.username));
    } catch (e) {
      sendJSON(res, { error: '获取用户列表失败' }, 500);
    }
  }

  return {
    handleLogin,
    handleMobileAuth,
    handleTokenVerify,
    handleLogout,
    handleBeaconLogout,
    handleChangePassword,
    handleResetPassword,
    handleGetUserPassword,
    handleGetUsers,
  };
};
