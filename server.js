/**
 * Glove Management System - Backend Server (Cluster + Redis Edition)
 * Storage: MySQL (mysql2) + Redis (session/cache/pubsub) + SSE for real-time sync
 * Performance: Node.js cluster (multi-core) + Redis Pub/Sub + gzip + memory cache
 * Target: 500 concurrent users
 */
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const cluster = require('cluster');
const os = require('os');
// QRCode (qrcode) now required inside src/handlers/sn-registry.js (Phase 2.1 step6).

// ==================== FEISHU SYNC ====================
const feishu = require('./feishu');

// ==================== REALTIME ENGINE ====================
const realtime = require('./realtime');

// ==================== PURE MAPPING HELPERS ====================
// Extracted pure data-transform helpers (no DB/IO/dependencies)
const { fmtDuration: _fmtDuration, getStatusLabel: _getStatusLabel,
        snToInvType: _snToInvType, invTypeToSNFields: _invTypeToSNFields } = require('./lib/mappings');

// ==================== DB SERVICE HELPERS ====================
// Extracted DB-layer business logic (takes pool/conn explicitly — no globals)
const { getInventoryBreakdowns, insertTransaction } = require('./lib/db-helpers');
// Security layer (S1: security headers + client IP extraction — used by sendJSON/serveStatic/限流)
// S7: CSP nonce support — generateNonce + isNonceMode for HTML responses
const { applySecurityHeaders, generateNonce, isNonceMode } = require('./lib/security-headers');
const { getClientIp, isHttps } = require('./lib/client-ip');
// S2: rate limiting (Redis-backed with memory fallback)
const { createRateLimiter } = require('./lib/rate-limit');
let rateLimiter; // initialized in startup() after redisClient is ready
// S3: input validation + prototype-pollution sanitizer
const { validate, _sanitize } = require('./lib/validate');
// S4: CSRF middleware (double-submit cookie pattern)
const { createCSRFMiddleware } = require('./lib/csrf');
// S6: scrypt password hashing with automatic upgrade from legacy SHA-256
const { hashPassword: _newHash, hashPasswordSync, verifyPassword, legacyHashPassword } = require('./lib/password');
let csrfMiddleware; // initialized in startup() after _verifyCSRFToken is defined
const createRouter = require('./src/router');
// Aliases preserving server.js internal naming (underscore-prefixed) for minimal call-site churn
const _getInventoryBreakdowns = () => getInventoryBreakdowns(pool);
// _insertTransaction: accepts conn OR null (falls back to pool) for backward-compat with existing call sites
const _insertTransaction = (conn, tx) => insertTransaction(conn || pool, tx);

// ==================== HANDLER MODULES (Phase 2.1) ====================
// Domain handlers extracted to src/handlers/ via factory / dependency-injection.
// Each `let` is initialized in startup() AFTER pool/redis are ready, then route
// dispatch calls <domain>.handleXxx(...). See src/handlers/*.js for the full list.
const createAuthHandlers = require('./src/handlers/auth');
const createUsersHandlers = require('./src/handlers/users');
const createTransactionsHandlers = require('./src/handlers/transactions');
const createInventoryHandlers = require('./src/handlers/inventory');
const createMachinesHandlers = require('./src/handlers/machines');
const createSNRegistryHandlers = require('./src/handlers/sn-registry');
const createTechSupportHandlers = require('./src/handlers/tech-support');
const createEdgeHandlers = require('./src/handlers/edge');
const createPushHandlers = require('./src/handlers/push');
const createChatHandlers = require('./src/handlers/chat');
const createSOPHandlers = require('./src/handlers/sop');
const createSolutionsHandlers = require('./src/handlers/solutions');
const createConfigurationHandlers = require('./src/handlers/configuration');
const createStocktakeHandlers = require('./src/handlers/stocktakes');
const createReplacementHandlers = require('./src/handlers/replacement');
const createStorageLocationsHandlers = require('./src/handlers/storage-locations');
const createWarehouseHandlers = require('./src/handlers/warehouses');
const createRoleHandlers = require('./src/handlers/rbac-roles');
const createBatchHandlers = require('./src/handlers/batches');
const createWarehouseTransferHandlers = require('./src/handlers/warehouse-transfers');
const { createRbacEngine } = require('./lib/rbac');
// const createAgentHandlers = require('./src/handlers/agent');
let auth, users, transactions, inventory, machines, snRegistry, techSupport, edge, push, chat, sop, solutions, configuration, replacement, storageLocations, stocktakes, warehousesDomain, rbacRoles, batchesDomain, warehouseTransfers; // , agent;
let rbacEngine; // lib/rbac.js 引擎（can/getRole/listRoles），startup 内创建
// S3: sendJSON injected into router so validation errors return proper 400 JSON
const publicRouter = createRouter({ sendJSON: (...args) => sendJSON(...args) });  // routes dispatched BEFORE requireAuth
const authRouter = createRouter({ sendJSON: (...args) => sendJSON(...args) });    // routes dispatched AFTER requireAuth gate

// ==================== REDIS CLIENT ====================
const redis = require('redis');
const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
let redisClient, redisSub, redisPub;

async function initRedis() {
  try {
    redisClient = redis.createClient({
      url: REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 20) {
            console.error('[Redis] Max retries reached, running without Redis');
            return new Error('Max retries exceeded');
          }
          const delay = Math.min(retries * 500, 5000);
          console.warn(`[Redis] Reconnect attempt ${retries} in ${delay}ms`);
          return delay;
        },
      },
    });
    redisSub = redisClient.duplicate();
    redisPub = redisClient.duplicate();

    // 关键：捕获 Redis 错误，防止 crash 整个进程
    const onError = (role) => (err) => {
      console.error(`[Redis ${role}] Error (non-fatal):`, err.message);
    };
    redisClient.on('error', onError('client'));
    redisSub.on('error', onError('sub'));
    redisPub.on('error', onError('pub'));

    await Promise.all([redisClient.connect(), redisSub.connect(), redisPub.connect()]);
    console.log(`[Worker ${process.env.pm_id || '?'}] Redis connected: ${REDIS_URL}`);
    return true;
  } catch (e) {
    console.warn(`[Worker ${process.env.pm_id || '?'}] Redis not available (running without): ${e.message}`);
    redisClient = null; redisSub = null; redisPub = null;
    return false;
  }
}

// ==================== REDIS-ASSISTED CACHE ====================
async function _redisGet(key) {
  if (!redisClient) return null;
  try { const v = await redisClient.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function _redisSet(key, value, ttlSeconds = 30) {
  if (!redisClient) return;
  try { await redisClient.setEx(key, ttlSeconds, JSON.stringify(value)); } catch {}
}
async function _redisDel(key) {
  if (!redisClient) return;
  try { await redisClient.unlink(key); } catch {}
}

// ==================== CONFIG ====================
const PORT = process.env.PORT || 8765;
const SERVER_VERSION = Date.now().toString(); // 服务器启动时间戳作为版本号，每次重启自动更新
const DB_HOST = process.env.DB_HOST || process.env.MYSQL_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '3306');
const DB_USER = process.env.DB_USER || process.env.MYSQL_USER || 'gms_user';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || 'gms_password';
const DB_NAME = process.env.DB_NAME || process.env.MYSQL_DATABASE || 'gms';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours sliding window
const MOBILE_TOKEN_SECRET = process.env.MOBILE_TOKEN_SECRET || process.env.EDGE_TOKEN || 'gms-mobile-session-key';

function createMobileSignedToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', MOBILE_TOKEN_SECRET).update(payload).digest('base64url');
  return `m1.${payload}.${sig}`;
}

function verifyMobileSignedToken(token) {
  if (!token || !token.startsWith('m1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', MOBILE_TOKEN_SECRET).update(parts[1]).digest('base64url');
  const actualBuf = Buffer.from(parts[2]);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!data || data.expires < Date.now()) return null;
    return data;
  } catch { return null; }
}

// ==================== DATABASE ====================
const mysql = require('mysql2/promise');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let pool;

async function initPool() {
  // Connect without database first to ensure it exists
  const initConn = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    charset: 'utf8mb4',
  });
  await initConn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await initConn.end();

  pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 120,      // per worker; increased capacity for high concurrency
    queueLimit: 100,           // smaller queue to fail fast rather than wait too long
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
    idleTimeout: 60000,
  });

  // 确保每个连接都正确设置 utf8mb4 编码（避免中文乱码）
  pool.on('connection', async (conn) => {
    try {
      await conn.execute("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
      await conn.execute("SET CHARACTER SET utf8mb4");
    } catch {}
  });

  // Handle pool errors — don't let them crash the server
  pool.on('error', (err) => {
    console.error('[DB] Pool error (non-fatal):', err.message);
  });

  // Store original execute for auto-recovery wrapper
  const _origExecute = pool.execute.bind(pool);
  pool.execute = async function(...args) {
    try {
      return await _origExecute(...args);
    } catch (e) {
      if (e.message && e.message.includes('Pool is closed')) {
        console.warn('[DB] Pool closed, reinitializing...');
        await initPool();
        return _origExecute(...args);
      }
      throw e;
    }
  };

  // Periodic health check — keep pool alive
  const _healthCheck = setInterval(async () => {
    try {
      const conn = await _origExecute('SELECT 1');
    } catch (e) {
      if (e.message && e.message.includes('Pool is closed')) {
        console.warn('[DB] Health check found closed pool, reconnecting...');
        try { await initPool(); } catch(e2) { console.error('[DB] Reconnect failed:', e2.message); }
      }
    }
  }, 30000);
  // Allow event loop to exit if server stops
  if (_healthCheck.unref) _healthCheck.unref();

  // Test connection
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  console.log('[DB] MySQL connected:', `${DB_HOST  }:${  DB_PORT  }/${  DB_NAME}`);
}

function initDB() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS inventory (
      inv_type VARCHAR(64) PRIMARY KEY,
      quantity INT DEFAULT 0,
      updatedAt VARCHAR(64),
      updatedBy VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS machines (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT,
      ref_type VARCHAR(32),
      ref_id VARCHAR(64),
      inv_type VARCHAR(64),
      direction VARCHAR(8),
      quantity INT DEFAULT 0,
      operator VARCHAR(64),
      createdAt VARCHAR(64),
      INDEX idx_tx_ref (ref_type, ref_id),
      INDEX idx_tx_inv (inv_type),
      INDEX idx_tx_direction (direction),
      INDEX idx_tx_time (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS settings (
      skey VARCHAR(64) PRIMARY KEY,
      value MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(64) UNIQUE,
      passwordHash VARCHAR(256),  -- S6: expanded for scrypt format ("scrypt$salt$hash" ≈ 142 chars)
      role VARCHAR(32),
      \`system\` VARCHAR(32),
      createdBy VARCHAR(64),
      createdAt VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS equipment_config (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS inventory_config (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_orders (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_customers (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_production (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ops_weighted_scores (
      id VARCHAR(64) PRIMARY KEY,
      userId VARCHAR(64),
      username VARCHAR(64),
      displayName VARCHAR(64),
      arrangementType VARCHAR(16),
      score DECIMAL(10,2),
      date VARCHAR(10),
      createdAt VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sn_registry (
      snCode VARCHAR(128) PRIMARY KEY,
      equipmentType VARCHAR(64),
      handType VARCHAR(16),
      status VARCHAR(32) DEFAULT 'available',
      machineNumber VARCHAR(64),
      trackingNumber VARCHAR(128),
      damageReason TEXT,
      shippedAt VARCHAR(64),
      repairedAt VARCHAR(64),
      updatedAt VARCHAR(64),
      attachment TEXT,
      INDEX idx_sn_updated (updatedAt),
      INDEX idx_sn_status (status),
      INDEX idx_sn_equipment (equipmentType),
      INDEX idx_sn_machine (machineNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sn_status_history (
      id VARCHAR(64) PRIMARY KEY,
      snCode VARCHAR(128),
      oldStatus VARCHAR(32),
      newStatus VARCHAR(32),
      operator VARCHAR(64),
      reason TEXT,
      machineNumber VARCHAR(64),
      createdAt VARCHAR(64),
      INDEX idx_sn_history_sn (snCode),
      INDEX idx_sn_history_time (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS tech_support (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS group_transfers (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS popup_messages (
      id VARCHAR(64) PRIMARY KEY,
      category VARCHAR(32),
      text TEXT,
      createdBy VARCHAR(64),
      createdAt VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS machine_bindings (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS edge_hosts (
      machineNumber VARCHAR(64) PRIMARY KEY,
      hostname VARCHAR(128) DEFAULT '',
      ipAddress VARCHAR(64) DEFAULT '',
      agentVersion VARCHAR(32) DEFAULT '',
      status VARCHAR(16) DEFAULT 'offline',
      lastSeen VARCHAR(64),
      data MEDIUMTEXT,
      createdAt VARCHAR(64),
      updatedAt VARCHAR(64),
      INDEX idx_edge_status (status),
      INDEX idx_edge_lastseen (lastSeen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // 机器生产状态（可生产 ready / 在生产 in_production / 待维修 waiting_repair / 在测试 testing）
    // 与 machines 表的设备挂接状态（online/offline）相互独立；waiting_repair 由工单驱动
    `CREATE TABLE IF NOT EXISTS machine_production (
      machineNumber VARCHAR(64) PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'ready',
      reason VARCHAR(500) DEFAULT '',
      source VARCHAR(16) DEFAULT 'manual',
      ticketId VARCHAR(64) DEFAULT '',
      updatedBy VARCHAR(64) DEFAULT '',
      updatedByName VARCHAR(128) DEFAULT '',
      updatedAt VARCHAR(64),
      INDEX idx_prod_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // 生产状态变更记录（审计流水）
    `CREATE TABLE IF NOT EXISTS machine_production_history (
      id VARCHAR(64) PRIMARY KEY,
      machineNumber VARCHAR(64) DEFAULT '',
      newStatus VARCHAR(32) DEFAULT '',
      data MEDIUMTEXT,
      createdAt VARCHAR(64),
      INDEX idx_mph_machine (machineNumber, createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // 机器运行/生产状态连续区间；开放区间 openKey='Y'，每台机器每类仅允许一个开放区间
    `CREATE TABLE IF NOT EXISTS machine_status_intervals (
      id VARCHAR(64) PRIMARY KEY,
      machineNumber VARCHAR(64) NOT NULL,
      statusType VARCHAR(16) NOT NULL,
      status VARCHAR(32) NOT NULL,
      startedAt VARCHAR(64) NOT NULL,
      endedAt VARCHAR(64) DEFAULT NULL,
      lastSeenAt VARCHAR(64) DEFAULT NULL,
      durationSec INT UNSIGNED DEFAULT 0,
      details MEDIUMTEXT,
      openKey VARCHAR(1) DEFAULT NULL,
      createdAt VARCHAR(64),
      updatedAt VARCHAR(64),
      INDEX idx_msi_machine_time (machineNumber, statusType, startedAt),
      INDEX idx_msi_started (startedAt),
      UNIQUE KEY uq_msi_open (machineNumber, statusType, openKey)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS stocktaking (
      id VARCHAR(64) PRIMARY KEY,
      inv_type VARCHAR(64),
      system_qty INT DEFAULT 0,
      actual_qty INT DEFAULT 0,
      diff INT DEFAULT 0,
      operator VARCHAR(64),
      note TEXT,
      createdAt VARCHAR(64),
      INDEX idx_stocktaking_type (inv_type),
      INDEX idx_stocktaking_time (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS inbound_orders (
      id VARCHAR(64) PRIMARY KEY,
      order_no VARCHAR(64) UNIQUE,
      supplier VARCHAR(128),
      total_qty INT DEFAULT 0,
      received_qty INT DEFAULT 0,
      status VARCHAR(32) DEFAULT 'pending',
      operator VARCHAR(64),
      note TEXT,
      source_type VARCHAR(32) DEFAULT 'manual',
      related_sn TEXT,
      related_order_id VARCHAR(64),
      createdAt VARCHAR(64),
      receivedAt VARCHAR(64),
      INDEX idx_inbound_status (status),
      INDEX idx_inbound_time (createdAt),
      INDEX idx_inbound_source (source_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS outbound_orders (
      id VARCHAR(64) PRIMARY KEY,
      order_no VARCHAR(64) UNIQUE,
      destination VARCHAR(128),
      total_qty INT DEFAULT 0,
      shipped_qty INT DEFAULT 0,
      status VARCHAR(32) DEFAULT 'pending',
      operator VARCHAR(64),
      note TEXT,
      source_type VARCHAR(32) DEFAULT 'manual',
      related_sn TEXT,
      tracking_no VARCHAR(128),
      related_order_id VARCHAR(64),
      createdAt VARCHAR(64),
      shippedAt VARCHAR(64),
      INDEX idx_outbound_status (status),
      INDEX idx_outbound_time (createdAt),
      INDEX idx_outbound_source (source_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS inventory_alerts (
      inv_type VARCHAR(64) PRIMARY KEY,
      min_qty INT DEFAULT 0,
      max_qty INT DEFAULT 99999,
      low_threshold INT DEFAULT 10,
      updatedAt VARCHAR(64),
      updatedBy VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS stocktakes (
      id VARCHAR(64) PRIMARY KEY,
      data MEDIUMTEXT,
      status VARCHAR(16) DEFAULT 'draft',
      created_at VARCHAR(64),
      INDEX idx_stocktake_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id VARCHAR(64) PRIMARY KEY,
      sender_id VARCHAR(64),
      sender_name VARCHAR(64),
      recipient_id VARCHAR(64),
      recipient_name VARCHAR(64),
      message TEXT,
      created_at VARCHAR(64),
      INDEX idx_chat_sender (sender_id),
      INDEX idx_chat_recipient (recipient_id),
      INDEX idx_chat_time (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sop_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(64) DEFAULT '默认',
      url TEXT,
      kind VARCHAR(20) DEFAULT 'url',
      content MEDIUMTEXT,
      mime VARCHAR(100),
      uploaded_by VARCHAR(64),
      uploaded_at VARCHAR(64),
      INDEX idx_sop_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS solutions (
      id VARCHAR(64) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      steps MEDIUMTEXT,
      resources MEDIUMTEXT,
      scenarios MEDIUMTEXT,
      verification MEDIUMTEXT,
      category VARCHAR(64) DEFAULT '默认',
      tags VARCHAR(512),
      usage_count INT DEFAULT 0,
      usage_stats TEXT,
      created_by VARCHAR(64),
      created_at VARCHAR(64),
      updated_at VARCHAR(64),
      INDEX idx_solutions_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS tech_support_solutions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tech_support_id VARCHAR(64) NOT NULL,
      solution_id VARCHAR(64) NOT NULL,
      linked_by VARCHAR(64),
      linked_at VARCHAR(64),
      INDEX idx_tss_tech (tech_support_id),
      INDEX idx_tss_solution (solution_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS replacements (
      id VARCHAR(64) PRIMARY KEY,
      snCode VARCHAR(128) NOT NULL,
      equipmentType VARCHAR(64),
      handType VARCHAR(16),
      status VARCHAR(32) DEFAULT 'in_replacement',
      operator VARCHAR(64),
      note TEXT,
      createdAt VARCHAR(64),
      updatedAt VARCHAR(64),
      INDEX idx_rpl_sn (snCode),
      INDEX idx_rpl_status (status),
      INDEX idx_rpl_time (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS delivery_notes (
      id VARCHAR(64) PRIMARY KEY,
      type VARCHAR(16) NOT NULL DEFAULT 'repair',
      items JSON NOT NULL,
      trackingNumber VARCHAR(128) DEFAULT '',
      operator VARCHAR(64) DEFAULT '',
      operatorName VARCHAR(64) DEFAULT '',
      company VARCHAR(128) DEFAULT '万达智慧手套',
      manufacturer VARCHAR(128) DEFAULT '',
      note TEXT,
      createdAt VARCHAR(64),
      INDEX idx_dn_created (createdAt),
      INDEX idx_dn_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS shift_inspections (
      id VARCHAR(36) PRIMARY KEY,
      machineCode VARCHAR(100) NOT NULL,
      machineNumber VARCHAR(100) NOT NULL DEFAULT '',
      deviceType VARCHAR(50) NOT NULL DEFAULT '',
      checklist JSON NOT NULL,
      operator VARCHAR(100) NOT NULL DEFAULT '',
      note TEXT,
      createdAt DATETIME(3) NOT NULL,
      INDEX idx_machine_code (machineCode),
      INDEX idx_created_at (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // ---- Phase 1 企业级基座：多仓库 / RBAC / 库存审计 ----
    `CREATE TABLE IF NOT EXISTS warehouses (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128),
      status VARCHAR(16) DEFAULT 'active',
      location VARCHAR(255),
      createdAt VARCHAR(64),
      updatedAt VARCHAR(64),
      data MEDIUMTEXT,
      INDEX idx_wh_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS roles (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(64),
      \`system\` VARCHAR(32),
      is_built_in TINYINT(1) DEFAULT 0,
      data MEDIUMTEXT,
      INDEX idx_role_system (\`system\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS inventory_audit (
      id VARCHAR(64) PRIMARY KEY,
      ts VARCHAR(64),
      operator_id VARCHAR(64),
      operator VARCHAR(64),
      action VARCHAR(32),
      warehouse_id VARCHAR(64),
      inv_type VARCHAR(64),
      note TEXT,
      detail TEXT,
      INDEX idx_ia_time (ts),
      INDEX idx_ia_wh_inv (warehouse_id, inv_type),
      INDEX idx_ia_operator (operator)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    // ---- Phase 2：批次跟踪 + 跨仓库调拨 ----
    `CREATE TABLE IF NOT EXISTS batches (
      id VARCHAR(64) PRIMARY KEY,
      inv_type VARCHAR(64) NOT NULL,
      warehouse_id VARCHAR(64) NOT NULL DEFAULT 'main',
      quantity INT DEFAULT 0,
      initial_qty INT DEFAULT 0,
      received_at VARCHAR(64),
      expiry_date VARCHAR(10),
      note TEXT,
      created_by VARCHAR(64),
      created_at VARCHAR(64),
      INDEX idx_batch_inv_wh (inv_type, warehouse_id),
      INDEX idx_batch_expiry (expiry_date),
      INDEX idx_batch_received (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS warehouse_transfers (
      id VARCHAR(64) PRIMARY KEY,
      inv_type VARCHAR(64) NOT NULL,
      from_warehouse VARCHAR(64) NOT NULL,
      to_warehouse VARCHAR(64) NOT NULL,
      quantity INT DEFAULT 0,
      status VARCHAR(16) DEFAULT 'pending',
      note TEXT,
      requested_by VARCHAR(64),
      requested_at VARCHAR(64),
      reviewed_by VARCHAR(64),
      reviewed_at VARCHAR(64),
      review_note TEXT,
      INDEX idx_wt_status (status),
      INDEX idx_wt_time (requested_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  return Promise.all(statements.map(sql => pool.execute(sql)));
}

async function migrateDB() {
  const migrations = [
    `ALTER TABLE delivery_notes ADD COLUMN company VARCHAR(128) DEFAULT '万达智慧手套'`,
    `ALTER TABLE delivery_notes ADD COLUMN manufacturer VARCHAR(128) DEFAULT ''`,
    `ALTER TABLE delivery_notes ADD COLUMN note TEXT`,
    `ALTER TABLE sn_registry ADD COLUMN attachment MEDIUMTEXT`,
    `ALTER TABLE sn_registry MODIFY COLUMN attachment MEDIUMTEXT`,
    `ALTER TABLE chat_messages ADD COLUMN read_at VARCHAR(64) DEFAULT NULL`,
    `ALTER TABLE sop_documents ADD COLUMN kind VARCHAR(20) DEFAULT 'url'`,
    `ALTER TABLE sop_documents ADD COLUMN content MEDIUMTEXT`,
    `ALTER TABLE sop_documents ADD COLUMN mime VARCHAR(100)`,
    `ALTER TABLE sn_registry ADD COLUMN trackingNumber VARCHAR(128)`,
    `ALTER TABLE sn_registry ADD COLUMN shippedAt VARCHAR(64)`,
    `ALTER TABLE sn_registry ADD COLUMN repairedAt VARCHAR(64)`,
    `ALTER TABLE sn_registry ADD COLUMN source VARCHAR(64)`,
    `ALTER TABLE sn_registry ADD COLUMN location_code VARCHAR(64)`,
    `CREATE INDEX idx_sn_location ON sn_registry(location_code)`,
    `CREATE TABLE IF NOT EXISTS storage_locations (
      code VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) DEFAULT '',
      area VARCHAR(64) DEFAULT '',
      description TEXT,
      createdAt VARCHAR(64),
      updatedAt VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `ALTER TABLE users ADD COLUMN parentId VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN displayName VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN status VARCHAR(16) DEFAULT 'active'`,
    `ALTER TABLE users ADD COLUMN encryptedPassword VARCHAR(512)`,
    `ALTER TABLE users ADD COLUMN email VARCHAR(128)`,
    `ALTER TABLE users ADD COLUMN phone VARCHAR(32)`,
    `ALTER TABLE users ADD COLUMN department VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN lastLoginAt VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN updatedAt VARCHAR(64)`,
    `UPDATE users SET displayName = username WHERE displayName IS NULL`,
    `ALTER TABLE ops_weighted_scores ADD COLUMN arrangementType VARCHAR(16)`,
    `ALTER TABLE ops_weighted_scores ADD COLUMN isExternal TINYINT DEFAULT 0`,
    // Performance indexes (MySQL 5.7+ and 8.0 compatible)
    `CREATE INDEX idx_sn_updated ON sn_registry(updatedAt)`,
    `CREATE INDEX idx_sn_status ON sn_registry(status)`,
    `CREATE INDEX idx_sn_equipment ON sn_registry(equipmentType)`,
    `CREATE INDEX idx_sn_machine ON sn_registry(machineNumber)`,

    // ---- 热路径优化：machines 表冗余列（替代全表 JSON_EXTRACT 扫描）----
    `ALTER TABLE machines ADD COLUMN machineNumber VARCHAR(64)`,
    `ALTER TABLE machines ADD COLUMN status VARCHAR(32)`,
    `ALTER TABLE machines ADD COLUMN updatedAt VARCHAR(64)`,
    `CREATE INDEX idx_machines_number_updated ON machines(machineNumber, updatedAt)`,
    // ---- machine_bindings 表冗余列（替代全表加载 + JS filter）----
    `ALTER TABLE machine_bindings ADD COLUMN machineNumber VARCHAR(64)`,
    `ALTER TABLE machine_bindings ADD COLUMN userId VARCHAR(64)`,
    `ALTER TABLE machine_bindings ADD COLUMN unboundAt VARCHAR(64)`,
    `CREATE INDEX idx_bind_machine_active ON machine_bindings(machineNumber, unboundAt)`,
    `CREATE INDEX idx_bind_user_active ON machine_bindings(userId, unboundAt)`,
    `CREATE INDEX idx_users_parentId ON users(parentId)`,
    // ---- 班次首检：shift_inspections 增加班次/状态/提交人字段 ----
    `ALTER TABLE shift_inspections ADD COLUMN shift VARCHAR(16) DEFAULT 'morning'`,
    `ALTER TABLE shift_inspections ADD COLUMN status VARCHAR(16) DEFAULT 'completed'`,
    `ALTER TABLE shift_inspections ADD COLUMN operatorId VARCHAR(64) DEFAULT ''`,
    `ALTER TABLE shift_inspections ADD COLUMN operatorName VARCHAR(64) DEFAULT ''`,
    `ALTER TABLE shift_inspections ADD COLUMN operatorEmpId VARCHAR(64) DEFAULT ''`,
    // ---- 班次首检：复合索引加速按机器+时间窗口的查询（今日概览/历史列表）----
    `CREATE INDEX idx_shift_machine_created ON shift_inspections(machineCode, createdAt)`,
    `CREATE INDEX idx_shift_shift_created ON shift_inspections(shift, createdAt)`,

    // ---- 回填冗余列（每次启动都跑，只更新 NULL 行，自愈；JSON_UNQUOTE 去引号）----
    `UPDATE machines SET machineNumber = JSON_UNQUOTE(JSON_EXTRACT(data,'$.machineNumber')) WHERE machineNumber IS NULL`,
    `UPDATE machines SET status = JSON_UNQUOTE(JSON_EXTRACT(data,'$.status')) WHERE status IS NULL`,
    `UPDATE machines SET updatedAt = JSON_UNQUOTE(JSON_EXTRACT(data,'$.updatedAt')) WHERE updatedAt IS NULL`,
    `UPDATE machine_bindings SET machineNumber = JSON_UNQUOTE(JSON_EXTRACT(data,'$.machineNumber')) WHERE machineNumber IS NULL`,
    `UPDATE machine_bindings SET userId = JSON_UNQUOTE(JSON_EXTRACT(data,'$.userId')) WHERE userId IS NULL`,
    `UPDATE machine_bindings SET unboundAt = JSON_UNQUOTE(JSON_EXTRACT(data,'$.unboundAt')) WHERE unboundAt IS NULL AND JSON_EXTRACT(data,'$.unboundAt') IS NOT NULL`,

    // ---- 出入库单扩展字段（维修场景）----
    `ALTER TABLE inbound_orders ADD COLUMN source_type VARCHAR(32) DEFAULT 'manual'`,
    `ALTER TABLE inbound_orders ADD COLUMN related_sn TEXT`,
    `ALTER TABLE inbound_orders ADD COLUMN related_order_id VARCHAR(64)`,
    `ALTER TABLE inbound_orders ADD INDEX idx_inbound_source (source_type)`,
    `ALTER TABLE outbound_orders ADD COLUMN source_type VARCHAR(32) DEFAULT 'manual'`,
    `ALTER TABLE outbound_orders ADD COLUMN related_sn TEXT`,
    `ALTER TABLE outbound_orders ADD COLUMN tracking_no VARCHAR(128)`,
    `ALTER TABLE outbound_orders ADD COLUMN related_order_id VARCHAR(64)`,
    `ALTER TABLE outbound_orders ADD INDEX idx_outbound_source (source_type)`,

    // ---- transactions 结构化字段 ----
    `ALTER TABLE transactions ADD COLUMN ref_type VARCHAR(32)`,
    `ALTER TABLE transactions ADD COLUMN ref_id VARCHAR(64)`,
    `ALTER TABLE transactions ADD COLUMN inv_type VARCHAR(64)`,
    `ALTER TABLE transactions ADD COLUMN direction VARCHAR(8)`,
    `ALTER TABLE transactions ADD COLUMN quantity INT DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN operator VARCHAR(64)`,
    `ALTER TABLE transactions ADD COLUMN createdAt VARCHAR(64)`,
    `ALTER TABLE transactions ADD INDEX idx_tx_ref (ref_type, ref_id)`,
    `ALTER TABLE transactions ADD INDEX idx_tx_inv (inv_type)`,
    `ALTER TABLE transactions ADD INDEX idx_tx_direction (direction)`,
    `ALTER TABLE transactions ADD INDEX idx_tx_time (createdAt)`,

    // ---- 回填 transactions 结构化列（从 JSON data 提取，幂等：仅更新 NULL/0 行）----
    // 修复历史：handleAddTransaction/handleTransferInventory/handleDeleteSNFull 旧版本只写 JSON data，
    // 导致 ref_type/inv_type/direction/quantity/operator/createdAt 为 NULL，4 个索引失效。此回填自愈。
    `UPDATE transactions SET ref_type = JSON_UNQUOTE(JSON_EXTRACT(data,'$.type')) WHERE ref_type IS NULL AND JSON_EXTRACT(data,'$.type') IS NOT NULL`,
    `UPDATE transactions SET ref_id = JSON_UNQUOTE(JSON_EXTRACT(data,'$.refId')) WHERE ref_id IS NULL AND JSON_EXTRACT(data,'$.refId') IS NOT NULL`,
    `UPDATE transactions SET inv_type = COALESCE(
       JSON_UNQUOTE(JSON_EXTRACT(data,'$.invType')),
       CASE
         WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.equipmentType'))='glove' AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.handType'))='left' THEN 'left_glove'
         WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.equipmentType'))='glove' AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.handType'))='right' THEN 'right_glove'
         WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.equipmentType'))='dexterous_hand' AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.handType'))='left' THEN 'left_dexterous_hand'
         WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.equipmentType'))='dexterous_hand' AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.handType'))='right' THEN 'right_dexterous_hand'
         ELSE JSON_UNQUOTE(JSON_EXTRACT(data,'$.equipmentType'))
       END
     ) WHERE inv_type IS NULL AND JSON_EXTRACT(data,'$.equipmentType') IS NOT NULL`,
    `UPDATE transactions SET direction = JSON_UNQUOTE(JSON_EXTRACT(data,'$.direction')) WHERE direction IS NULL AND JSON_EXTRACT(data,'$.direction') IS NOT NULL`,
    `UPDATE transactions SET quantity = CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.quantity')) AS UNSIGNED) WHERE (quantity IS NULL OR quantity = 0) AND JSON_EXTRACT(data,'$.quantity') IS NOT NULL`,
    `UPDATE transactions SET operator = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.operator')), JSON_UNQUOTE(JSON_EXTRACT(data,'$.updatedBy'))) WHERE operator IS NULL AND (JSON_EXTRACT(data,'$.operator') IS NOT NULL OR JSON_EXTRACT(data,'$.updatedBy') IS NOT NULL)`,
    `UPDATE transactions SET createdAt = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.timestamp')), JSON_UNQUOTE(JSON_EXTRACT(data,'$.createdAt'))) WHERE createdAt IS NULL AND (JSON_EXTRACT(data,'$.timestamp') IS NOT NULL OR JSON_EXTRACT(data,'$.createdAt') IS NOT NULL)`,

    // ---- 回填 ref_type / ref_id（历史记录的 JSON data 无 $.type/$.refId 字段）----
    // 旧版 handleAddTransaction/handleTransferInventory 只写 JSON data，未带 type/refId，
    // 导致上面的 $.type 回填无效。此处按 note/direction 模式推断业务类型，与新版
    // _insertTransaction 写入的 type 词汇表（inbound_order / machine_delete / ...）对齐。
    // 顺序敏感：具体模式在前，direction 兜底在后。幂等（WHERE ref_type IS NULL）。
    `UPDATE transactions SET ref_type = CASE
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%上线自动扣减%' THEN 'machine_online'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%上线%' AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.direction')) = 'out' THEN 'machine_online'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%下线自动归还%' THEN 'machine_offline'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%下线%' THEN 'machine_offline'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%删除机器记录%' THEN 'machine_delete'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%售后发货%' THEN 'repair_ship'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%售后完成%' THEN 'repair_complete'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%维修完成%' THEN 'repair_complete'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%标记损坏%' THEN 'damaged'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%损坏%' THEN 'damaged'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%批量入库%' THEN 'inbound'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%调拨%' THEN 'transfer'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%调出%' THEN 'transfer'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%出库%' THEN 'outbound'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.note')) LIKE '%入库%' THEN 'inbound'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.direction')) = 'in' THEN 'inbound'
       WHEN JSON_UNQUOTE(JSON_EXTRACT(data,'$.direction')) = 'out' THEN 'outbound'
       ELSE 'manual'
     END WHERE ref_type IS NULL`,
    // ref_id：机器类操作关联 machineNumber，售后/损坏关联 snCode，其余留空
    `UPDATE transactions SET ref_id = JSON_UNQUOTE(JSON_EXTRACT(data,'$.machineNumber')) WHERE ref_id IS NULL AND ref_type IN ('machine_online','machine_offline','machine_delete')`,
    `UPDATE transactions SET ref_id = JSON_UNQUOTE(JSON_EXTRACT(data,'$.snCode')) WHERE ref_id IS NULL AND ref_type IN ('repair_ship','repair_complete','damaged')`,

    // ---- ITSM 升级：tech_support 表冗余列（索引镜像，替代全表 JSON_EXTRACT 扫描）----
    // 模式同 machines/machine_bindings：普通列 + saveTechSupport 双写。
    // status_v2 存新枚举（open/assigned/in_progress/resolved/closed/reopened），
    // 与 JSON $.status 同步。旧数据 pending/responded/completed 经 CASE 映射回填。
    `ALTER TABLE tech_support ADD COLUMN status_v2      VARCHAR(16)`,
    `ALTER TABLE tech_support ADD COLUMN priority       VARCHAR(4)`,
    `ALTER TABLE tech_support ADD COLUMN category       VARCHAR(16)`,
    `ALTER TABLE tech_support ADD COLUMN assignee_id    VARCHAR(64)`,
    `ALTER TABLE tech_support ADD COLUMN submitter_id   VARCHAR(64)`,
    `ALTER TABLE tech_support ADD COLUMN machine_no     VARCHAR(64)`,
    `ALTER TABLE tech_support ADD COLUMN submitted_ts   VARCHAR(64)`,
    `ALTER TABLE tech_support ADD COLUMN sla_respond_by VARCHAR(64)`,
    `ALTER TABLE tech_support ADD COLUMN sla_resolve_by VARCHAR(64)`,
    `ALTER TABLE tech_support ADD COLUMN sla_breached   TINYINT(1) DEFAULT 0`,
    `CREATE INDEX idx_ts_status_v2   ON tech_support(status_v2)`,
    `CREATE INDEX idx_ts_priority    ON tech_support(priority)`,
    `CREATE INDEX idx_ts_assignee    ON tech_support(assignee_id)`,
    `CREATE INDEX idx_ts_submitter   ON tech_support(submitter_id)`,
    `CREATE INDEX idx_ts_category    ON tech_support(category)`,
    `CREATE INDEX idx_ts_submitted   ON tech_support(submitted_ts)`,
    `CREATE INDEX idx_ts_sla_resolve ON tech_support(sla_resolve_by)`,
    `CREATE INDEX idx_ts_machine     ON tech_support(machine_no)`,

    // ---- 回填 tech_support 冗余列（启动幂等：仅更新 NULL 行，自愈）----
    // status_v2：旧 status 经 CASE 映射到新枚举；新数据已写新枚举，CASE 兜底
    `UPDATE tech_support SET status_v2 = CASE JSON_UNQUOTE(JSON_EXTRACT(data,'$.status'))
       WHEN 'pending' THEN 'open'
       WHEN 'responded' THEN 'in_progress'
       WHEN 'completed' THEN 'resolved'
       ELSE JSON_UNQUOTE(JSON_EXTRACT(data,'$.status'))
     END WHERE status_v2 IS NULL AND JSON_EXTRACT(data,'$.status') IS NOT NULL`,
    `UPDATE tech_support SET priority = IFNULL(JSON_UNQUOTE(JSON_EXTRACT(data,'$.priority')),'P2') WHERE priority IS NULL`,
    `UPDATE tech_support SET category = IFNULL(JSON_UNQUOTE(JSON_EXTRACT(data,'$.category')),'hardware') WHERE category IS NULL`,
    `UPDATE tech_support SET assignee_id = JSON_UNQUOTE(JSON_EXTRACT(data,'$.assigneeId')) WHERE assignee_id IS NULL AND JSON_EXTRACT(data,'$.assigneeId') IS NOT NULL`,
    `UPDATE tech_support SET assignee_id = JSON_UNQUOTE(JSON_EXTRACT(data,'$.responderId')) WHERE assignee_id IS NULL AND JSON_EXTRACT(data,'$.responderId') IS NOT NULL`,
    `UPDATE tech_support SET submitter_id = JSON_UNQUOTE(JSON_EXTRACT(data,'$.submitterId')) WHERE submitter_id IS NULL`,
    `UPDATE tech_support SET machine_no = JSON_UNQUOTE(JSON_EXTRACT(data,'$.machineNumber')) WHERE machine_no IS NULL`,
    `UPDATE tech_support SET submitted_ts = JSON_UNQUOTE(JSON_EXTRACT(data,'$.submittedAt')) WHERE submitted_ts IS NULL`,
    `UPDATE tech_support SET sla_respond_by = JSON_UNQUOTE(JSON_EXTRACT(data,'$.slaRespondBy')) WHERE sla_respond_by IS NULL AND JSON_EXTRACT(data,'$.slaRespondBy') IS NOT NULL`,
    `UPDATE tech_support SET sla_resolve_by = JSON_UNQUOTE(JSON_EXTRACT(data,'$.slaResolveBy')) WHERE sla_resolve_by IS NULL AND JSON_EXTRACT(data,'$.slaResolveBy') IS NOT NULL`,
  ];
  // 顺序执行：ALTER 必须先于依赖它的 UPDATE/CREATE INDEX 提交，
  // 否则并行时 UPDATE 会因 "Unknown column" 竞态失败并被 catch 静默吞掉，
  // 导致冗余列回填缺失、读路径索引查询漏数据。
  for (const sql of migrations) {
    try { await pool.execute(sql); }
    catch (e) { /* 列/索引已存在，或回填无 NULL 行 —— 幂等忽略 */ }
  }

  // ---- Phase 1：inventory 仓库维度迁移 ----
  // 现有数据全部归入 'main' 主仓库（ADD COLUMN 默认值完成回填），复合主键支持分仓独立核算。
  try { await pool.execute('ALTER TABLE inventory ADD COLUMN warehouse_id VARCHAR(64) NOT NULL DEFAULT \'main\''); }
  catch (e) { /* 列已存在 */ }
  try { await pool.execute('ALTER TABLE inventory DROP PRIMARY KEY, ADD PRIMARY KEY (inv_type, warehouse_id)'); }
  catch (e) { /* 主键已是复合键，重复执行无害 */ }
  // users 表：自定义角色引用（RBAC）
  try { await pool.execute('ALTER TABLE users ADD COLUMN custom_role VARCHAR(64)'); }
  catch (e) { /* 列已存在 */ }
}

async function seedDefaults() {
  // Phase 1：主仓库种子数据（现有库存迁移时全部归入 main，见 migrateDB）
  const [[{ c: whCount }]] = await pool.execute('SELECT COUNT(*) as c FROM warehouses');
  if (whCount === 0) {
    const now = new Date().toISOString();
    await pool.execute(
      'INSERT INTO warehouses (id, name, status, location, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['main', '主仓库', 'active', '', now, now, JSON.stringify({ id: 'main', name: '主仓库', location: '', remark: '系统默认仓库', isDefault: true, createdAt: now })]
    );
  }

  const [[{ c }]] = await pool.execute('SELECT COUNT(*) as c FROM users');
  if (c === 0) {
    // S6: use hashPasswordSync for seed data (one-shot, startup-only)
    const users = [
      ['sa-001', 'Yunwei', hashPasswordSync('yunwei1025'), 'superadmin', 'maintenance', '运维超管', null, new Date().toISOString()],
      ['sa-002', 'yunying', hashPasswordSync('yunying1025'), 'superadmin', 'operations', '运营超管', null, new Date().toISOString()],
      ['admin-001', 'admin', hashPasswordSync('admin123'), 'admin', 'maintenance', '管理员', null, new Date().toISOString()],
    ];
    for (const u of users) {
      await pool.execute(
        'INSERT INTO users (id, username, passwordHash, role, \`system\`, displayName, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        u
      );
    }
  }

  const [[{ c: eqCount }]] = await pool.execute('SELECT COUNT(*) as c FROM equipment_config');
  if (eqCount === 0) {
    const defaults = [
      { id: 'glove', name: '纯手套设备', icon: '🧤', consumes: [{ inventoryType: 'left_glove', handType: 'left', quantity: 1 }, { inventoryType: 'right_glove', handType: 'right', quantity: 1 }], createdAt: new Date().toISOString() },
      { id: 'dexterous', name: '灵巧手设备', icon: '🤖', consumes: [{ inventoryType: 'left_glove', handType: 'left', quantity: 1 }, { inventoryType: 'right_glove', handType: 'right', quantity: 1 }, { inventoryType: 'left_dexterous_hand', handType: 'left', quantity: 1 }, { inventoryType: 'right_dexterous_hand', handType: 'right', quantity: 1 }], createdAt: new Date().toISOString() },
      { id: 'gripper', name: '夹爪设备', icon: '🔧', consumes: [{ inventoryType: 'gripper', handType: null, quantity: 2 }], createdAt: new Date().toISOString() },
    ];
    for (const d of defaults) {
      await pool.execute('INSERT INTO equipment_config (id, data) VALUES (?, ?)', [d.id, JSON.stringify(d)]);
    }
  }

  const [[{ c: invCfgCount }]] = await pool.execute('SELECT COUNT(*) as c FROM inventory_config');
  if (invCfgCount === 0) {
    const defaults = [
      { id: 'left_glove', name: '左手手套', sku: 'LEFT-GLOVE', icon: '🧤', hasLeftRight: false, trackingMode: 'sn', createdAt: new Date().toISOString() },
      { id: 'right_glove', name: '右手手套', sku: 'RIGHT-GLOVE', icon: '🧤', hasLeftRight: false, trackingMode: 'sn', createdAt: new Date().toISOString() },
      { id: 'left_dexterous_hand', name: '左手灵巧手', sku: 'LEFT-DEX-HAND', icon: '🤖', hasLeftRight: false, trackingMode: 'sn', createdAt: new Date().toISOString() },
      { id: 'right_dexterous_hand', name: '右手灵巧手', sku: 'RIGHT-DEX-HAND', icon: '🤖', hasLeftRight: false, trackingMode: 'sn', createdAt: new Date().toISOString() },
      { id: 'gripper', name: '夹爪', sku: 'GRIPPER', icon: '🔧', hasLeftRight: false, trackingMode: 'sn', createdAt: new Date().toISOString() },
    ];
    for (const d of defaults) {
      await pool.execute('INSERT INTO inventory_config (id, data) VALUES (?, ?)', [d.id, JSON.stringify(d)]);
    }
  }

  // Seed popup messages
  const [[{ c: popupCount }]] = await pool.execute('SELECT COUNT(*) as c FROM popup_messages');
  if (popupCount === 0) {
    const submitMsgs = [
      '辛苦了！运维人员正在风雨兼程赶来救你！', '请求已发射到运维星球，外星人正在处理中...', '你的勇气令人钦佩，故障已经被吓跑了一半！',
      '提交成功！运维小哥哥已经开始磨刀霍霍了！', '收到！我们的维修大师正在热身准备！', '已通知运维团队，他们激动得跳了起来！',
      '故障颤抖吧！运维英雄即将登场！', '你的请求像火箭一样飞向了运维中心！', '太好了，又一个挑战！运维人员摩拳擦掌中！',
      '提交成功！运维猫咪已经出发去修理了！', '收到请求！运维超人正在穿披风！', '故障别跑！运维战士即将到达战场！',
      '你的耐心是最大的美德，运维团队全力出击！', '请求已进入运维加速器，光速处理中！', '运维小队：终于有活干了，冲啊！',
      '提交成功！你的设备正在等待被拯救！', '收到！维修工具已经自动打包完毕！', '运维大佬露出了自信的微笑！',
      '故障代码：已投降。运维人员：出发！', '你的设备发出了求救信号，救援正在路上！', '运维军团已集结，准备攻城拔寨！',
      '提交成功！运维小飞侠已起飞！', '收到！运维忍者已潜入修复模式！', '故障君请准备好，运维大侠要来挑战了！',
      '你的请求已被标记为“十万火急”！', '运维咖啡已煮好，准备通宵作战！', '收到！运维AI已启动自动修复程序（开玩笑的）！',
      '故障：我害怕。运维：那就对了！', '你的设备正在做深呼吸，维修马上开始！', '运维团队：让我们看看是谁又在搞事情！',
      '提交成功！维修小精灵已被释放！', '运维人员已戴上安全帽，准备进入战场！', '收到！你的设备即将重获新生！',
      '故障已被列入运维团队的“待揍清单”！', '运维超级赛亚人正在充能！', '你的请求正在以5G速度传递到运维中心！',
      '运维人员：来吧，展示！', '收到！维修机器人已启动（其实是人工的）！', '故障：我要被打败了吗？运维：是的！',
      '你的设备即将迎来它的“整容手术”！', '运维团队搓了搓手：这个我擅长！', '提交成功！维修模式ON！',
      '运维人员正在做热身运动，马上就到！', '收到！你的设备即将满血复活！', '运维大佬：区区小故障，不足挂齿！',
      '你的请求被运维团队视为今日挑战！', '故障：等等我还没准备好！运维：太晚了！', '运维小队已装备完毕，请求出战！',
      '提交成功！维修能量已充满100%！', '收到！你的设备正在享受VIP维修服务！',
    ];
    const completeMsgs = [
      '辛苦了，小哥哥！你是最棒的维修大师！', '维修完成！你简直是设备界的救世主！', '太厉害了！故障在你面前不堪一击！',
      '完美修复！运维之星非你莫属！', '辛苦了！设备对你感激涕零！', '维修完毕！你的技术让人叹为观止！',
      '故障已被你KO！冠军！', '辛苦了！设备已经满血复活啦！', '你是维修界的传说！',
      '完成！你是设备世界的超级英雄！', '辛苦了大佬！设备给你比心！', '完美！维修之神降临人间！',
      '故障：我认输了。你：那当然！', '辛苦了！设备说它再也不敢坏了！', '维修完毕！你的速度比闪电还快！',
      '太强了！故障见到你就跑了！', '辛苦了！设备已经在给你写感谢信了！', '完成！你是运维团队的MVP！',
      '维修大师出手，故障无处遁形！', '辛苦了！你的维修能量爆棚了！', '太棒了！设备已经在庆祝重生了！',
      '辛苦了！你的技术已经超越了人类极限！', '故障已修复，你简直就是魔法师！', '维修完成！你是最闪亮的星！',
      '辛苦了！设备感动得都要哭了！', '完美修复！你让故障瑟瑟发抖！', '运维之王，非你莫属！',
      '辛苦了！故障已经被送进了回收站！', '维修完毕！你是设备们的偶像！', '太强了！故障看到你的名字就投降了！',
      '辛苦了！设备给你颁发了最佳维修奖！', '完成！你是运维界的扛把子！', '故障已经被你的气场吓退了！',
      '辛苦了！设备已经在朋友圈夸你了！', '维修完毕！你是行走的维修百科全书！', '你的维修速度让光速都自愧不如！',
      '辛苦了！设备说下次还找你修！', '完美！你是维修界的扛把子！', '故障已被彻底消灭，和平降临！',
      '辛苦了！你是运维团队的定海神针！', '维修完成！设备给你点了100个赞！', '太强了！故障已经被你打进了冷宫！',
      '辛苦了！设备已经在写回忆录了！', '完成！你的维修技艺堪称艺术！', '故障已被你降维打击！',
      '辛苦了！设备决定以后好好表现！', '维修完毕！你是运维界的传说！', '你的维修能力已经超出了系统评分范围！',
      '辛苦了！设备给你比了个大大的心！', '完美！故障已经被永远封印了！',
    ];
    for (const text of submitMsgs) {
      const id = `pm-s-${  Math.random().toString(36).slice(2, 10)}`;
      await pool.execute('INSERT INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
        [id, 'submit', text, 'system', new Date().toISOString()]);
    }
    for (const text of completeMsgs) {
      const id = `pm-c-${  Math.random().toString(36).slice(2, 10)}`;
      await pool.execute('INSERT INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
        [id, 'complete', text, 'system', new Date().toISOString()]);
    }
  }
}

// ==================== DATA MIGRATION FROM JSON ====================
async function migrateFromJSON() {
  const flagFile = path.join(DATA_DIR, '.migrated_to_mysql');
  if (fs.existsSync(flagFile)) return;

  const jsonFiles = {
    inventory: 'inventory.json',
    machines: 'machines.json',
    transactions: 'transactions.json',
    audit_log: 'audit_log.json',
    settings: 'settings.json',
    users: 'users.json',
    equipment_config: 'equipment_config.json',
    inventory_config: 'inventory_config.json',
    ops_orders: 'ops_orders.json',
    ops_customers: 'ops_customers.json',
    ops_production: 'ops_production.json',
  };

  for (const [table, file] of Object.entries(jsonFiles)) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (table === 'settings') {
        for (const [k, v] of Object.entries(data)) {
          await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
        }
      } else if (table === 'inventory') {
        for (const item of data) {
          await pool.execute(
            'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
            [item.type, item.warehouseId || 'main', item.quantity, item.updatedAt || null, item.updatedBy || '']
          );
        }
      } else if (table === 'users') {
        for (const u of data) {
          await pool.execute(
            'REPLACE INTO users (id, username, passwordHash, role, \`system\`, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [u.id, u.username, u.passwordHash, u.role || 'user', u.system || 'maintenance', u.createdBy || null, u.createdAt || new Date().toISOString()]
          );
        }
      } else if (Array.isArray(data)) {
        for (const item of data) {
          const id = item.id || item.type || (`_${  Math.random().toString(36).slice(2)}`);
          await pool.execute(`REPLACE INTO ${validateTable(table)} (id, data) VALUES (?, ?)`, [id, JSON.stringify(item)]);
        }
      }
      console.log(`  √ 已迁移 ${file} → ${table}`);
    } catch (e) {
      console.log(`  ✗ 迁移 ${file} 失败: ${e.message}`);
    }
  }

  fs.writeFileSync(flagFile, new Date().toISOString());
  console.log('  JSON → MySQL 迁移完成\n');
}

// ==================== AUTH ====================
// S6: hashPassword is now async scrypt (CPU-intensive, ~100-200ms per call).
// All handler call sites must use `await hashPassword(pw)`.
async function hashPassword(pw) {
  return _newHash(pw);
}

const ENCRYPTION_KEY = crypto.scryptSync('gms-encryption-key', 'gms-salt', 32);
const ENCRYPTION_IV = crypto.createHash('md5').update('gms-iv-salt').digest().slice(0, 16);

function encryptPassword(pw) {
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, ENCRYPTION_IV);
  let encrypted = cipher.update(pw, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decryptPassword(encrypted) {
  if (!encrypted) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, ENCRYPTION_IV);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// ==================== TOKEN / SESSION (Redis-backed) ====================
const tokens = {};     // in-memory fallback when Redis not available
const tokensPath = path.join(DATA_DIR, 'tokens.json');

function saveTokens() {
  try { fs.writeFileSync(tokensPath, JSON.stringify(tokens)); } catch {}
}

// Restore tokens on restart (fallback only)
try {
  if (fs.existsSync(tokensPath)) {
    Object.assign(tokens, JSON.parse(fs.readFileSync(tokensPath, 'utf8')));
  }
} catch {}

async function createToken(user, source) {
  const tokenData = {
    userId: user.id, username: user.username,
    displayName: user.displayName || user.username,
    role: user.role, system: user.system || 'maintenance',
    lockedDeviceType: user.lockedDeviceType || null,
    source: source || 'web', // 'web' = 浏览器, 'mobile' = 移动端/链接页
    expires: Date.now() + TOKEN_EXPIRY, lastActive: Date.now(),
  };
  const token = source === 'mobile'
    ? createMobileSignedToken(tokenData)
    : crypto.randomBytes(32).toString('hex');
  // Redis primary + memory fallback
  if (redisClient) {
    await _redisSet(`tk:${token}`, tokenData, TOKEN_EXPIRY / 1000);
    await redisClient.sAdd(`u:tk:${user.id}:${tokenData.source}`, token);
  }
  tokens[token] = tokenData;
  saveTokens();
  return token;
}

async function validateToken(token) {
  const signedMobile = verifyMobileSignedToken(token);
  if (signedMobile) return signedMobile;
  // Try Redis first
  let t = null;
  if (redisClient) {
    try {
      const raw = await redisClient.get(`tk:${token}`);
      if (raw) {
        t = JSON.parse(raw);
        // Refresh TTL (sliding window)
        t.expires = Date.now() + TOKEN_EXPIRY;
        t.lastActive = Date.now();
        await redisClient.setEx(`tk:${token}`, TOKEN_EXPIRY / 1000, JSON.stringify(t));
        return t;
      }
    } catch {}
  }
  // Memory fallback. PM2 runs multiple workers; when Redis is unavailable,
  // reload the shared token snapshot so a request routed to another worker
  // can still use a token created by the login worker.
  if (!tokens[token]) {
    try {
      if (fs.existsSync(tokensPath)) {
        const persisted = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
        if (persisted && persisted[token]) Object.assign(tokens, persisted);
      }
    } catch {}
  }
  t = tokens[token];
  if (!t || t.expires < Date.now()) {
    if (t) { delete tokens[token]; saveTokens(); }
    return null;
  }
  t.expires = Date.now() + TOKEN_EXPIRY;
  t.lastActive = Date.now();
  return t;
}

async function invalidateUserTokens(userId, source) {
  if (redisClient) {
    try {
      const key = source ? `u:tk:${userId}:${source}` : `u:tk:${userId}`;
      const members = await redisClient.sMembers(key);
      if (members.length > 0) {
        await redisClient.del(...members.map(k => `tk:${k.replace('tk:', '')}`));
        await redisClient.del(key);
      }
      // 如果指定了 source，也清理旧格式的 key（兼容迁移）
      if (source) {
        const oldKey = `u:tk:${userId}`;
        const oldMembers = await redisClient.sMembers(oldKey);
        if (oldMembers.length > 0) {
          for (const m of oldMembers) {
            const raw = await redisClient.get(`tk:${m}`);
            if (raw) {
              try {
                const data = JSON.parse(raw);
                if (data.source === source) {
                  await redisClient.del(`tk:${m}`);
                }
              } catch {}
            }
          }
          await redisClient.del(oldKey);
        }
      }
    } catch {}
  }
  Object.keys(tokens).forEach(k => {
    if (tokens[k].userId === userId) {
      if (!source || tokens[k].source === source) delete tokens[k];
    }
  });
  saveTokens();
}

// ==================== REALTIME (SSE + WebSocket 双通道) ====================
// realtime 引擎统一管理 SSE 和 WebSocket 连接
// SSE 客户端通过 realtime.addSSEClient/res 添加
// broadcastSSE 保留为便捷函数, 实际走 realtime 引擎
const sseClients = realtime.getSSEClients();

function broadcastSSE(event, data) {
  // 通过 realtime 引擎同时投递到 WS + SSE (含 Redis 跨 Worker)
  realtime.deliver(event, data, { force: true });
  // 兼容旧逻辑: 缓存失效
  _invalidateCache(event);
}

// ==================== Phase 1.2: 统一伞形事件广播 ====================
// 一次操作只广播一个 `data_changed` 事件（payload 含 main + sideEffects），
// 替代原来一次操作连发 N 个 *_updated（tech_support 完成曾连发 4 个）。
// 收益：① 减少 SSE/WS 消息数（N→1）；② 原子化失效所有相关缓存，避免中间状态读到脏数据；
//      ③ 前端只需一个 data_changed 监听器 + 1s 防抖统一 /api/sync。
// 兼容：前端仍保留各 *_updated 监听器，未迁移的单事件广播点继续用 broadcastSSE。
function broadcastChange(main, sideEffects = [], data = {}) {
  if (!sideEffects) sideEffects = [];
  const allEvents = [`${main  }_updated`, ...sideEffects.map(s => `${s  }_updated`)];
  // 原子化失效所有相关缓存（在投递事件前完成，避免 worker 读到未失效的脏缓存）
  for (const evt of allEvents) {
    _invalidateCache(evt);
  }
  // 只投递一个统一事件，payload 标注 main + sideEffects 供前端定向处理
  realtime.deliver('data_changed', { main, sideEffects, ...data, ts: Date.now() }, { force: true });
}

// ==================== IN-MEMORY CACHE + REQUEST COALESCING ====================
const _cache = new Map();
const _inflight = new Map();  // key -> Promise (prevents thundering herd)
const CACHE_TTL = {
  equipment_config: 300000,  // 5min
  inventory_config: 300000,  // 5min
  sn_registry: 60000,        // 60s
  machines: 3000,            // Agent 状态实时合并，最多缓存 3s
  tech_support: 120000,      // 2min - 大幅增加，WS实时推送保证数据及时性
  sync: 30000,               // 30s
};

function _invalidateCache(event) {
  const map = {
    'equipment_config_updated': 'equipment_config',
    'inventory_config_updated': 'inventory_config',
    'sn_registry_updated': 'sn_registry',
    'machines_updated': 'machines',
    'inventory_updated': 'sync',
    'transactions_updated': 'sync',
    'tech_support_updated': 'tech_support',
    'settings_updated': 'sync',
    'users_updated': 'sync',
    'group_transfer_updated': 'sync',
    'ops_orders_updated': 'sync',
    'ops_customers_updated': 'sync',
    'ops_production_updated': 'sync',
    'audit_log_updated': 'sync',
    'warehouses_updated': 'sync',
    'roles_updated': 'sync',
    'warehouse_transfers_updated': 'sync',
  };
  for (const [evt, key] of Object.entries(map)) {
    if (event === evt) _cache.delete(key);
  }
  if (event === 'tech_support_updated') _cache.delete('sync');
}

async function _cached(key, fetcher, ttlOverride) {
  const ttl = ttlOverride || CACHE_TTL[key] || 3000;
  // Check cache
  const entry = _cache.get(key);
  if (entry && (Date.now() - entry.ts) < ttl) return entry.data;

  // Single-flight: if already fetching, wait for that result
  if (_inflight.has(key)) return _inflight.get(key);

  const promise = (async () => {
    try {
      const data = await fetcher();
      _cache.set(key, { data, ts: Date.now() });
      return data;
    } finally {
      _inflight.delete(key);
    }
  })();

  _inflight.set(key, promise);
  return promise;
}

// ==================== JSON HELPERS ====================
const ALLOWED_TABLES = new Set([
  'machines', 'transactions', 'audit_log',
  'equipment_config', 'inventory_config',
  'ops_orders', 'ops_customers', 'ops_production',
  'tech_support', 'group_transfers',
]);

function validateTable(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`);
  return table;
}

async function readJSONArray(table, limit) {
  try {
    validateTable(table);
    let sql = `SELECT data FROM ${table} ORDER BY id DESC`;
    const effectiveLimit = limit ? parseInt(limit) : 500;
    sql += ` LIMIT ${Math.min(effectiveLimit, 50000)}`;
    const [rows] = await pool.execute(sql);
    return rows.map(r => JSON.parse(r.data)).reverse();
  } catch(e) {
    console.error('[DB] readJSONArray error:', table, e.message);
    return [];
  }
}

async function readJSONById(table, id) {
  validateTable(table);
  const [rows] = await pool.execute(`SELECT data FROM ${table} WHERE id = ?`, [id]);
  return rows.length > 0 ? JSON.parse(rows[0].data) : null;
}

async function saveJSON(table, id, obj) {
  validateTable(table);
  await pool.execute(`REPLACE INTO ${table} (id, data) VALUES (?, ?)`, [id, JSON.stringify(obj)]);
}

// ---- 热路径优化：双写函数，JSON data（真理源）+ 冗余列（索引镜像）同步 ----
// 不改 saveJSON 本身（避免影响其他表）；仅 machines/machine_bindings 用这两个
// conn 可选：传入则参与调用方事务，保证机器记录与 SN/库存/交易写入原子化。
async function saveMachine(id, obj, conn) {
  const db = conn || pool;
  await db.execute(
    `INSERT INTO machines (id, data, machineNumber, status, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       data = VALUES(data), machineNumber = VALUES(machineNumber),
       status = VALUES(status), updatedAt = VALUES(updatedAt)`,
    [id, JSON.stringify(obj), obj.machineNumber || null, obj.status || null, obj.updatedAt || null]
  );
}

async function saveMachineBinding(id, obj, conn) {
  const db = conn || pool;
  await db.execute(
    `INSERT INTO machine_bindings (id, data, machineNumber, userId, unboundAt)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       data = VALUES(data), machineNumber = VALUES(machineNumber),
       userId = VALUES(userId), unboundAt = VALUES(unboundAt)`,
    [id, JSON.stringify(obj), obj.machineNumber || null, obj.userId || null, obj.unboundAt || null]
  );
}

// ---- ITSM 升级：tech_support 双写函数（JSON data 真理源 + 9 冗余列索引镜像）----
// 模式同 saveMachine。saveTechSupport 是 tech_support 表的唯一写入入口，
// 替代原 tech-support.js 中所有 `REPLACE INTO tech_support (id, data)`。
// conn 可选：传入则参与调用方事务。
async function saveTechSupport(id, obj, conn) {
  const db = conn || pool;
  await db.execute(
    `INSERT INTO tech_support (id, data, status_v2, priority, category, assignee_id, submitter_id, machine_no, submitted_ts, sla_respond_by, sla_resolve_by, sla_breached)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       data = VALUES(data), status_v2 = VALUES(status_v2), priority = VALUES(priority),
       category = VALUES(category), assignee_id = VALUES(assignee_id), submitter_id = VALUES(submitter_id),
       machine_no = VALUES(machine_no), submitted_ts = VALUES(submitted_ts),
       sla_respond_by = VALUES(sla_respond_by), sla_resolve_by = VALUES(sla_resolve_by),
       sla_breached = VALUES(sla_breached)`,
    [
      id, JSON.stringify(obj),
      obj.status || null,                         // 新枚举 open/assigned/in_progress/resolved/closed/reopened
      obj.priority || null,
      obj.category || null,
      obj.assigneeId || null,
      obj.submitterId || null,
      obj.machineNumber || null,
      obj.submittedAt || null,
      obj.slaRespondBy || null,
      obj.slaResolveBy || null,
      obj.slaBreached ? 1 : 0,
    ]
  );
}

async function deleteJSON(table, id) {
  validateTable(table);
  await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

async function readJSONObject(table) {
  const [rows] = await pool.execute(`SELECT skey, value FROM ${table}`);
  const obj = {};
  rows.forEach(r => { try { obj[r.skey] = JSON.parse(r.value); } catch { obj[r.skey] = r.value; } });
  return obj;
}

// Phase B: 单 skey 读写辅助（供 tech-support SLA 配置使用，避免每次全表 readJSONObject）
async function getSetting(skey) {
  const [rows] = await pool.execute('SELECT value FROM settings WHERE skey = ?', [skey]);
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
}
async function saveSetting(skey, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [skey, v]);
}

// ==================== ROUTER HELPERS ====================
// S2: CORS tightening — only emit Access-Control-Allow-Origin when CORS_ORIGIN is
// configured. Default (unset) = same-origin only (most secure; web frontend is same-origin).
// Set CORS_ORIGIN=* to restore the old permissive behavior, or a specific origin for trusted partners.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
function corsHeadersObj() {
  if (!CORS_ORIGIN) return {}; // same-origin: omit ACAO entirely
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Vary': 'Origin',
    'Access-Control-Allow-Credentials': 'true',
  };
}
// S2: request body size grading — /api/upload allows 150MB (image attachments),
// all other routes limited to 1MB to cap memory usage and reject oversized payloads.
const BODY_LIMIT_DEFAULT = 1 * 1024 * 1024;        // 1MB
const BODY_LIMIT_UPLOAD = 150 * 1024 * 1024;        // 150MB (uploads only)
function parseBody(req, maxBytes) {
  const MAX = maxBytes || BODY_LIMIT_DEFAULT;
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { req.destroy(); resolve({}); }, 120000);
    req.on('data', c => {
      size += c.length;
      if (size > MAX) { clearTimeout(timer); req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      try {
        // S3.7: strip __proto__/constructor/prototype recursively to prevent
        // prototype pollution when this object is later spread/merged into others.
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        resolve(_sanitize(parsed));
      } catch { resolve({}); }
    });
    req.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}

function sendJSON(res, data, status = 200, req, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data), 'utf-8');
  const accept = (req && req.headers && req.headers['accept-encoding']) || '';
  const useGzip = accept.includes('gzip') && body.length > 1024;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeadersObj(),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    ...extraHeaders,
  };
  // S1+S7: apply security headers. In nonce mode, generate a per-request nonce
  // so CSP headers stay consistent across HTML and JSON responses.
  const nonce = isNonceMode() ? generateNonce() : null;
  applySecurityHeaders(res, { nonce, coop: isHttps(req) });
  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body));
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) cookies[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
  });
  return cookies;
}

async function requireAuth(req, res, allowQueryToken = false) {
  let token = null;
  // 1. Try Bearer header first (mobile/legacy primary auth method)
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7).trim();
    // S5.1: defend against 'Bearer null'/'Bearer undefined' (from `Bearer ' + API.token`
    // when API.token is null). Without this, 'null' is a truthy string → cookie fallback
    // skipped → 401. Treat these as "no Bearer token" and fall through to cookie.
    if (token === 'null' || token === 'undefined' || token === '') token = null;
    // S5.7: optional Bearer-usage logging (monitor mobile vs unexpected web Bearer)
    if (token && process.env.LOG_BEARER_USAGE === 'true') {
      console.log('[AUTH] Bearer used', { ip: getClientIp ? getClientIp(req) : null, path: req.url });
    }
  }
  // 2. Fall back to cookie (S5: web primary auth path — HttpOnly gms_token cookie)
  if (!token && req.headers['cookie']) {
    const cookies = parseCookies(req.headers['cookie']);
    // Mobile has an isolated cookie so desktop login/logout cannot invalidate
    // the operations mobile session.
    token = cookies.gms_mobile_token || cookies.gms_token || null;
  }
  // EventSource cannot set Authorization headers on mobile, so only the SSE
  // endpoint may opt into a query token as a legacy/mobile compatibility path.
  if (!token && allowQueryToken) {
    const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (queryToken) token = queryToken;
  }
  if (!token) { sendJSON(res, { error: '未登录' }, 401); return null; }
  const user = await validateToken(token);
  if (!user) { sendJSON(res, { error: '登录已过期' }, 401); return null; }
  return user;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.apk': 'application/vnd.android.package-archive',
};

// ==================== REQUEST GUARD (S8) — 防爬取/防攻击 ====================
// 前置安全网关：在路由分发前拦截恶意/敏感请求。
// 优先级：robots.txt > 目录穿越/敏感路径拒绝 > 静态文件白名单。
// 说明：API 请求（/api/*）完全放行 — 由 CSRF+授权+限流保护；本网关注重防线
// 公共静态资源越权读取（源码 / data / 备份泄露）与爬虫抓取。

// 允许匿名访问的前端静态资源目录（禁止 src/lib/data/backups 等被直接下载）
const PUBLIC_STATIC_DIRS = ['/css/', '/js/', '/icons/', '/uploads/', '/apk/', '/apk-output/', '/assets/'];

// 根目录允许的 HTML 页面（白名单）
const ALLOWED_ROOT_PAGES = ['index.html', 'mobile.html', 'mobile-ops.html', 'operations.html', 'sn-status.html', 'machine-status.html'];

// 敏感文件/目录黑名单（命中即 404，避免信息泄露）
const FORBIDDEN_PATH_RE = new RegExp(
  '(^|/)(\\.env(\\.|$)|data/|src/|lib/|backups/|docs/|tests/|tools/|node_modules/|\\.git(/|$)|' +
  'package(\\.json|-lock\\.json)|server\\.js|server\\.log|Dockerfile|docker-compose[^/]*\\.ya?ml|' +
  'ecosystem\\.config\\.js|realtime\\.js|feishu\\.js|electron\\.js|tokens\\.json|' +
  '.*\\.apk-build.*)', 'i');

// 根目录允许的非 HTML 静态文件（PWA manifest、service worker、APK 安装包等）
const ALLOWED_ROOT_FILES = ['manifest.json', 'sw.js', 'gms.apk', 'GMS-手套管理app.apk'];

function blockForbidden(req, res) {
  try {
    applySecurityHeaders(res, { coop: isHttps(req) });
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
  } catch {}
  return true; // 已处理
}

/**
 * 请求安全网关。返回 true 表示已处理响应（应停止后续处理）；false 放行。
 */
function requestGuard(req, res) {
  const pathname = (req.url || '').split('?')[0];

  // 1) robots.txt — 明确禁止搜索引擎/爬虫收录
  if (pathname === '/robots.txt' && req.method === 'GET') {
    applySecurityHeaders(res, { coop: isHttps(req) });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end('User-agent: *\nDisallow: /\n');
  }

  // 2) 目录穿越攻击（双保险：+ serveStatic 的 startsWith 二次校验）
  if (/\.\.\//.test(pathname) || /\.\.\\/.test(pathname) || /%2e%2e/i.test(pathname)) {
    return blockForbidden(req, res);
  }

  // 3) 爬虫库 UA 黑名单（仅拦截程序化爬虫，对 curl/wget/浏览器放行；API 不受影响）
  if (!pathname.startsWith('/api/')) {
    const ua = req.headers['user-agent'] || '';
    const botUa = /python-requests|scrapy|aiohttp|httpx|Go-http-client\/|okhttp|libwww-perl|java\/[0-9]|python-urllib|curl\s*\(|wget\s*\(/i;
    if (botUa.test(ua)) {
      // 爬虫无登录凭证 → 同样 404（不暴露任何资源）
      return blockForbidden(req, res);
    }
  }

  // 4) 敏感文件/目录黑名单（非 API 请求命中即 404）
  if (!pathname.startsWith('/api/') && FORBIDDEN_PATH_RE.test(pathname)) {
    return blockForbidden(req, res);
  }

  // 4) 静态文件白名单：仅允许公开目录 + 根目录指定 HTML + 指定根文件
  const ext = path.extname(pathname);
  const hasMime = !!MIME_TYPES[ext];
  const isPublicDir = PUBLIC_STATIC_DIRS.some(d => pathname.startsWith(d));
  const fileName = pathname.split('/').pop();
  const isAllowedRootPage = ALLOWED_ROOT_PAGES.includes(fileName) || ALLOWED_ROOT_FILES.includes(fileName);
  if (hasMime && !pathname.startsWith('/api/') && !isPublicDir && !isAllowedRootPage) {
    // 根目录非白名单文件（如 /server.js、/package.json、/web/config.js 等）→ 404
    if (pathname !== '/' && !pathname.endsWith('.html')) {
      return blockForbidden(req, res);
    }
  }

  return false; // 放行
}

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  // 根路径：移动端 UA → 重定向 mobile.html；PC 浏览器 → 桌面版 index.html。
  // （index.html 内联脚本在部分环境被 JS/localStorage 限制时会失效，移动端走服务端重定向最稳妥）
  if (filePath === '/') {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua);
    if (isMobile) {
      applySecurityHeaders(res, { coop: isHttps(req) });
      res.writeHead(302, { 'Location': '/mobile.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    filePath = '/index.html';
  }
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) return false;
  const ext = path.extname(filePath);
  if (!MIME_TYPES[ext]) return false;
  try {
    // Use memory cache for static assets (1h TTL)
    const cached = getStaticFile(filePath, MIME_TYPES[ext], filePath);
    if (!cached) return false;

    // S7: For HTML files in nonce mode, generate a per-request nonce and
    // inject a <meta name="csp-nonce"> tag so inline scripts can read it.
    // The nonce is also passed to applySecurityHeaders for the CSP header.
    let nonce = null;
    let responseData = cached.data;
    if ((ext === '.html') && isNonceMode()) {
      nonce = generateNonce();
      // Inject CSP nonce meta tag into HTML head
      const htmlStr = cached.data.toString('utf-8');
      const metaTag = `<meta name="csp-nonce" content="${nonce}">`;
      const modifiedHtml = htmlStr.replace(/<head([^>]*)>/i, `<head$1>${metaTag}`);
      responseData = Buffer.from(modifiedHtml, 'utf-8');
    }

    const headers = {
      'Content-Type': cached.contentType,
      // HTML/JS/CSS verze-bumped ?v= query strings take effect immediately:
      // never re-use stale browser/SW caches so updates always propagate.
      // Images/fonts may still cache briefly.
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css' ||
                        ext === '.json' || ext === '.svg')
        ? 'no-cache'
        : 'public, max-age=600',
      'ETag': `"${  cached.ts.toString(36)  }"`,
    };
    // S1+S7: apply security headers to static responses too (covers HTML/JS/CSS)
    applySecurityHeaders(res, { nonce, coop: isHttps(req) });
    // Don't use gzip for HTML with nonce injection — the cached gzipped data
    // doesn't contain the nonce meta tag, and re-gzipping per-request is costly.
    const accept = req.headers['accept-encoding'] || '';
    const useGzip = (ext !== '.html') && accept.includes('gzip') && cached.gzipped && cached.gzipped.length < cached.data.length;
    if (useGzip) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(cached.gzipped);
    } else {
      res.writeHead(200, headers);
      res.end(responseData);
    }
    return true;
  } catch(e) { console.error('[serveStatic] Error:', e.message); return false; }
}

// ==================== API HANDLERS ====================

// -- Auth handlers extracted to src/handlers/auth.js (Phase 2.1) --
// handleLogin / handleMobileAuth / handleTokenVerify / handleLogout /
// handleBeaconLogout / handleChangePassword / handleResetPassword /
// handleGetUserPassword → called via auth.handleXxx(...) (factory-injected deps).

// (machines handlers — handleGetMachineCode / handleMobileGetMachines /
//  handleGetMachines / handleAddMachine / handleDeleteMachine /
//  handleBindMachine / handleUnbindMachine / handleGetMachineBindings /
//  handleSyncMachineState — extracted to src/handlers/machines.js (Phase 2.1 step5).
//  Also extracted: unbindGlovesFromMachine helper. saveMachine / saveMachineBinding
//  kept here (used by migrations) and passed as deps to the factory.)

// (users handlers — handleForceLogout / handleGetUsers / handleAddUser /
//  handleDeleteUser — extracted to src/handlers/users.js)

// (users handlers — handleUpdateUser / handleGetOnlineUsers /
//  handleGetSubordinates / handlePromoteUser / handleToggleUserStatus —
//  extracted to src/handlers/users.js)

// (tech-support handlers and helpers — handleGetTechSupportList / handleGetTechSupportDetail /
//  handleGetRepairResults / handleSubmitTechSupport / handleRespondTechSupport /
//  handleCompleteTechSupport / handleDeleteTechSupport / handleExportTechSupportXLSX +
//  _recomputeMachineStatusFromGloves / _updateMachineStatusByNumber —
//  extracted to src/handlers/tech-support.js)


// _updateMachineStatusInTxn (in-txn machine-status cascade for handleSNStatusChange)
// extracted to src/handlers/sn-registry.js (Phase 2.1 step6).

// ==================== SHIFT INSPECTION (班次首检) ====================
// 班次定义：morning 早班 08:00-17:00，night 晚班 17:00-次日02:00
function getCurrentShiftInfo(now = new Date()) {
  const h = now.getHours();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const today = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const yesterday = new Date(y, m, d - 1);
  const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  // 当前活跃班次：早班 08-17，晚班 17-次日02（02点前归属当日晚班，次日02-08为休息期）
  let current = 'morning';
  if (h >= 8 && h < 17) current = 'morning';
  else if (h >= 17 || h < 2) current = 'night';
  else current = 'none'; // 02:00-08:00 无活跃班次
  return { current, today, yesterday: yStr, hour: h };
}

async function handleSaveShiftInspection(req, res, authUser, machineCode, body) {
  try {
    // 保存成功后清除今日首检总览缓存，避免用户提交后仍需等待 TTL 过期
    const invalidateTodayCache = async () => {
      const _t = getCurrentShiftInfo().today;
      await _redisDel(`todayShift:${_t}:morning`);
      await _redisDel(`todayShift:${_t}:night`);
    };
    if (!machineCode) return sendJSON(res, { error: '机器编号不能为空' }, 400);
    const checklist = (body && typeof body.checklist === 'object' && body.checklist) ? body.checklist : {};
    const note = (body && body.note != null) ? String(body.note) : '';
    // 班次：morning / night；状态：in_progress(首检中) / completed(已完成)
    // 若前端未提供 shift，则根据服务器当前时间自动判断班次（避免夜班被误记为早班）
    let shift;
    if (body && typeof body.shift === 'string') {
      shift = body.shift === 'night' ? 'night' : 'morning';
    } else {
      const info = getCurrentShiftInfo();
      // 02:00-08:00 休息期无活跃班次，禁止提交首检
      if (info.current === 'none') {
        return sendJSON(res, { error: '当前为休息时段（02:00-08:00），无法提交首检' }, 400);
      }
      shift = info.current === 'night' ? 'night' : 'morning';
    }
    const status = (body && body.status === 'in_progress') ? 'in_progress' : 'completed';

    const recordId = (body && body.recordId) ? String(body.recordId).trim() : '';
    if (recordId) {
      // 更新已有记录（完成首检时更新 checklist/status/note）
      const operator = authUser ? (authUser.username || authUser.displayName || '') : '';
      const operatorName = authUser ? (authUser.displayName || authUser.username || '') : '';
      const operatorId = authUser ? (authUser.userId || authUser.id || '') : '';
      if (status === 'completed') {
        // 仅 completed 时更新 checklist 和 note；in_progress 阶段直接放行
        await pool.execute(
          'UPDATE shift_inspections SET status=?, checklist=?, note=?, operator=?, operatorName=?, operatorId=?, operatorEmpId=? WHERE id=?',
          [status, JSON.stringify(checklist), note, operator, operatorName, operatorId, operator, recordId]
        );
      }
      await invalidateTodayCache();
      sendJSON(res, { success: true, id: recordId });
    } else {
      // 新建记录
      const id = `si-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date();

      // 解析机器信息（machineNumber / deviceType），机器不存在也允许记录
      let machineNumber = machineCode;
      let deviceType = '';
      try {
        const [mRows] = await pool.execute(
          'SELECT data FROM machines WHERE machineNumber = ? ORDER BY updatedAt DESC, id DESC LIMIT 1',
          [machineCode]
        );
        if (mRows.length > 0) {
          const m = JSON.parse(mRows[0].data);
          if (m.machineNumber) machineNumber = m.machineNumber;
          deviceType = m.deviceType || '';
        }
      } catch (e) {}

      const operator = authUser ? (authUser.username || authUser.displayName || '') : '';
      const operatorName = authUser ? (authUser.displayName || authUser.username || '') : '';
      const operatorEmp = '';
      await pool.execute(
        'INSERT INTO shift_inspections (id, machineCode, machineNumber, deviceType, checklist, operator, note, createdAt, shift, status, operatorId, operatorName, operatorEmpId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, machineCode, machineNumber, deviceType, JSON.stringify(checklist), operator, note, createdAt, shift, status,
         authUser ? (authUser.userId || authUser.id || '') : '', operatorName, operator]
      );
      await invalidateTodayCache();
      sendJSON(res, { success: true, id });
    }
  } catch (e) {
    console.error('[ShiftInspection] Save error:', e.message);
    sendJSON(res, { error: '保存失败' }, 500);
  }
}

async function handleGetShiftInspections(req, res, authUser, machineCode) {
  try {
    if (!machineCode) return sendJSON(res, { error: '机器编号不能为空' }, 400);
    const [rows] = await pool.execute(
      `SELECT * FROM shift_inspections
       WHERE machineCode = ? AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY createdAt DESC LIMIT 100`,
      [machineCode]
    );
    // 去重：同一班次+日期只保留最新一条（避免残留 in_progress 与 completed 重复；
    // 不同日期/班次的完整历史记录都会保留）
    const seen = {};
    const deduped = [];
    for (const r of rows) {
      const dateKey = r.createdAt ? r.createdAt.toISOString().slice(0, 10) : '';
      const key = (r.shift || 'morning') + '|' + dateKey;
      if (!seen[key]) {
        seen[key] = true;
        deduped.push(r);
      }
    }
    const list = deduped.map(r => {
      let checklist = {};
      try { checklist = typeof r.checklist === 'string' ? JSON.parse(r.checklist) : (r.checklist || {}); } catch {}
      return {
        id: r.id,
        machineCode: r.machineCode,
        machineNumber: r.machineNumber,
        deviceType: r.deviceType,
        checklist,
        operator: r.operator,
        note: r.note,
        shift: r.shift || 'morning',
        status: r.status || 'completed',
        operatorName: r.operatorName || r.operator || '',
        operatorEmpId: r.operatorEmpId || r.operator || '',
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      };
    });
    sendJSON(res, { success: true, list });
  } catch (e) {
    console.error('[ShiftInspection] List error:', e.message);
    sendJSON(res, { error: '查询失败' }, 500);
  }
}

// ==================== 发货单（Delivery Notes） ====================
async function handleSaveDeliveryNote(req, res, authUser, body) {
  try {
    body = body || {};
    const type = body.type === 'replacement' ? 'replacement' : 'repair';
    const items = Array.isArray(body.items) ? body.items : [];
    const trackingNumber = (body.trackingNumber || '').trim();
    const company = (body.company || '万达智慧手套').trim();
    const manufacturer = (body.manufacturer || '').trim();
    const note = (body.note || '').trim();
    const operator = authUser ? (authUser.username || '') : '';
    const operatorName = authUser ? (authUser.displayName || authUser.username || '') : '';
    const id = `dn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    await pool.execute(
      'INSERT INTO delivery_notes (id, type, items, trackingNumber, operator, operatorName, company, manufacturer, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, type, JSON.stringify(items), trackingNumber, operator, operatorName, company, manufacturer, note, createdAt]
    );
    sendJSON(res, { success: true, id });
  } catch (e) {
    console.error('[DeliveryNote] Save error:', e.message);
    sendJSON(res, { error: '保存失败' }, 500);
  }
}
async function handleListDeliveryNotes(req, res, authUser) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM delivery_notes ORDER BY createdAt DESC LIMIT 200'
    );
    const list = rows.map(r => ({
      id: r.id, type: r.type,
      items: (() => { try { return typeof r.items === 'string' ? JSON.parse(r.items) : (r.items || []); } catch { return []; } })(),
      trackingNumber: r.trackingNumber || '',
      operator: r.operator || '',
      operatorName: r.operatorName || '',
      company: r.company || '万达智慧手套',
      manufacturer: r.manufacturer || '',
      note: r.note || '',
      createdAt: r.createdAt || '',
    }));
    sendJSON(res, { success: true, list });
  } catch (e) {
    console.error('[DeliveryNote] List error:', e.message);
    sendJSON(res, { error: '查询失败' }, 500);
  }
}
async function handleGetDeliveryNote(req, res, authUser, id) {
  try {
    if (!id) return sendJSON(res, { error: 'id 不能为空' }, 400);
    const [rows] = await pool.execute('SELECT * FROM delivery_notes WHERE id = ?', [id]);
    if (!rows.length) return sendJSON(res, { error: '未找到' }, 404);
    const r = rows[0];
    sendJSON(res, {
      success: true, note: {
        id: r.id, type: r.type,
        items: (() => { try { return typeof r.items === 'string' ? JSON.parse(r.items) : (r.items || []); } catch { return []; } })(),
        trackingNumber: r.trackingNumber || '',
        operator: r.operator || '',
        operatorName: r.operatorName || '',
        company: r.company || '万达智慧手套',
        manufacturer: r.manufacturer || '',
        note: r.note || '',
        createdAt: r.createdAt || '',
      }
    });
  } catch (e) {
    console.error('[DeliveryNote] Get error:', e.message);
    sendJSON(res, { error: '查询失败' }, 500);
  }
}
async function handleUpdateDeliveryNote(req, res, authUser, id, body) {
  try {
    if (!id) return sendJSON(res, { error: 'id 不能为空' }, 400);
    const items = Array.isArray(body?.items) ? body.items : [];
    const trackingNumber = (body?.trackingNumber || '').trim();
    const company = (body?.company || '万达智慧手套').trim();
    const manufacturer = (body?.manufacturer || '').trim();
    const note = (body?.note || '').trim();
    const [result] = await pool.execute(
      'UPDATE delivery_notes SET items = ?, trackingNumber = ?, company = ?, manufacturer = ?, note = ? WHERE id = ?',
      [JSON.stringify(items), trackingNumber, company, manufacturer, note, id]
    );
    if (!result.affectedRows) return sendJSON(res, { error: '未找到发货单' }, 404);
    sendJSON(res, { success: true });
  } catch (e) {
    console.error('[DeliveryNote] Update error:', e.message);
    sendJSON(res, { error: '更新失败' }, 500);
  }
}

async function handleDeleteDeliveryNote(req, res, authUser, id) {
  try {
    if (!id) return sendJSON(res, { error: 'id 不能为空' }, 400);
    await pool.execute('DELETE FROM delivery_notes WHERE id = ?', [id]);
    sendJSON(res, { success: true });
  } catch (e) {
    console.error('[DeliveryNote] Delete error:', e.message);
    sendJSON(res, { error: '删除失败' }, 500);
  }
}

// 今日首检总览：返回所有机器 + 各机器今日早/晚班首检状态
async function handleTodayShiftInspections(req, res, authUser) {
  try {
    // 先获取当前班次信息，避免多次调用 getCurrentShiftInfo() 在边界处产生不一致
    const info = getCurrentShiftInfo();
    // 热点缓存：按"天+班次"键缓存 30s，避免同一分钟多次重复全表扫描
    const cacheKey = `todayShift:${info.today}:${info.current}`;
    const cached = await _redisGet(cacheKey);
    if (cached) {
      sendJSON(res, cached);
      return;
    }
    const [mRows] = await pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 5000');
    const all = mRows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
    all.sort((a, b) => new Date(b.updatedAt || b.id) - new Date(a.updatedAt || a.id));
    const latest = new Map();
    for (const m of all) {
      const num = m.machineNumber;
      if (!num) continue;
      if (!latest.has(num)) latest.set(num, m);
    }
    // 有效状态由手套绑定推算（与 /api/mobile/machines、机器状态链接页同一规则），
    // 不直接用 machines 表静态 status（未绑手套的上线机器会错误显示在线）
    const [snRows] = await pool.execute(
      "SELECT handType, machineNumber FROM sn_registry WHERE status = 'in_use' AND machineNumber IS NOT NULL AND machineNumber != ''"
    );
    const occ = {};
    for (const r of snRows) {
      if (!occ[r.machineNumber]) occ[r.machineNumber] = { left: false, right: false };
      if (r.handType === 'left') occ[r.machineNumber].left = true;
      else if (r.handType === 'right') occ[r.machineNumber].right = true;
    }
    const machines = Array.from(latest.values()).map(m => {
      const o = occ[m.machineNumber];
      let effectiveStatus = 'offline';
      if (o && o.left && o.right) effectiveStatus = 'online';
      else if (o && (o.left || o.right)) effectiveStatus = 'partial';
      if (m.status === 'waiting_repair' || m.status === 'repairing') effectiveStatus = m.status;
      return {
        machineNumber: m.machineNumber,
        deviceType: m.deviceType || '',
        status: effectiveStatus
      };
    });
    machines.sort((a, b) => a.machineNumber.localeCompare(b.machineNumber, 'zh-CN', { numeric: true }));

    // 查询最近两天首检记录（覆盖：早班今日、晚班今日或昨夜晚班）
    const [rows] = await pool.execute(
      `SELECT * FROM shift_inspections WHERE createdAt >= DATE_SUB(CURDATE(), INTERVAL 1 DAY) ORDER BY createdAt DESC`
    );
    const list = rows.map(r => {
      let checklist = {};
      try { checklist = typeof r.checklist === 'string' ? JSON.parse(r.checklist) : (r.checklist || {}); } catch {}
      return {
        id: r.id,
        machineCode: r.machineCode,
        machineNumber: r.machineNumber,
        deviceType: r.deviceType,
        checklist,
        operator: r.operator,
        note: r.note,
        shift: r.shift || 'morning',
        status: r.status || 'completed',
        operatorName: r.operatorName || r.operator || '',
        operatorEmpId: r.operatorEmpId || r.operator || '',
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      };
    });

    // 分组：morning=今日早班，night=今日晚班（17:00后）
    const isSameDate = (iso, dateStr) => { if (!iso) return false; try { return iso.slice(0, 10) === dateStr; } catch { return false; } };
    const bucket = { morning: {}, night: {} };
    for (const it of list) {
      const shift = it.shift === 'night' ? 'night' : 'morning';
      if (shift === 'morning') {
        if (!isSameDate(it.createdAt, info.today)) continue; // 只看今日早班
      } else {
        // 晚班：仅看今日17:00后的记录（属于今日晚班）
        // 不再回显昨夜晚班数据，避免用户误以为今日晚班已完成
        const isToday = isSameDate(it.createdAt, info.today);
        if (!isToday) continue;
        const d = new Date(it.createdAt);
        const h = d.getHours();
        if (h < 17) continue; // 今日0-17点的记录不属于今日晚班
      }
      if (!bucket[shift][it.machineNumber] || new Date(bucket[shift][it.machineNumber].createdAt) < new Date(it.createdAt)) {
        bucket[shift][it.machineNumber] = it;
      }
    }

    const result = machines.map(m => ({
      machineNumber: m.machineNumber,
      deviceType: m.deviceType,
      status: m.status,
      morning: bucket.morning[m.machineNumber] || null,
      night: bucket.night[m.machineNumber] || null
    }));

    const payload = { success: true, shiftInfo: info, machines: result };
    await _redisSet(cacheKey, payload, 30); // 缓存 30 秒，避免高频全表扫描
    sendJSON(res, payload);
  } catch (e) {
    console.error('[ShiftInspection] Today overview error:', e.message);
    sendJSON(res, { error: '查询失败' }, 500);
  }
}

// ==================== POPUP MESSAGES ====================
async function handleGetPopupMessages(req, res, authUser) {
  const url = new URL(req.url, 'http://localhost');
  const category = url.searchParams.get('category') || '';
  let sql = 'SELECT * FROM popup_messages';
  const params = [];
  if (category) { sql += ' WHERE category = ?'; params.push(category); }
  sql += ' ORDER BY createdAt DESC';
  const [rows] = await pool.execute(sql, params);
  sendJSON(res, rows.map(r => ({ id: r.id, category: r.category, text: r.text, createdBy: r.createdBy, createdAt: r.createdAt })));
}

async function handleGetRandomPopupMessage(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const category = url.searchParams.get('category') || 'submit';
  const [rows] = await pool.execute('SELECT text FROM popup_messages WHERE category = ? ORDER BY RAND() LIMIT 1', [category]);
  if (rows.length === 0) {
    // Fallback messages if none in DB
    const fallbacks = {
      submit: '提交成功！运维人员正在赶来！',
      complete: '维修完成！辛苦了！',
    };
    return sendJSON(res, { text: fallbacks[category] || '操作成功！' });
  }
  sendJSON(res, { text: rows[0].text });
}

async function handleAddPopupMessage(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅管理员可管理弹窗句子' }, 403);
  }
  const { category, text } = body;
  if (!category || !text || !text.trim()) {
    return sendJSON(res, { error: '分类和内容不能为空' }, 400);
  }
  if (!['submit', 'complete'].includes(category)) {
    return sendJSON(res, { error: '无效的分类，可选值：submit, complete' }, 400);
  }
  const id = `pm-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
  await pool.execute('INSERT INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
    [id, category, text.trim(), authUser.userId, new Date().toISOString()]);
  sendJSON(res, { success: true, id });
}

async function handleDeletePopupMessage(req, res, authUser, id) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅管理员可管理弹窗句子' }, 403);
  }
  await pool.execute('DELETE FROM popup_messages WHERE id = ?', [id]);
  sendJSON(res, { success: true });
}

// ==================== GROUP TRANSFERS ====================
// Group leader (admin with system='operations') can transfer members between groups
// Both leaders must approve for the transfer to take effect

async function handleCreateGroupTransfer(req, res, authUser, body) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可发起调配' }, 403);
  }
  const { toAdminId, userId, username, direction, reason } = body;
  if (!toAdminId || !userId || !direction) {
    return sendJSON(res, { error: '缺少必要参数: toAdminId, userId, direction' }, 400);
  }
  if (direction !== 'out' && direction !== 'in') {
    return sendJSON(res, { error: 'direction必须为 out 或 in' }, 400);
  }

  // Verify the other admin exists
  const [adminRows] = await pool.execute(
    'SELECT id, username FROM users WHERE id = ? AND (role = ? OR role = ?)',
    [toAdminId, 'admin', 'superadmin']
  );
  if (adminRows.length === 0) return sendJSON(res, { error: '目标组长不存在或不是管理员' }, 404);

  // Verify the user exists
  const [userRows] = await pool.execute('SELECT id, username, parentId FROM users WHERE id = ?', [userId]);
  if (userRows.length === 0) return sendJSON(res, { error: '被调配用户不存在' }, 404);

  const id = `gt-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const item = {
    id,
    fromAdminId: authUser.userId,
    fromAdminName: authUser.username,
    toAdminId: adminRows[0].id,
    toAdminName: adminRows[0].username,
    userId: userRows[0].id,
    username: userRows[0].username,
    direction,
    status: 'pending',
    reason: reason || '',
    createdAt: now,
    updatedAt: now,
  };

  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [id, JSON.stringify(item)]);
  broadcastSSE('group_transfer_updated', { action: 'created', id });
  sendJSON(res, { success: true, item });
}

async function handleApproveGroupTransfer(req, res, authUser, transferId) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    console.log(`[GROUP_TRANSFER][APPROVE][DENY] user=${authUser.userId}(${authUser.username}) role=${authUser.role} transferId=${transferId} — 非组长，拒绝`);
    return sendJSON(res, { error: '仅组长可审批调配' }, 403);
  }
  console.log(`[GROUP_TRANSFER][APPROVE][START] approver=${authUser.userId}(${authUser.username}) transferId=${transferId}`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT data FROM group_transfers WHERE id = ? FOR UPDATE', [transferId]);
    if (rows.length === 0) {
      console.log(`[GROUP_TRANSFER][APPROVE][404] transferId=${transferId} — 调配请求不存在`);
      await conn.rollback(); conn.release(); return sendJSON(res, { error: '调配请求不存在' }, 404);
    }
    const item = JSON.parse(rows[0].data);
    console.log(`[GROUP_TRANSFER][APPROVE][LOAD] transferId=${transferId} direction=${item.direction} status=${item.status} userId=${item.userId}(${item.username}) fromAdminId=${item.fromAdminId}(${item.fromAdminName}) toAdminId=${item.toAdminId}(${item.toAdminName})`);
    if (item.status !== 'pending') {
      console.log(`[GROUP_TRANSFER][APPROVE][SKIP] transferId=${transferId} 当前状态=${item.status}（非pending），拒绝重复审批`);
      await conn.rollback(); conn.release(); return sendJSON(res, { error: '该请求已处理' }, 400);
    }
    if (item.toAdminId !== authUser.userId && item.fromAdminId !== authUser.userId) {
      console.log(`[GROUP_TRANSFER][APPROVE][403] transferId=${transferId} approver=${authUser.userId} 不是相关组长（from=${item.fromAdminId} to=${item.toAdminId}），无权审批`);
      await conn.rollback(); conn.release(); return sendJSON(res, { error: '您不是该调配的相关组长，无权审批' }, 403);
    }
    // Direction-aware target resolution (independent of who approves):
    //   'out' (push out): member moves from initiator (fromAdminId) → target (toAdminId)
    //   'in'  (pull in):  member moves from target (toAdminId) → initiator (fromAdminId)
    // The previous logic used isSender ? toAdminId : fromAdminId, which broke
    // the 'out' direction: when the receiver approved, the member was moved back
    // to the sender (where it already was) instead of to the destination.
    const newParentId = item.direction === 'out' ? item.toAdminId : item.fromAdminId;
    const isSenderApproving = (item.fromAdminId === authUser.userId);
    // Read old parentId before update for audit trail
    const [oldRows] = await conn.execute('SELECT parentId FROM users WHERE id = ?', [item.userId]);
    const oldParentId = oldRows.length > 0 ? oldRows[0].parentId : '(unknown)';
    console.log(`[GROUP_TRANSFER][APPROVE][MOVE] transferId=${transferId} direction=${item.direction} approverIsSender=${isSenderApproving} oldParentId=${oldParentId} → newParentId=${newParentId}（${item.direction === 'out' ? '调出:目标=toAdminId' : '调入:目标=fromAdminId'}）`);
    const [updResult] = await conn.execute('UPDATE users SET parentId = ? WHERE id = ?', [newParentId, item.userId]);
    console.log(`[GROUP_TRANSFER][APPROVE][UPDATE] transferId=${transferId} userId=${item.userId} affectedRows=${updResult.affectedRows}`);
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    await conn.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
    await conn.commit();
    console.log(`[GROUP_TRANSFER][APPROVE][OK] transferId=${transferId} 组员 ${item.username} 已从 ${oldParentId} 转至 ${newParentId}，状态=completed`);
    broadcastChange('group_transfer', ['users'], { action: 'approved', id: transferId });
    sendJSON(res, { success: true, item });
  } catch (e) {
    await conn.rollback();
    console.log(`[GROUP_TRANSFER][APPROVE][ERR] transferId=${transferId} error=${e.message} stack=${e.stack}`);
    sendJSON(res, { error: `审批失败: ${  e.message}` }, 500);
  } finally {
    conn.release();
  }
}

async function handleRejectGroupTransfer(req, res, authUser, transferId) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    console.log(`[GROUP_TRANSFER][REJECT][DENY] user=${authUser.userId}(${authUser.username}) role=${authUser.role} transferId=${transferId} — 非组长，拒绝`);
    return sendJSON(res, { error: '仅组长可拒绝调配' }, 403);
  }
  console.log(`[GROUP_TRANSFER][REJECT][START] rejecter=${authUser.userId}(${authUser.username}) transferId=${transferId}`);
  const [rows] = await pool.execute('SELECT data FROM group_transfers WHERE id = ?', [transferId]);
  if (rows.length === 0) {
    console.log(`[GROUP_TRANSFER][REJECT][404] transferId=${transferId} — 调配请求不存在`);
    return sendJSON(res, { error: '调配请求不存在' }, 404);
  }
  const item = JSON.parse(rows[0].data);
  console.log(`[GROUP_TRANSFER][REJECT][LOAD] transferId=${transferId} direction=${item.direction} status=${item.status} userId=${item.userId}(${item.username}) fromAdminId=${item.fromAdminId}(${item.fromAdminName}) toAdminId=${item.toAdminId}(${item.toAdminName})`);
  if (item.status !== 'pending') {
    console.log(`[GROUP_TRANSFER][REJECT][SKIP] transferId=${transferId} 当前状态=${item.status}（非pending），拒绝重复操作`);
    return sendJSON(res, { error: '该请求已处理' }, 400);
  }
  if (item.toAdminId !== authUser.userId && item.fromAdminId !== authUser.userId) {
    console.log(`[GROUP_TRANSFER][REJECT][403] transferId=${transferId} rejecter=${authUser.userId} 不是相关组长（from=${item.fromAdminId} to=${item.toAdminId}），无权拒绝`);
    return sendJSON(res, { error: '您不是该调配的相关组长，无权拒绝' }, 403);
  }
  item.status = 'rejected';
  item.rejectedBy = authUser.userId;
  item.rejectedByName = authUser.username;
  item.updatedAt = new Date().toISOString();
  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
  console.log(`[GROUP_TRANSFER][REJECT][OK] transferId=${transferId} 组员 ${item.username} 调配被 ${authUser.username} 拒绝，状态=rejected`);
  broadcastSSE('group_transfer_updated', { action: 'rejected', id: transferId });
  sendJSON(res, { success: true, item });
}

async function handleCancelGroupTransfer(req, res, authUser, transferId) {
  const [rows] = await pool.execute('SELECT data FROM group_transfers WHERE id = ?', [transferId]);
  if (rows.length === 0) return sendJSON(res, { error: '调配请求不存在' }, 404);
  const item = JSON.parse(rows[0].data);
  if (item.fromAdminId !== authUser.userId && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '只能取消自己发起的调配' }, 403);
  }
  if (item.status !== 'pending') return sendJSON(res, { error: '只能取消失效的请求' }, 400);
  item.status = 'cancelled';
  item.updatedAt = new Date().toISOString();
  await pool.execute('REPLACE INTO group_transfers (id, data) VALUES (?, ?)', [transferId, JSON.stringify(item)]);
  broadcastSSE('group_transfer_updated', { action: 'cancelled', id: transferId });
  sendJSON(res, { success: true, item });
}

async function handleGetGroupTransfers(req, res, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可查看调配记录' }, 403);
  }
  const [rows] = await pool.execute('SELECT data FROM group_transfers ORDER BY id DESC');
  const all = rows.map(r => JSON.parse(r.data));
  // Filter: show transfers where this admin is involved (as fromAdmin or toAdmin)
  const mine = all.filter(t =>
    t.fromAdminId === authUser.userId || t.toAdminId === authUser.userId
  );
  sendJSON(res, mine);
}

// 获取组员维修统计（运营管理员查看组员详情）
async function handleGetMemberRepairStats(req, res, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅管理员可查看' }, 403);
  }
  const url = new URL(req.url, 'http://localhost');
  const targetUserId = url.searchParams.get('userId');
  if (!targetUserId) return sendJSON(res, { error: '缺少 userId 参数' }, 400);
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';

  try {
    const [rows] = await pool.execute(
      `SELECT id, data FROM tech_support WHERE submitter_id = ? ORDER BY submitted_ts DESC LIMIT 500`,
      [targetUserId]
    );
    const all = rows.map(r => {
      try { return JSON.parse(r.data); } catch(e) { return null; }
    }).filter(Boolean);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    let todayRepairSeconds = 0;
    let todayTechCount = 0;
    let filteredRepairSeconds = 0;
    const filtered = [];

    for (const item of all) {
      const submittedAt = item.submittedAt || '';
      const repairSec = parseInt(item.repairSeconds, 10) || 0;
      const isToday = submittedAt >= todayStart && submittedAt < todayEnd;

      if (isToday) {
        todayTechCount++;
        todayRepairSeconds += repairSec;
      }

      // Date filter: from/to
      let pass = true;
      if (from && submittedAt < from) pass = false;
      if (to && submittedAt > to + 'T23:59:59.999Z') pass = false;

      if (pass) {
        filteredRepairSeconds += repairSec;
        filtered.push({
          id: item.id,
          machineNumber: item.machineNumber || '',
          faultType: item.faultType || '',
          status: item.status || '',
          submittedAt: item.submittedAt || '',
          repairSeconds: repairSec,
          result: item.result || '',
        });
      }
    }

    // 获取用户信息
    const [urows] = await pool.execute('SELECT id, username, displayName FROM users WHERE id = ?', [targetUserId]);
    const userInfo = urows.length > 0 ? urows[0] : { id: targetUserId, username: '未知', displayName: '' };

    sendJSON(res, {
      userId: targetUserId,
      userName: userInfo.displayName || userInfo.username,
      todayRepairSeconds,
      filteredRepairSeconds,
      todayTechCount,
      history: filtered.slice(0, 100),
    });
  } catch(e) {
    console.error('[MemberRepairStats] error:', e.message);
    sendJSON(res, { error: '查询失败' }, 500);
  }
}

async function handleGetGroupMembers(req, res, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'superadmin') {
    return sendJSON(res, { error: '仅组长可查看组员' }, 403);
  }
  // System isolation: admins only see same-system users; superadmin sees all
  let systemFilter = '';
  const params = [];
  if (authUser.role !== 'superadmin') {
    systemFilter = 'AND `system` = ?';
    params.push(authUser.system || 'maintenance');
  }
  const [users] = await pool.execute(
    `SELECT id, username, displayName, role, \`system\`, parentId, createdBy, createdAt
     FROM users WHERE role = 'user' ${systemFilter} ORDER BY username`, params
  );
  // Group by parentId
  const groups = {};
  users.forEach(u => {
    const parent = u.parentId || u.createdBy || 'unknown';
    if (!groups[parent]) groups[parent] = { adminId: parent, members: [] };
    groups[parent].members.push(u);
  });
  // Get admin names (only from same system for non-superadmin)
  const adminIds = Object.keys(groups);
  if (adminIds.length > 0) {
    const adminParams = [...adminIds];
    let adminSystemFilter = '';
    if (authUser.role !== 'superadmin') {
      adminSystemFilter = 'AND `system` = ?';
      adminParams.push(authUser.system || 'maintenance');
    }
    const [admins] = await pool.execute(
      `SELECT id, username, displayName FROM users WHERE id IN (${adminIds.map(() => '?').join(',')}) ${adminSystemFilter}`,
      adminParams
    );
    admins.forEach(a => {
      if (groups[a.id]) groups[a.id].adminName = a.displayName || a.username;
    });
    // Remove groups whose admin wasn't found (different system)
    for (const gid of Object.keys(groups)) {
      if (!groups[gid].adminName) delete groups[gid];
    }
  }
  sendJSON(res, Object.values(groups));
}

// (auth handlers — handleLogout / handleBeaconLogout / handleChangePassword /
//  handleResetPassword / handleGetUserPassword — extracted to src/handlers/auth.js)

// -- Weighted Scores --
function calculateScoreFromArrangement(arrangementType) {
  if (arrangementType === 'absent') return 0;
  const weight = parseFloat(arrangementType);
  if (!isNaN(weight) && weight > 0) {
    return Math.round(4 * weight * 100) / 100;
  }
  return 0;
}

async function handleSaveWeightedScore(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const { userId, username, displayName, arrangementType, score: bodyScore, date, isExternal } = body;
  if (!userId || !date) return sendJSON(res, { error: '缺少必要参数' }, 400);
  
  let score;
  let finalArrangementType = arrangementType;
  
  if (bodyScore !== undefined && bodyScore !== null) {
    score = parseFloat(bodyScore);
    if (isNaN(score)) return sendJSON(res, { error: '分数必须是数字' }, 400);
    if (!finalArrangementType) finalArrangementType = 'custom';
  } else if (arrangementType) {
    const validTypes = ['absent', 'custom'];
    const isNumeric = !isNaN(parseFloat(arrangementType)) && isFinite(arrangementType);
    if (!validTypes.includes(arrangementType) && !isNumeric) return sendJSON(res, { error: '无效的安排类型' }, 400);
    score = calculateScoreFromArrangement(arrangementType);
  } else {
    return sendJSON(res, { error: '缺少安排类型或分数' }, 400);
  }
  
  const id = `ws-${  date  }-${  userId}`;
  await pool.execute(
    'REPLACE INTO ops_weighted_scores (id, userId, username, displayName, arrangementType, score, date, createdAt, isExternal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId, username || '', displayName || '', finalArrangementType || '', score, date, new Date().toISOString(), isExternal ? 1 : 0]
  );
  sendJSON(res, { success: true });
}

async function handleGetWeightedRanking(req, res, user) {
  const allowedUsers = ['tianruyu'];
  if (!allowedUsers.includes(user.username)) return sendJSON(res, { error: '无权限访问' }, 403);

  const url = new URL(req.url, 'http://localhost');
  let year = parseInt(url.searchParams.get('year'));
  let month = parseInt(url.searchParams.get('month'));

  if (!year || !month) {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  const [rows] = await pool.execute(
    'SELECT * FROM ops_weighted_scores WHERE date LIKE ? ORDER BY date DESC',
    [`${monthStr}%`]
  );

  const userScores = {};
  rows.forEach(r => {
    if (!userScores[r.userId]) {
      userScores[r.userId] = {
        userId: r.userId,
        username: r.username,
        displayName: r.displayName,
        isExternal: !!r.isExternal,
        totalScore: 0,
        days: 0,
        attendanceDays: 0,
        workDays: 0
      };
    }
    const score = parseFloat(r.score) || 0;
    const attDays = parseFloat(r.attDays) || 0;
    const workDays = parseFloat(r.workDays) || 0;
    userScores[r.userId].totalScore += score;
    userScores[r.userId].days++;
    userScores[r.userId].attendanceDays += attDays;
    userScores[r.userId].workDays += workDays;
  });

  const MIN_ATTENDANCE_DAYS = 18;
  const ranking = Object.values(userScores).map(u => {
    const totalScore = Math.round(u.totalScore * 100) / 100;
    const attendanceDays = Math.round(u.attendanceDays * 100) / 100;
    const workDays = Math.round(u.workDays * 100) / 100;
    return {
      userId: u.userId,
      username: u.username,
      displayName: u.displayName,
      isExternal: u.isExternal,
      totalScore,
      days: u.days,
      attendanceDays,
      workDays,
      eligible: attendanceDays >= MIN_ATTENDANCE_DAYS,
      averageScore: workDays > 0 ? (Math.round(totalScore / workDays * 100) / 100).toFixed(2) : '0.00'
    };
  }).sort((a, b) => parseFloat(b.averageScore) - parseFloat(a.averageScore));

  // Get available months (distinct year-month from data)
  const [monthRows] = await pool.execute('SELECT DISTINCT SUBSTRING(date, 1, 7) as ym FROM ops_weighted_scores ORDER BY ym DESC');
  const availableMonths = monthRows.map(r => r.ym);

  sendJSON(res, {
    success: true,
    ranking,
    currentMonth: `${year}-${String(month).padStart(2, '0')}`,
    totalUsers: ranking.length,
    minAttendanceDays: MIN_ATTENDANCE_DAYS,
    availableMonths
  });
}

async function handleGetWeightedScoreEmployees(req, res, user) {
  try {
    if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
    // Get system users (operations)
    const [sysRows] = await pool.execute('SELECT id, username, displayName, role FROM users WHERE `system` = ? ORDER BY displayName', ['operations']);
    const systemEmployees = sysRows.map(r => ({ id: r.id, username: r.username, displayName: r.displayName || r.username, role: r.role, isExternal: false }));

    // Get external users (distinct userId from weighted_scores where isExternal = 1)
    const [extRows] = await pool.execute('SELECT DISTINCT userId, username, displayName FROM ops_weighted_scores WHERE isExternal = 1');
    const externalEmployees = extRows.map(r => ({ id: r.userId, username: r.username, displayName: r.displayName || r.username, role: 'external', isExternal: true }));

    const allEmployees = [...systemEmployees, ...externalEmployees];
    sendJSON(res, { success: true, employees: allEmployees });
  } catch(e) {
    console.error('handleGetWeightedScoreEmployees error:', e.message, e.stack);
    sendJSON(res, { error: '获取员工列表失败' }, 500);
  }
}

async function handleBatchImportScores(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const records = body.records || [];
  if (!Array.isArray(records)) return sendJSON(res, { error: 'records必须是数组' }, 400);

  let inserted = 0;
  const errors = [];

  for (const rec of records) {
    try {
      const { userId, username, displayName, arrangementType, score: bodyScore, date, isExternal } = rec;
      if (!userId || !date) {
        errors.push(`缺少userId或date: ${JSON.stringify(rec)}`);
        continue;
      }

      let score;
      let finalArrangementType = arrangementType || 'custom';

      if (bodyScore !== undefined && bodyScore !== null) {
        score = parseFloat(bodyScore);
        if (isNaN(score)) {
          errors.push(`分数无效: ${rec.displayName || rec.username} ${date}`);
          continue;
        }
        if (!arrangementType) finalArrangementType = 'custom';
      } else if (arrangementType) {
        score = calculateScoreFromArrangement(arrangementType);
      } else {
        errors.push(`缺少分数: ${rec.displayName || rec.username} ${date}`);
        continue;
      }

      const id = `ws-${  date  }-${  userId}`;
      await pool.execute(
        'REPLACE INTO ops_weighted_scores (id, userId, username, displayName, arrangementType, score, date, createdAt, isExternal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, userId, username || '', displayName || '', finalArrangementType, score, date, new Date().toISOString(), isExternal ? 1 : 0]
      );
      inserted++;
    } catch (e) {
      errors.push(`${rec.displayName || rec.username}: ${e.message}`);
    }
  }

  sendJSON(res, { success: true, inserted, errors, total: records.length });
}

async function handleGetDayWeightedScores(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  const date = req.url.split('?date=')[1] || new Date().toISOString().split('T')[0];
  const [rows] = await pool.execute('SELECT userId, arrangementType, score FROM ops_weighted_scores WHERE date = ?', [date]);
  const dayScores = {};
  rows.forEach(r => {
    dayScores[r.userId] = { arrangementType: r.arrangementType, score: parseFloat(r.score) };
  });
  sendJSON(res, { success: true, date, scores: dayScores });
}

async function handleGetMonthWeightedScores(req, res, user) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限' }, 403);
  
  const url = new URL(req.url, 'http://localhost');
  const year = parseInt(url.searchParams.get('year'));
  const month = parseInt(url.searchParams.get('month'));
  
  if (!year || !month) return sendJSON(res, { error: '缺少年月参数' }, 400);
  
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const [rows] = await pool.execute(
    "SELECT userId, date, arrangementType, score FROM ops_weighted_scores WHERE date LIKE ?",
    [`${monthStr}%`]
  );
  
  // 格式: { userId: { date: { score, arrangementType } } }
  const monthScores = {};
  rows.forEach(r => {
    if (!monthScores[r.userId]) monthScores[r.userId] = {};
    monthScores[r.userId][r.date] = { 
      score: parseFloat(r.score), 
      arrangementType: r.arrangementType 
    };
  });
  
  sendJSON(res, { success: true, year, month, scores: monthScores });
}

const csrfTokens = {};
const CSRF_TOKEN_TTL = 3600; // 1 hour (seconds) — matches Redis SETEX + cookie Max-Age
async function handleGetCSRFToken(req, res, user) {
  if (!user) return sendJSON(res, { error: '未登录' }, 401);
  // S4.2: Generate random 32-byte token (256 bits of entropy — brute-force infeasible)
  const token = crypto.randomBytes(32).toString('hex');
  const userId = user.userId || user.id;
  const now = Date.now();
  // Memory store (fallback when Redis unavailable) + Redis SETEX for cross-instance validity
  csrfTokens[token] = { userId, createdAt: now };
  if (redisClient) {
    await _redisSet(`csrf:${token}`, { userId, createdAt: now }, CSRF_TOKEN_TTL);
  }
  // Cleanup memory entry after TTL (Redis TTL handles its own expiry)
  setTimeout(() => {
    delete csrfTokens[token];
    if (redisClient) _redisDel(`csrf:${token}`);
  }, CSRF_TOKEN_TTL * 1000);
  // S4.2: Set NON-HttpOnly cookie so JS can read it (double-submit pattern).
  // SameSite=Lax blocks cross-site send (defense-in-depth; header check is primary).
  const secureFlag = isHttps(req) ? '; Secure' : '';
  sendJSON(res, { success: true, csrfToken: token }, 200, req, {
    'Set-Cookie': `gms_csrf=${token}; Path=/; Max-Age=${CSRF_TOKEN_TTL}; SameSite=Lax${secureFlag}`,
  });
}

// S4.3/S4.4: verify CSRF token against Redis + memory; used by enforceCSRF middleware
async function _verifyCSRFToken(token) {
  if (!token || typeof token !== 'string') return false;
  // Redis primary (cross-instance); memory fallback (single instance)
  if (redisClient) {
    const v = await _redisGet(`csrf:${token}`);
    if (v) return true;
    // Not in Redis but in memory (e.g. Redis was unavailable at issue time)
    return !!csrfTokens[token];
  }
  return !!csrfTokens[token];
}

// -- Inventory --
// _getInventoryBreakdowns: extracted to lib/db-helpers.js (alias defined at top of file).
// Returns invType -> { available, inUse, damaged, inRepair, transferred } from sn_registry.

// (inventory handlers — handleGetAllInventory / handleGetInventory /
//  handleAdjustInventory — extracted to src/handlers/inventory.js)

// -- Machines handlers (handleGetMachines / handleAddMachine / handleDeleteMachine /
//    handleBindMachine / handleUnbindMachine / handleGetMachineBindings + unbindGlovesFromMachine
//    helper) extracted to src/handlers/machines.js (Phase 2.1 step5).
//    saveMachine / saveMachineBinding kept here (used by migrations), passed as deps. --

// -- Transactions handlers extracted to src/handlers/transactions.js (Phase 2.1 step3) --

// -- Inventory Transfer (物资调拨) --
// Feature flag: SN-level transfer marks specific gloves as 'transferred' (tracked) instead of just
// decrementing a number. When false, falls back to legacy number-subtraction (kept for backward compat
// during rollout — note the legacy path's effect can be overwritten by _syncInventoryFromSN, hence the flag).
const ENABLE_SN_TRANSFER = process.env.ENABLE_SN_TRANSFER === 'true';

// (inventory handlers — handleTransferInventory / handleGetTransferStats —
//  extracted to src/handlers/inventory.js; ENABLE_SN_TRANSFER const kept here
//  and passed as a dep to the factory)

// -- Audit Log --
async function handleGetAuditLog(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = Math.max(1, parseInt(url.searchParams.get('limit')) || 500);
  sendJSON(res, await readJSONArray('audit_log', Math.min(limit, 5000)));
}

// -- Settings --
async function handleGetSettings(req, res, user) {
  sendJSON(res, await readJSONObject('settings'));
}
async function handleSaveSettings(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可修改系统设置' }, 403);
  for (const [k, v] of Object.entries(body)) {
    await pool.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
  }
  broadcastSSE('settings_updated', {});
  sendJSON(res, { success: true });
}

// -- Inventory Alerts --
async function handleGetInventoryAlerts(req, res, user) {
  const [rows] = await pool.execute('SELECT * FROM inventory_alerts');
  // Phase 1 多仓库：按品类聚合各仓库数量（预警以总量为口径，Phase 3 细化到仓库级）
  const [inv] = await pool.execute('SELECT inv_type, SUM(quantity) as quantity FROM inventory GROUP BY inv_type');
  const alerts = [];
  for (const a of rows) {
    const invRow = inv.find(i => i.inv_type === a.inv_type);
    const qty = invRow ? invRow.quantity : 0;
    alerts.push({
      invType: a.inv_type,
      currentQty: qty,
      minQty: a.min_qty,
      maxQty: a.max_qty,
      lowThreshold: a.low_threshold,
      status: qty <= a.min_qty ? 'critical' : (qty <= a.low_threshold ? 'low' : (qty >= a.max_qty ? 'overstock' : 'normal')),
    });
  }
  sendJSON(res, alerts);
}
async function handleSetInventoryAlert(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限设置预警' }, 403);
  const { invType, minQty, maxQty, lowThreshold } = body;
  if (!invType) return sendJSON(res, { error: '缺少库存类型' }, 400);
  const now = new Date().toISOString();
  await pool.execute(
    'REPLACE INTO inventory_alerts (inv_type, min_qty, max_qty, low_threshold, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?)',
    [invType, minQty || 0, maxQty || 99999, lowThreshold || 10, now, user.username]
  );
  broadcastSSE('inventory_updated', {});
  sendJSON(res, { success: true });
}

// -- Stocktaking --
async function handleStocktaking(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限盘点' }, 403);
  const { items, autoAdjust } = body;
  if (!Array.isArray(items) || items.length === 0) return sendJSON(res, { error: '请提供盘点数据' }, 400);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date().toISOString();
    const results = [];
    for (const item of items) {
      const { invType, actualQty, note } = item;
      if (!invType) continue;
      const [invRows] = await conn.execute('SELECT quantity FROM inventory WHERE inv_type = ? AND warehouse_id = ? FOR UPDATE', [invType, 'main']);
      const systemQty = invRows.length > 0 ? invRows[0].quantity : 0;
      const diff = (actualQty || 0) - systemQty;
      const id = `st-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
      await conn.execute(
        'INSERT INTO stocktaking (id, inv_type, system_qty, actual_qty, diff, operator, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, invType, systemQty, actualQty || 0, diff, user.username, note || '', now]
      );

      // Auto-adjust inventory if requested
      if (autoAdjust && diff !== 0) {
        await conn.execute(
          'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
          [invType, 'main', actualQty || 0, now, `盘点调整(${user.username})`]
        );
        try {
          await conn.execute(
            'INSERT INTO inventory_audit (id, ts, operator_id, operator, action, warehouse_id, inv_type, note, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [`ia-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, new Date().toISOString(), user.userId || '', user.username || '', 'stocktake_adjust', 'main', invType, `盘点差异调整 ${diff > 0 ? '+' : ''}${diff}`, JSON.stringify({ systemQty, actualQty: actualQty || 0, diff })]
          );
        } catch {}
        // Create adjustment transaction
        const txId = `tx-st-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
        await conn.execute(
          'INSERT INTO transactions (id, data, ref_type, ref_id, inv_type, direction, quantity, operator, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [txId, JSON.stringify({ id: txId, type: 'stocktaking_adjust', invType, direction: diff > 0 ? 'in' : 'out', quantity: Math.abs(diff), operator: user.username, note: `盘点差异调整: ${diff > 0 ? '+' : ''}${diff}`, timestamp: now }), 'stocktaking', id, invType, diff > 0 ? 'in' : 'out', Math.abs(diff), user.username, now]
        );
      }

      results.push({ invType, systemQty, actualQty: actualQty || 0, diff, adjusted: autoAdjust && diff !== 0 });
    }
    await conn.commit();
    broadcastChange('inventory', ['transactions']);
    if (autoAdjust) broadcastSSE('stocktaking_completed', { results });
    sendJSON(res, { success: true, results });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    try { conn.release(); } catch {}
  }
}
async function handleGetStocktaking(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const [rows] = await pool.query('SELECT * FROM stocktaking ORDER BY createdAt DESC LIMIT ?', [limit]);
  sendJSON(res, rows);
}

// -- Inbound Orders --
async function handleCreateInboundOrder(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限创建入库单' }, 403);
  const { orderNo, supplier, items, note } = body;
  if (!orderNo || !items || !Array.isArray(items)) return sendJSON(res, { error: '缺少入库单号或明细' }, 400);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date().toISOString();
    const totalQty = items.reduce((s, i) => s + (i.quantity || 0), 0);
    const id = `inb-${  orderNo}`;
    await conn.execute(
      'INSERT INTO inbound_orders (id, order_no, supplier, total_qty, received_qty, status, operator, note, createdAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      [id, orderNo, supplier || '', totalQty, 'pending', user.username, note || '', now]
    );
    for (const item of items) {
      const [eqType, hType] = _invTypeToSNFields(item.invType);
      for (let i = 0; i < (item.quantity || 0); i++) {
        const snCode = `INB-${orderNo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await conn.execute(
          'INSERT INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, trackingNumber, damageReason, shippedAt, repairedAt, attachment, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [snCode, eqType, hType, 'available', '', '', '', '', '', '', now]
        );
      }
    }
    await conn.execute('UPDATE inbound_orders SET received_qty = total_qty, status = ? WHERE id = ?', ['completed', id]);
    await _syncInventoryFromSN(conn);

    // Record transaction for each item type
    for (const item of items) {
      const txId = `tx-inb-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
      await conn.execute(
        'INSERT INTO transactions (id, data, ref_type, ref_id, inv_type, direction, quantity, operator, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [txId, JSON.stringify({ id: txId, type: 'inbound_order', invType: item.invType, direction: 'in', quantity: item.quantity, operator: user.username, refId: id, note: note || '', timestamp: now }), 'inbound_order', id, item.invType, 'in', item.quantity, user.username, now]
      );
    }

    await conn.commit();
    broadcastChange('sn_registry', ['inventory', 'transactions']);
    sendJSON(res, { success: true, orderNo, totalQty });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    try { conn.release(); } catch {}
  }
}
async function handleGetInboundOrders(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const [rows] = await pool.query('SELECT * FROM inbound_orders ORDER BY createdAt DESC LIMIT ?', [limit]);
  sendJSON(res, rows);
}

// -- Outbound Orders --
async function handleCreateOutboundOrder(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '无权限创建出库单' }, 403);
  const { orderNo, destination, items, note } = body;
  if (!orderNo || !items || !Array.isArray(items)) return sendJSON(res, { error: '缺少出库单号或明细' }, 400);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date().toISOString();
    const totalQty = items.reduce((s, i) => s + (i.quantity || 0), 0);
    const id = `outb-${  orderNo}`;
    await conn.execute(
      'INSERT INTO outbound_orders (id, order_no, destination, total_qty, shipped_qty, status, operator, note, createdAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      [id, orderNo, destination || '', totalQty, 'pending', user.username, note || '', now]
    );
    for (const item of items) {
      const [eqType, hType] = _invTypeToSNFields(item.invType);
      const qty = item.quantity || 0;
      const [availableRows] = await conn.execute(
        `SELECT snCode FROM sn_registry WHERE equipmentType = ? AND handType = ? AND status = 'available' ORDER BY updatedAt DESC LIMIT ${qty} FOR UPDATE`,
        [eqType, hType]
      );
      for (const row of availableRows) {
        await conn.execute('DELETE FROM sn_registry WHERE snCode = ?', [row.snCode]);
      }
    }
    await conn.execute('UPDATE outbound_orders SET shipped_qty = total_qty, status = ?, shippedAt = ? WHERE id = ?', ['completed', now, id]);
    await _syncInventoryFromSN(conn);

    // Record transaction for each item type
    for (const item of items) {
      const txId = `tx-outb-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`;
      await conn.execute(
        'INSERT INTO transactions (id, data, ref_type, ref_id, inv_type, direction, quantity, operator, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [txId, JSON.stringify({ id: txId, type: 'outbound_order', invType: item.invType, direction: 'out', quantity: item.quantity, operator: user.username, refId: id, note: note || '', timestamp: now }), 'outbound_order', id, item.invType, 'out', item.quantity, user.username, now]
      );
    }

    await conn.commit();
    broadcastChange('sn_registry', ['inventory', 'transactions']);
    sendJSON(res, { success: true, orderNo, totalQty });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: e.message }, 500);
  } finally {
    try { conn.release(); } catch {}
  }
}
async function handleGetOutboundOrders(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const [rows] = await pool.query('SELECT * FROM outbound_orders ORDER BY createdAt DESC LIMIT ?', [limit]);
  sendJSON(res, rows);
}

// -- Manual Inventory Sync (extracted to src/handlers/inventory.js) --

// -- Data Integrity --
async function handleDataIntegrity(req, res) {
  const issues = [];
  const [inv] = await pool.execute('SELECT * FROM inventory');
  inv.forEach(i => { if (i.quantity < 0) issues.push({ type: 'negative_stock', item: i.inv_type, detail: `库存为负数: ${i.quantity}` }); });
  const machines = await readJSONArray('machines');
  const eqConfig = await readJSONArray('equipment_config');
  machines.forEach(m => { if (!eqConfig.find(e => e.id === m.deviceType)) issues.push({ type: 'orphaned_machine', item: m.machineNumber, detail: `设备类型 "${m.deviceType}" 不存在` }); });
  sendJSON(res, { issues, count: issues.length });
}

// -- Operations --
async function handleGetOps(req, res, table) {
  validateTable(table);
  sendJSON(res, await readJSONArray(table));
}
async function handleSaveOps(req, res, table, body) {
  validateTable(table);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM ${table}`);
    if (Array.isArray(body)) {
      for (const item of body) {
        await conn.execute(`INSERT INTO ${table} (id, data) VALUES (?, ?)`, [item.id || (`_${  Date.now().toString(36)}`), JSON.stringify(item)]);
      }
    }
    await conn.commit();
    broadcastSSE(`${table}_updated`, {});
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: `保存失败: ${  e.message}` }, 500);
  } finally {
    conn.release();
  }
}

// -- Last Backup --
function handleLastBackup(req, res) {
  try {
    const stat = fs.statSync(path.join(DATA_DIR, 'gms.db'));
    sendJSON(res, { lastModified: stat.mtime.toISOString() });
  } catch { sendJSON(res, { lastModified: null }); }
}

// -- XLSX Export --
async function handleExportXLSX(req, res, user) {
  const XLSX = require('xlsx');
  const transactions = await readJSONArray('transactions');
  const invConfigs = await readJSONArray('inventory_config');
  const eqConfigs = await readJSONArray('equipment_config');
  const cfgMap = {};
  invConfigs.forEach(c => { cfgMap[c.id] = c; if (c.hasLeftRight) { cfgMap[`${c.id  }_left`] = { name: `${c.name  }左手` }; cfgMap[`${c.id  }_right`] = { name: `${c.name  }右手` }; } });

  const rows = transactions.map(t => {
    // 设备类型 + 左右手合并到一个列
    let equipLabel = '';
    const handLabel = t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '';
    const cfg = cfgMap[t.equipmentType];
    if (cfg) {
      // 设备名携带左右手（_left/_right 变体已含左右手，避免重复前缀）
      const variant = /_(left|right)$/.test(t.equipmentType || '');
      equipLabel = (handLabel && !variant) ? handLabel + cfg.name : cfg.name;
    } else if (t.equipmentType === 'glove') {
      equipLabel = handLabel ? `${handLabel  }手套` : '手套';
    } else if (t.equipmentType === 'dexterous_hand') {
      equipLabel = handLabel ? `${handLabel  }灵巧手` : '灵巧手';
    } else {
      equipLabel = handLabel ? handLabel + t.equipmentType : t.equipmentType;
    }
    // 更新人：兼容多种字段名
    const updater = t.updatedBy || t.user || t.updatedby || '';
    return {
      '时间': t.timestamp ? new Date(t.timestamp).toLocaleString('zh-CN') : '',
      '设备类型': equipLabel,
      '出入库': t.direction === 'in' ? '入库' : t.direction === 'out' ? '出库' : (t.direction || ''),
      '数量': t.quantity || 0,
      'SN码': t.snCode || '',
      '机器编号': t.machineNumber || '',
      '更新人': updater,
      '备注': t.note || '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 16 }, { wch: 8 }, { wch: 8 },
    { wch: 8 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 22 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '流水记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent(`流水记录-${  new Date().toISOString().slice(0, 10)}`);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}.xlsx`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

// (handleExportTechSupportXLSX — extracted to src/handlers/tech-support.js)

// -- Clear All Data --
async function handleClearAllData(req, res, user) {
  if (user.role !== 'superadmin' || user.system !== 'maintenance') return sendJSON(res, { error: '仅运维超级管理员可执行全局清空' }, 403);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tables = ['inventory', 'machines', 'transactions', 'audit_log',
      'ops_orders', 'ops_customers', 'ops_production', 'sn_registry', 'tech_support',
      'settings', 'group_transfers', 'popup_messages', 'replacements'];
    for (const t of tables) await conn.execute(`DELETE FROM ${  t}`);
    await conn.commit();
    // Clean uploaded photo files
    try {
      if (fs.existsSync(UPLOADS_DIR)) {
        fs.readdirSync(UPLOADS_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} });
      }
    } catch {}
    // 全量数据清除：一个 data_changed 事件覆盖所有数据域（替代原 10 个 *_updated）
    broadcastChange('machines', ['inventory', 'transactions', 'audit_log', 'sn_registry', 'tech_support', 'group_transfers', 'ops_orders', 'ops_customers', 'ops_production']);
    sendJSON(res, { success: true });
  } catch (e) {
    await conn.rollback();
    sendJSON(res, { error: `清除失败: ${  e.message}` }, 500);
  } finally {
    conn.release();
  }
}

// -- Full Export (ZIP) --
async function handleExportFull(req, res, user) {
  if (user.role !== 'superadmin' || user.system !== 'maintenance') return sendJSON(res, { error: '仅运维超级管理员可执行全量导出' }, 403);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  const [inv] = await pool.execute('SELECT * FROM inventory');
  const machines = await readJSONArray('machines', 50000);
  const transactions = await readJSONArray('transactions', 50000);
  const auditLog = await readJSONArray('audit_log', 50000);
  const settings = await readJSONObject('settings');
  const [snReg] = await pool.execute('SELECT * FROM sn_registry');
  const equipmentConfig = await readJSONArray('equipment_config', 500);
  const inventoryConfig = await readJSONArray('inventory_config', 500);
  const opsOrders = await readJSONArray('ops_orders', 50000);
  const opsCustomers = await readJSONArray('ops_customers', 50000);
  const opsProduction = await readJSONArray('ops_production', 50000);
  const [tsRows] = await pool.execute('SELECT data FROM tech_support');
  const techSupport = tsRows.map(r => JSON.parse(r.data));
  const [userRows] = await pool.execute('SELECT id, username, role, `system`, displayName, parentId, createdBy, createdAt, status FROM users');
  const [popupRows] = await pool.execute('SELECT * FROM popup_messages');

  const backup = {
    version: '4.0-mysql',
    exportedAt: new Date().toISOString(),
    inventory: inv.map(r => ({ type: r.inv_type, warehouseId: r.warehouse_id, quantity: r.quantity, updatedAt: r.updatedAt, updatedBy: r.updatedBy })),
    machines, transactions, auditLog, settings,
    snRegistry: snReg.map(r => ({
      snCode: r.snCode, equipmentType: r.equipmentType, handType: r.handType,
      status: r.status, machineNumber: r.machineNumber, damageReason: r.damageReason,
      trackingNumber: r.trackingNumber, attachment: r.attachment, updatedAt: r.updatedAt,
      shippedAt: r.shippedAt, repairedAt: r.repairedAt
    })),
    equipmentConfig, inventoryConfig, opsOrders, opsCustomers, opsProduction, techSupport,
    users: userRows, popupMessages: popupRows,
  };
  zip.addFile('backup.json', Buffer.from(JSON.stringify(backup, null, 2), 'utf8'));

  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      fs.readdirSync(UPLOADS_DIR).forEach(f => {
        const fp = path.join(UPLOADS_DIR, f);
        if (fs.statSync(fp).isFile()) zip.addLocalFile(fp, 'uploads');
      });
    }
  } catch (e) { console.error('[EXPORT] Failed to include uploads:', e.message); }

  const buf = zip.toBuffer();
  const filename = `gms-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buf.length,
  });
  res.end(buf);
}

// -- Full Import (ZIP) --
async function handleImportFull(req, res, user, body) {
  if (user.role !== 'admin' && user.role !== 'superadmin') return sendJSON(res, { error: '仅管理员可执行此操作' }, 403);
  if (!body || !body.zipData) return sendJSON(res, { error: '缺少备份数据' }, 400);

  const AdmZip = require('adm-zip');
    const buf = Buffer.from(body.zipData, 'base64');
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();

    const jsonEntry = entries.find(e => e.entryName === 'backup.json');
    if (!jsonEntry) return sendJSON(res, { error: '备份文件中未找到 backup.json' }, 400);
    const backup = JSON.parse(jsonEntry.getData().toString('utf8'));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Phase 1: Delete all data in transaction
      const tables = ['inventory', 'machines', 'transactions', 'audit_log', 'sn_registry',
        'ops_orders', 'ops_customers', 'ops_production', 'tech_support',
        'settings', 'group_transfers', 'popup_messages'];
      for (const t of tables) await conn.execute(`DELETE FROM ${  t}`);

      // Phase 2: Restore all data in same transaction
      // Restore inventory
      if (Array.isArray(backup.inventory)) {
        for (const r of backup.inventory) {
          await conn.execute('REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
            [r.type, r.warehouseId || 'main', r.quantity, r.updatedAt, r.updatedBy]);
        }
      }

      // Restore JSON blob tables
      const jsonTables = {
        machines: 'machines', transactions: 'transactions', auditLog: 'audit_log',
        equipmentConfig: 'equipment_config', inventoryConfig: 'inventory_config',
        opsOrders: 'ops_orders', opsCustomers: 'ops_customers', opsProduction: 'ops_production',
        techSupport: 'tech_support',
      };
      for (const [jsonKey, table] of Object.entries(jsonTables)) {
        if (Array.isArray(backup[jsonKey])) {
          for (const item of backup[jsonKey]) {
            const id = item.id || item.snCode || item.type || (`_${  Math.random().toString(36).slice(2)}`);
            await conn.execute(`REPLACE INTO ${table} (id, data) VALUES (?, ?)`, [id, JSON.stringify(item)]);
          }
        }
      }

      // Restore settings
      if (backup.settings && typeof backup.settings === 'object') {
        for (const [k, v] of Object.entries(backup.settings)) {
          await conn.execute('REPLACE INTO settings (skey, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
        }
      }

      // Restore SN registry
      if (Array.isArray(backup.snRegistry)) {
        for (const r of backup.snRegistry) {
          await conn.execute(
            'REPLACE INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, updatedAt, shippedAt, repairedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [r.snCode, r.equipmentType || null, r.handType || null, r.status || 'available',
              r.machineNumber || null, r.damageReason || null, r.trackingNumber || null,
              r.attachment || null, r.updatedAt || new Date().toISOString(),
              r.shippedAt || null, r.repairedAt || null]
          );
        }
      }

      // Restore users
      if (Array.isArray(backup.users)) {
        for (const u of backup.users) {
          // New exports intentionally omit password hashes; never overwrite a
          // live account with an unusable empty hash.
          if (!u.passwordHash) continue;
          await conn.execute(
            'REPLACE INTO users (id, username, passwordHash, role, `system`, displayName, parentId, createdBy, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [u.id, u.username, u.passwordHash, u.role || 'user', u.system || 'maintenance', u.displayName || u.username, u.parentId || null, u.createdBy || null, u.createdAt || new Date().toISOString(), u.status || 'active']
          );
        }
      }
      // Restore popup messages
      if (Array.isArray(backup.popupMessages)) {
        for (const p of backup.popupMessages) {
          await conn.execute('REPLACE INTO popup_messages (id, category, text, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
            [p.id, p.category, p.text, p.createdBy || 'system', p.createdAt || new Date().toISOString()]);
        }
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      console.error('[IMPORT] Failed:', e.message);
      return sendJSON(res, { error: `恢复失败: ${  e.message}` }, 500);
    } finally {
      conn.release();
    }

    // Clean uploads dir (outside transaction — file I/O)
    try {
      if (fs.existsSync(UPLOADS_DIR)) {
        fs.readdirSync(UPLOADS_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} });
      }
    } catch {}

    // Restore uploaded files
    entries.forEach(e => {
      if (e.entryName.startsWith('uploads/') && !e.isDirectory) {
        const fname = path.basename(e.entryName);
        if (fname) fs.writeFileSync(path.join(UPLOADS_DIR, fname), e.getData());
      }
    });

    // 数据恢复：一个 data_changed 事件覆盖所有数据域（替代原 12 个 *_updated）
    broadcastChange('machines', ['inventory', 'transactions', 'audit_log', 'sn_registry', 'tech_support', 'equipment_config', 'inventory_config', 'settings', 'ops_orders', 'ops_customers', 'ops_production']);

    sendJSON(res, { success: true, message: '数据恢复成功' });
}

// Helper: Sync inventory table from sn_registry - recalculates and updates all inventory types
// Call this after any SN registry mutations to keep inventory counts consistent
async function _syncInventoryFromSN(conn) {
  const useConn = conn || pool;
  // 多品类：纯数量模式（quantity）的库存类型由 adjustInventory 直接管理，
  // 不参与 SN 化重算，否则会把手工数量覆盖为 SN 统计值
  const quantityTypes = new Set();
  try {
    const [cfgRows] = await useConn.execute('SELECT id, data FROM inventory_config');
    for (const r of cfgRows) {
      try {
        const c = JSON.parse(r.data);
        if (c && c.trackingMode === 'quantity' && c.id) {
          quantityTypes.add(c.id);
          if (c.hasLeftRight) { quantityTypes.add(`${c.id}_left`); quantityTypes.add(`${c.id}_right`); }
        }
      } catch { /* 坏配置行跳过 */ }
    }
  } catch { /* inventory_config 表不存在时全部按 SN 模式处理 */ }
  const [rows] = await useConn.execute(
    `SELECT equipmentType, handType, status,
            COUNT(*) as cnt FROM sn_registry
     WHERE status IN ('available', 'in_use', 'damaged', 'in_repair')
     GROUP BY equipmentType, handType, status`
  );
  const counts = {};
  for (const r of rows) {
    const invType = _snToInvType(r.equipmentType, r.handType);
    if (!invType || quantityTypes.has(invType)) continue;
    if (!counts[invType]) counts[invType] = { available: 0, inUse: 0, damaged: 0, inRepair: 0 };
    if (r.status === 'available') counts[invType].available += r.cnt;
    else if (r.status === 'in_use') counts[invType].inUse += r.cnt;
    else if (r.status === 'damaged') counts[invType].damaged += r.cnt;
    else if (r.status === 'in_repair') counts[invType].inRepair += r.cnt;
  }
  const now = new Date().toISOString();
  const alerts = [];
  for (const [invType, c] of Object.entries(counts)) {
    const total = c.available + c.inUse + c.damaged + c.inRepair;
    await useConn.execute(
      'REPLACE INTO inventory (inv_type, warehouse_id, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)',
      [invType, 'main', total, now, '系统同步']
    );
    // Check inventory alerts
    try {
      const [alertRows] = await useConn.execute(
        'SELECT min_qty, max_qty, low_threshold FROM inventory_alerts WHERE inv_type = ?',
        [invType]
      );
      if (alertRows.length > 0) {
        const a = alertRows[0];
        if (total <= a.min_qty || total <= (a.low_threshold || 0)) {
          alerts.push({ invType, level: 'low', qty: total, threshold: a.min_qty });
        } else if (a.max_qty && total >= a.max_qty) {
          alerts.push({ invType, level: 'high', qty: total, threshold: a.max_qty });
        }
      }
    } catch (e) { /* alerts table may not exist yet */ }
  }
  // Broadcast alert notifications
  if (alerts.length > 0) {
    broadcastSSE('inventory_alert', { alerts, timestamp: now });
  }
}

// ==================== SN REGISTRY ====================
// (sn-registry handlers — handleGetSNRegistry / handleUpsertSNRegistry /
//  handleBatchInsertSNRegistry / handleShipSN / handleRepairCompleteSN /
//  handleDeleteSNFull / handleDeleteSNRegistry / handleGetSNStatus /
//  handleGenerateQRCode / handleGetSNStatusHistory / handleSNStatusChange —
//  extracted to src/handlers/sn-registry.js (Phase 2.1 step6).
//  Also extracted: _updateMachineStatusInTxn helper + qrCodeCache module state.
//  handleSyncMachineState was extracted earlier to machines.js (step5).)

// (handleBatchInsertSNRegistry / handleShipSN / handleRepairCompleteSN /
//  handleDeleteSNFull / handleDeleteSNRegistry — extracted to
//  src/handlers/sn-registry.js (Phase 2.1 step6).)

// (SN Status QR Code API: handleGetSNStatus / handleGenerateQRCode /
//  handleGetSNStatusHistory / handleSNStatusChange + qrCodeCache — extracted
//  to src/handlers/sn-registry.js (Phase 2.1 step6).)

// -- File Upload / Delete --
function handleUpload(req, res, body) {
  // Store attachments as base64 in DB (not filesystem — prevents data loss on server rebuild)
  const { filename, data } = body;
  if (!data || !filename) return sendJSON(res, { error: '缺少文件数据' }, 400);
  // S3.6: sanitize filename (strip path components, block traversal, enforce extension whitelist)
  const UPLOAD_EXT_WHITELIST = /\.(jpe?g|png|gif|webp|bmp|pdf|txt|xlsx?|docx?|zip|mp4|mov|webm)$/i;
  const safeName = String(filename).split(/[\\/]/).pop().replace(/\.\.+/g, '.').slice(0, 255);
  if (!UPLOAD_EXT_WHITELIST.test(safeName)) return sendJSON(res, { error: '不支持的文件类型（仅允许图片/文档/视频/压缩包）' }, 400);
  // S3.6: MIME whitelist (parsed from data URL)
  const MIME_WHITELIST = /^(image\/|application\/pdf|text\/plain|application\/vnd\.ms-excel|application\/vnd\.openxmlformats|application\/zip|application\/x-zip|video\/)/;
  const matches = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return sendJSON(res, { error: '无效的数据格式' }, 400);
  if (!MIME_WHITELIST.test(matches[1])) return sendJSON(res, { error: '不支持的 MIME 类型' }, 400);
  const base64Data = matches[2];
  const decodedBuf = Buffer.from(base64Data, 'base64');
  if (decodedBuf.length > 10 * 1024 * 1024) return sendJSON(res, { error: '文件大小超过限制(最大10MB)' }, 413);
  // Return the base64 data URL directly — frontend stores it in the attachment field
  sendJSON(res, { path: data, filename: safeName });
}

function handleDeleteUpload(req, res, body) {
  const { filePath } = body;
  if (!filePath || !filePath.startsWith('/uploads/')) return sendJSON(res, { error: '无效的文件路径' }, 400);
  const fullPath = path.join(__dirname, filePath);
  if (!fullPath.startsWith(UPLOADS_DIR)) return sendJSON(res, { error: '路径越界' }, 403);
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    sendJSON(res, { success: true });
  } catch (e) { sendJSON(res, { error: '删除失败' }, 500); }
}

// -- Sync endpoint (polling fallback) --
async function handleSync(req, res) {
  const cachedData = await _cached('sync', async () => {
    const [inventory, snRegistry, tsRows, machines, transactions,
      settings, equipmentConfig, inventoryConfig,
      opsOrders, opsCustomers, opsProduction, storageLocationsRows, warehousesRows] = await Promise.all([
    pool.execute('SELECT * FROM inventory'),
    pool.execute('SELECT * FROM sn_registry ORDER BY updatedAt DESC'),
    pool.execute('SELECT data FROM tech_support ORDER BY id DESC LIMIT 1000'),
    pool.execute('SELECT data FROM machines ORDER BY id DESC LIMIT 500'),
    pool.execute('SELECT data FROM transactions ORDER BY id DESC LIMIT 1000'),
    pool.execute('SELECT skey, value FROM settings'),
    pool.execute('SELECT data FROM equipment_config ORDER BY id DESC'),
    pool.execute('SELECT data FROM inventory_config ORDER BY id DESC'),
    pool.execute('SELECT data FROM ops_orders ORDER BY id DESC'),
    pool.execute('SELECT data FROM ops_customers ORDER BY id DESC'),
    pool.execute('SELECT data FROM ops_production ORDER BY id DESC'),
    pool.execute('SELECT * FROM storage_locations ORDER BY area, code'),
    pool.execute('SELECT id, name, status, location FROM warehouses ORDER BY id = \'main\' DESC, id ASC'),
  ]);

  return {
    inventory: inventory[0].map(r => ({ type: r.inv_type, warehouseId: r.warehouse_id, quantity: r.quantity, updatedAt: r.updatedAt, updatedBy: r.updatedBy })),
    warehouses: warehousesRows[0],
    machines: machines[0].map(r => JSON.parse(r.data)),
    transactions: transactions[0].map(r => JSON.parse(r.data)).reverse(),
    snRegistry: snRegistry[0],
    settings: (() => { const obj = {}; settings[0].forEach(r => { try { obj[r.skey] = JSON.parse(r.value); } catch { obj[r.skey] = r.value; } }); return obj; })(),
    equipmentConfig: equipmentConfig[0].map(r => JSON.parse(r.data)),
    inventoryConfig: inventoryConfig[0].map(r => JSON.parse(r.data)),
    opsOrders: opsOrders[0].map(r => JSON.parse(r.data)),
    opsCustomers: opsCustomers[0].map(r => JSON.parse(r.data)),
    opsProduction: opsProduction[0].map(r => JSON.parse(r.data)),
    techSupport: tsRows[0].map(r => JSON.parse(r.data)),
    storageLocations: storageLocationsRows[0],
  };
  });
  sendJSON(res, cachedData, 200, req);
}

// ==================== SERVER ====================
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      // S1: apply security headers to CORS preflight responses
      applySecurityHeaders(res, { coop: isHttps(req) });
      res.writeHead(204, {
        ...corsHeadersObj(),
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      });
      return res.end();
    }

    // Favicon — return SVG icon to avoid 404 in browser console
    if (req.url === '/favicon.ico' && req.method === 'GET') {
      // S1: apply security headers
      applySecurityHeaders(res, { coop: isHttps(req) });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">🧤</text></svg>');
    }

    // S8: request guard — 防爬取/防攻击入口（robots、敏感路径、目录穿越、静态白名单、爬虫UA）
    if (requestGuard(req, res)) return;

    // S2: global per-IP rate limit (applied to all remaining routes incl. static + API;
    // OPTIONS preflight and favicon bypass to avoid breaking browser navigation).
    // 200 req/s is generous — normal page loads (~10 reqs) never trip it; only abuse does.
    if (rateLimiter) {
      const ipResult = await rateLimiter.checkIpLimit(getClientIp(req));
      if (!ipResult.allowed) {
        res.setHeader('Retry-After', String(ipResult.retryAfter || 1));
        return sendJSON(res, { error: '请求过于频繁，请稍后再试' }, 429, req);
      }
    }

    if (req.url === '/api/health' && req.method === 'GET') {
      return sendJSON(res, { status: 'ok', uptime: process.uptime() });
    }

    if (req.url === '/api/version' && req.method === 'GET') {
      return sendJSON(res, { version: SERVER_VERSION, uptime: process.uptime() });
    }

    if (req.url === '/api/status' && req.method === 'GET') {
      let count = 0;
      // Redis 优先: 扫描 tk:* 计数活跃 token（跨 worker 准确）
      if (redisClient && redisClient.isReady) {
        try {
          let cursor = 0;
          do {
            const r = await redisClient.scan(cursor, { MATCH: 'tk:*', COUNT: 500 });
            cursor = r.cursor;
            count += r.keys.length;
          } while (cursor !== 0);
        } catch {}
      }
      // 纯内存兜底
      if (count === 0) {
        const onlineIds = new Set();
        Object.values(tokens).forEach(t => { if (t.expires > Date.now()) onlineIds.add(t.userId); });
        count = onlineIds.size;
      }
      // Load level: idle(0) / smooth(1-99) / busy(100-199) / full(200+)
      let level = 'idle', label = '空闲';
      if (count >= 200) { level = 'full'; label = '爆满'; }
      else if (count >= 100) { level = 'busy'; label = '拥挤'; }
      else if (count >= 1) { level = 'smooth'; label = '畅通'; }
      return sendJSON(res, {
        status: 'ok',
        onlineUsers: count,
        loadLevel: level,
        loadLabel: label,
        version: '3.9.0',
      });
    }

    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname === '/api/events' && req.method === 'GET') {
      const authUser = await requireAuth(req, res, true);
      if (!authUser) return;
      // S1: apply security headers to SSE handshake
      applySecurityHeaders(res, { coop: isHttps(req) });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeadersObj(),
      });
      res.write('event: connected\ndata: {"status":"ok"}\n\n');
      realtime.addSSEClient(res, authUser);
      req.on('close', () => realtime.removeSSEClient(res));
      return;
    }

    if (serveStatic(req, res)) return;

    const url = new URL(req.url, 'http://localhost');
    // S2: allow larger bodies for upload routes, 1MB cap for everything else
    const _isUploadRoute = url.pathname.startsWith('/api/upload') || (url.pathname.startsWith('/api/tech-support') && req.method === 'POST');
    const body = (req.method === 'POST' || req.method === 'PUT') ? await parseBody(req, _isUploadRoute ? BODY_LIMIT_UPLOAD : BODY_LIMIT_DEFAULT) : {};

    // Phase 2.1 step8: public modular routes via publicRouter (priority over legacy if-chain)
    if (publicRouter.dispatch(req, res, url, undefined, body)) return;

    // Auth required for all other API routes
    const authUser = await requireAuth(req, res);
    if (!authUser) return;

    // S2: per-user rate limit (60 req/min — prevents a single session from flooding the API)
    if (rateLimiter) {
      const userResult = await rateLimiter.checkUserLimit(authUser.userId || authUser.id);
      if (!userResult.allowed) {
        res.setHeader('Retry-After', String(userResult.retryAfter || 60));
        return sendJSON(res, { error: '操作过于频繁，请稍后再试' }, 429, req);
      }
    }

    // S4.4: CSRF enforcement gate
    if (csrfMiddleware && url.pathname !== '/api/csrf-token') {
      const ok = await csrfMiddleware.gate(req, res);
      if (!ok) return;
    }

    // Phase 2.2: all auth-gated routes now via authRouter (if-chain removed)
    if (authRouter.dispatch(req, res, url, authUser, body)) return;

    sendJSON(res, { error: 'Not found' }, 404);
  } catch (e) {
    console.error('[REQUEST ERROR]', req.url, e.message);
    try { sendJSON(res, { error: '服务器内部错误' }, 500); } catch {}
  }
});

// ==================== STARTUP ====================
async function startup() {
  try {
    // Init Redis first (non-fatal if unavailable)
    await initRedis();

    await initPool();
    await initDB();

    // S2: create rate limiter after redis is ready (falls back to memory if redis unavailable)
    rateLimiter = createRateLimiter({ redisClient });

    // S4.3/S4.4: create CSRF middleware with token verifier (defined later in module scope)
    csrfMiddleware = createCSRFMiddleware({
      verifyToken: (token) => _verifyCSRFToken(token),
      sendJSON: (...args) => sendJSON(...args),
    });
    console.log(`[CSRF] middleware initialized (enforced=${csrfMiddleware.config.CSRF_ENFORCED})`);

    // Initialize extracted handler modules (Phase 2.1): inject pool/redis and
    // auth-core helpers as deps. Must run AFTER initRedis+initPool so the
    // captured references are the live ones. `tokens` is a const object mutated
    // in place, so the reference stays valid for the process lifetime.
    auth = createAuthHandlers({
      pool, redisClient, tokens, saveTokens,
      hashPassword, verifyPassword, encryptPassword, decryptPassword,
      createToken, validateToken, invalidateUserTokens,
      sendJSON, broadcastSSE,
      // S2: login brute-force protection deps
      rateLimiter, getClientIp,
      // S4.1: HTTPS detection for Secure cookie flag
      isHttps,
      // S5.1: cookie parsing for handleLogout cookie-token invalidation
      parseCookies,
    });
    users = createUsersHandlers({
      pool, tokens, saveTokens,
      hashPassword, verifyPassword, encryptPassword,
      invalidateUserTokens,
      sendJSON, broadcastSSE,
      redisClient,
    });
    transactions = createTransactionsHandlers({
      pool, _insertTransaction,
      readJSONArray, readJSONById, deleteJSON,
      sendJSON, broadcastSSE,
    });
    // Phase 2：批次域（先于 inventory 创建，注入批次台账 helper）
    batchesDomain = createBatchHandlers({ pool, sendJSON });
    inventory = createInventoryHandlers({
      pool, _getInventoryBreakdowns, _invTypeToSNFields,
      _syncInventoryFromSN, _insertTransaction,
      broadcastChange, broadcastSSE,
      ENABLE_SN_TRANSFER, sendJSON,
      batches: batchesDomain,
    });
    edge = createEdgeHandlers({ pool, redisClient, sendJSON, broadcastSSE, broadcastChange, syncInventoryFromSN: _syncInventoryFromSN });
    edge.startSweeper();
    machines = createMachinesHandlers({
      pool, sendJSON,
      _cached, _cache,
      saveMachine, saveMachineBinding,
      readJSONById, deleteJSON, saveJSON,
      _syncInventoryFromSN, _insertTransaction,
      _snToInvType,
      broadcastChange, broadcastSSE,
      loadEdgePresence: edge.loadEdgePresence,
      getEdgeLive: require('./src/edge-live').getEdgeLive
    });
    snRegistry = createSNRegistryHandlers({
      pool, sendJSON,
      _cached,
      _syncInventoryFromSN, _insertTransaction,
      _getStatusLabel,
      broadcastChange,
    });
    techSupport = createTechSupportHandlers({
      pool, sendJSON,
      _cached,
      readJSONById, deleteJSON, saveMachine, saveTechSupport,
      _syncInventoryFromSN,
      broadcastChange,
      realtime, feishu,
      fmtDuration: _fmtDuration,
      // 工单联动机器生产状态：提交→待维修，完成/删除→可生产
      setProductionStatus: (...args) => machines.setProductionStatus(...args),
    });

    // PWA Web Push handlers
    push = createPushHandlers({
      pool, redisClient, sendJSON, broadcastSSE,
    });

    // Chat handler
    chat = createChatHandlers({
      pool, sendJSON, broadcastSSE, _cached,
    });

    sop = createSOPHandlers({ pool, sendJSON });

    solutions = createSolutionsHandlers({ pool, sendJSON });
    configuration = createConfigurationHandlers({
      pool, sendJSON, _cached, readJSONArray, deleteJSON, broadcastSSE, broadcastChange,
    });

    stocktakes = createStocktakeHandlers({
      pool, sendJSON,
      _invTypeToSNFields,
      _syncInventoryFromSN,
      _insertTransaction,
      broadcastChange,
    });

    // agent = createAgentHandlers({ pool, sendJSON, broadcastSSE, _cached });

    replacement = createReplacementHandlers({
      pool, sendJSON, _syncInventoryFromSN, _insertTransaction, broadcastChange,
    });

    storageLocations = createStorageLocationsHandlers({
      pool, sendJSON, broadcastChange,
    });

    // Phase 1 企业级基座：RBAC 引擎 + 仓库/角色管理域
    // 必须在 initPool 之后创建（引擎按需查询 roles/users 表）
    rbacEngine = createRbacEngine({ pool });
    warehousesDomain = createWarehouseHandlers({
      pool, sendJSON, rbac: rbacEngine, broadcastChange,
    });
    rbacRoles = createRoleHandlers({
      pool, sendJSON, rbac: rbacEngine, broadcastChange, invalidateUserTokens,
    });
    // Phase 2：跨仓库调拨域（依赖 rbac + 批次移库 helper）
    warehouseTransfers = createWarehouseTransferHandlers({
      pool, sendJSON, rbac: rbacEngine,
      _invTypeToSNFields, _insertTransaction, broadcastChange,
      batches: batchesDomain,
    });

    // ==================== ROUTER REGISTRATION (Phase 2.1 step8) ====================
    // Two routers: publicRouter (before requireAuth) + authRouter (after requireAuth).
    // Pattern routes are insertion-order sensitive; order MUST match original if-chain.
    // Legacy server.js-local handlers remain in original if-chain as fallback.

    // ---- publicRouter: routes dispatched BEFORE requireAuth gate ----
    publicRouter.register('/api/auth/login', 'POST', auth.handleLogin, {
      auth:'none', body:true,
      // S3.3: login input validation — block malformed input before DB query
      validate: { body: {
        username: { type:'string', required:true, max:64, regex:/^[^\s]{1,64}$/, regexMsg:'用户名不能含空白且不超过64字符' },
        password: { type:'string', required:true, max:128 },
        machineCode: { type:'string', max:64 },
      } }
    });
    publicRouter.register('/api/auth/verify',             'POST', auth.handleTokenVerify,        { auth:'none', body:true });
    publicRouter.register('/api/auth/users',              'GET',  auth.handleGetUsers,           { auth:'none' });
    publicRouter.register('/api/beacon-logout',           'POST', auth.handleBeaconLogout,       { auth:'none', body:true });
    // S5.3: /api/logout is public (no auth gate) so it can ALWAYS clear the HttpOnly
    // gms_token cookie via Set-Cookie: Max-Age=0, even when the server-side session
    // has already expired (requireAuth would otherwise 401 and skip the Set-Cookie).
    // handleLogout reads the cookie/Bearer itself and invalidates whatever token it
    // finds. Logout CSRF is low-severity (attacker can only log victim out, no data
    // exposure) so exempting it from the CSRF gate is acceptable.
    publicRouter.register('/api/logout',                 'POST', auth.handleLogout,             { auth:'none' });
    publicRouter.register('/api/machine-code',            'GET',  machines.handleGetMachineCode, { auth:'none' });
    publicRouter.register('/api/edge/heartbeat', 'POST', edge.handleHeartbeat, { auth:'none', body:true });
    publicRouter.register('/api/edge/offline', 'POST', edge.handleOffline, { auth:'none', body:true });
    publicRouter.registerPattern(/^\/api\/sn-registry\/([^/]+)\/status$/,  'GET', snRegistry.handleGetSNStatus,        { auth:'none' });
    publicRouter.registerPattern(/^\/api\/sn-registry\/([^/]+)\/history$/, 'GET', snRegistry.handleGetSNStatusHistory, { auth:'none' });
    publicRouter.register('/api/mobile/auth', 'POST', auth.handleMobileAuth, {
      auth:'none', body:true,
      validate: { body: {
        username: { type:'string', required:true, max:64, regex:/^[^\s]{1,64}$/, regexMsg:'用户名不能含空白且不超过64字符' },
        password: { type:'string', required:true, max:128 },
      } }
    });
    publicRouter.register('/api/mobile/machines',         'GET',  machines.handleMobileGetMachines, { auth:'none' });
    publicRouter.registerPattern(/^\/api\/machines\/([^/]+)\/status$/, 'GET', machines.handleGetMachineStatus, { auth:'none' });
    publicRouter.registerPattern(/^\/api\/location-status\/([^/]+)$/, 'GET', storageLocations.handleGetPublicLocationStatus, { auth:'none' });
    publicRouter.registerPattern(/^\/api\/qr-code\/([^/]+)$/, 'GET', snRegistry.handleGenerateQRCode, { auth:'none' });

    // OTA Update: app checks this endpoint at startup for version comparison
    publicRouter.register('/api/app/latest-version', 'GET', (req, res) => {
      sendJSON(res, { versionCode: 11, versionName: '1.0.11', apkUrl: '/apk/GMS-release.apk' });
    }, { auth: 'none' });

    // ---- authRouter: routes dispatched AFTER requireAuth — Inventory ----
    authRouter.register('/api/inventory',               'GET',  inventory.handleGetAllInventory,       { auth:'required' });
    // Phase 1 企业级基座：仓库 / 角色 / 库存审计
    authRouter.register('/api/warehouses',              'GET',  warehousesDomain.handleGetAll,          { auth:'required' });
    authRouter.register('/api/warehouses',              'POST', warehousesDomain.handleCreate,         { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/warehouses\/([^/]+)$/, 'PUT',    warehousesDomain.handleUpdate,  { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/warehouses\/([^/]+)$/, 'DELETE', warehousesDomain.handleDelete,  { auth:'required' });
    authRouter.register('/api/inventory-audit',         'GET',  warehousesDomain.handleGetAuditLog,     { auth:'required' });
    authRouter.register('/api/permissions',             'GET',  rbacRoles.handleGetPermissions,         { auth:'required' });
    authRouter.register('/api/roles',                   'GET',  rbacRoles.handleGetRoles,               { auth:'required' });
    authRouter.register('/api/roles',                   'POST', rbacRoles.handleCreateRole,             { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/roles\/([^/]+)$/,      'PUT',    rbacRoles.handleUpdateRole,     { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/roles\/([^/]+)$/,      'DELETE', rbacRoles.handleDeleteRole,     { auth:'required' });
    authRouter.register('/api/inventory/transfer', 'POST', inventory.handleTransferInventory, {
      auth:'required', body:true,
      validate: { body: {
        invType:    { type:'string', required:true, max:64 },
        quantity:   { type:'number', required:true, min:1, max:10000, int:true, coerce:true },
        destination:{ type:'string', required:true, max:128 },
        note:       { type:'string', max:500 },
      } }
    });
    authRouter.register('/api/inventory/transfer-stats','GET',  inventory.handleGetTransferStats,     { auth:'required' });
    authRouter.registerPattern(/^\/api\/inventory\/(.+)$/, 'GET',  inventory.handleGetInventory,     { auth:'required' });
    authRouter.registerPattern(/^\/api\/inventory\/(.+)$/, 'POST', inventory.handleAdjustInventory, { auth:'required', body:true,
      validate: { body: { delta: { type:'number', required:true, coerce:true }, note: { type:'string', max:500 }, warehouseId: { type:'string', max:64 }, batchId: { type:'string', max:64 }, expiryDate: { type:'string', max:10 } } }
    });
    // Phase 2：批次 + 跨仓库调拨
    authRouter.register('/api/batches',                    'GET',  batchesDomain.handleGetBatches,          { auth:'required' });
    authRouter.register('/api/warehouse-transfers',        'GET',  warehouseTransfers.handleList,           { auth:'required' });
    authRouter.register('/api/warehouse-transfers',        'POST', warehouseTransfers.handleCreate,         { auth:'required', body:true,
      validate: { body: {
        invType:       { type:'string', required:true, max:64 },
        fromWarehouse: { type:'string', required:true, max:64 },
        toWarehouse:   { type:'string', required:true, max:64 },
        quantity:      { type:'number', required:true, min:1, max:100000, int:true, coerce:true },
        note:          { type:'string', max:500 },
      } }
    });
    authRouter.registerPattern(/^\/api\/warehouse-transfers\/([^/]+)\/approve$/, 'POST', warehouseTransfers.handleApprove, { auth:'required' });
    authRouter.registerPattern(/^\/api\/warehouse-transfers\/([^/]+)\/reject$/,  'POST', warehouseTransfers.handleReject,  { auth:'required', body:true,
      validate: { body: { note: { type:'string', max:500 } } }
    });

    // ---- authRouter — Machines ----
    authRouter.register('/api/machines',                'GET',  machines.handleGetMachines,            { auth:'required' });
    authRouter.register('/api/machines',                'POST', machines.handleAddMachine,            { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/machines\/(.+)$/, 'DELETE', machines.handleDeleteMachine,    { auth:'required' });
    authRouter.register('/api/machine-bindings',        'GET',  machines.handleGetMachineBindings,    { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/bind$/,       'POST', machines.handleBindMachine,       { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/unbind$/,     'POST', machines.handleUnbindMachine,     { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/sync-state$/,  'POST', machines.handleSyncMachineState,  { auth:'required', body:true });
    // 机器生产状态：人工切换（可生产/在生产/在测试；待维修由工单驱动）+ 变更记录查询
    authRouter.register('/api/machines/production-status',  'POST', machines.handleSetProductionStatus,  { auth:'required', body:true });
    authRouter.register('/api/machines/production-history', 'GET',  machines.handleGetProductionHistory, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/status-timeline$/, 'GET', machines.handleGetStatusTimeline, { auth:'required' });
    // 机器综合信息（采集器系统健康/任务/活动状态，szx3-* 机器）
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/info$/, 'GET', machines.handleGetMachineInfo, { auth:'required' });
    // 运营端机器状态中心：登录、任务、Hermes、处理队列、上传及全天会话聚合
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/operations-center$/, 'GET', machines.handleGetOperationsCenter, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/live$/, 'GET', machines.handleGetMachineLive, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/stop-collector$/, 'POST', machines.handleStopCollector, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/stop-exodus$/, 'POST', machines.handleStopExodus, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/fix-quest$/, 'POST', machines.handleFixQuest, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/quest-control$/, 'POST', machines.handleQuestControl, { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/diagnose-hands$/, 'POST', machines.handleDiagnoseHands, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/diagnose-progress$/, 'GET', machines.handleDiagnoseProgress, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/machine-config$/, 'GET', machines.handleMachineConfig, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/probe$/, 'POST', machines.handleMachineProbe, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/machine-commands$/, 'GET', machines.handleMachineCommands, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/machine-command$/, 'POST', machines.handleMachineCommand, { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/arm-control$/, 'POST', machines.handleArmControl, { auth:'required', body:true });
    authRouter.register('/api/edge/hosts', 'GET', machines.handleListAgentHosts, { auth:'required' });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/shift-inspection$/,   'POST', handleSaveShiftInspection,   { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/machines\/([^/]+)\/shift-inspections$/,  'GET',  handleGetShiftInspections,   { auth:'required' });
    authRouter.register('/api/shift-inspections/today',  'GET',  handleTodayShiftInspections,      { auth:'required' });

    // ---- authRouter — Transactions ----
    authRouter.register('/api/transactions',            'GET',  transactions.handleGetTransactions,    { auth:'required' });
    authRouter.register('/api/transactions',            'POST', transactions.handleAddTransaction,    { auth:'required', body:true });

    // ---- authRouter — Users ----
    authRouter.register('/api/users',                   'GET',  users.handleGetUsers,                 { auth:'required' });
    authRouter.register('/api/users', 'POST', users.handleAddUser, {
      auth:'required', body:true,
      validate: { body: {
        username:   { type:'string', required:true, max:64, regex:/^[^\s]{1,64}$/, regexMsg:'用户名不能含空白且不超过64字符' },
        password:   { type:'string', required:true, min:6, max:128 },
        role:       { type:'string', enum:['user','admin'] },   // superadmin blocked in handler
        system:     { type:'string', enum:['maintenance','operations'] },
        displayName:{ type:'string', max:64 },
      } }
    });
    authRouter.registerPattern(/^\/api\/users\/([^/]+)$/, 'POST', users.handleUpdateUser, { auth:'required', body:true,
      validate: { body: {
        username: { type:'string', required:true, max:64, regex:/^[^\s]{1,64}$/, regexMsg:'用户名不能含空白且不超过64字符' },
        password: { type:'string', min:6, max:128 },  // optional
      } }
    });
    authRouter.registerPattern(/^\/api\/users\/([^/]+)$/, 'DELETE', users.handleDeleteUser, { auth:'required' });
    authRouter.registerPattern(/^\/api\/users\/([^/]+)\/password$/,           'GET',  users.handleGetUserPassword,     { auth:'required' });
    authRouter.register('/api/online-users',            'GET',  users.handleGetOnlineUsers,            { auth:'required' });
    // S5.3: /api/logout moved to publicRouter (see above) so it clears the cookie
    // even when the session is expired. The auth:'required' version is removed.
    authRouter.registerPattern(/^\/api\/force-logout\/(.+)$/,                 'POST', users.handleForceLogout,         { auth:'required' });
    authRouter.register('/api/users/subordinates',      'GET',  users.handleGetSubordinates,          { auth:'required' });
    authRouter.registerPattern(/^\/api\/users\/([^/]+)\/promote$/,            'POST', users.handlePromoteUser,         { auth:'required' });
    authRouter.registerPattern(/^\/api\/users\/([^/]+)\/toggle-status$/,      'POST', users.handleToggleUserStatus,    { auth:'required' });
    authRouter.registerPattern(/^\/api\/users\/([^/]+)\/reset-password$/,     'POST', auth.handleResetPassword,        { auth:'required', body:true,
      validate: { body: { newPassword: { type:'string', required:true, min:6, max:128, regex:/[A-Za-z]/, regexMsg:'新密码需包含字母' } } }
    });
    authRouter.register('/api/change-password', 'POST', auth.handleChangePassword, { auth:'required', body:true,
      validate: { body: {
        oldPassword: { type:'string', required:true, max:128 },
        newPassword: { type:'string', required:true, min:6, max:128, regex:/[A-Za-z]/, regexMsg:'新密码需包含字母' },
      } }
    });

    // ---- authRouter — Personal Center (profile, activity) ----
    authRouter.register('/api/me',     'GET',  users.handleGetMyProfile,    { auth:'required' });
    authRouter.register('/api/me',     'PUT',  users.handleUpdateMyProfile, { auth:'required', body:true,
      validate: { body: {
        displayName: { type:'string', max:64 },
        email:       { type:'string', max:128, regex:/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, regexMsg:'邮箱格式无效' },
        phone:       { type:'string', max:32 },
        department:  { type:'string', max:64 },
      } }
    });
    authRouter.register('/api/my-activity', 'GET', users.handleGetMyActivity, { auth:'required' });

    // ---- authRouter — Tech Support ----
    authRouter.register('/api/tech-support',            'GET',  techSupport.handleGetTechSupportList,  { auth:'required' });
    authRouter.register('/api/tech-support',            'POST', techSupport.handleSubmitTechSupport,  { auth:'required', body:true });
    authRouter.register('/api/tech-support/repair-results','GET',techSupport.handleGetRepairResults,   { auth:'required' });
    authRouter.register('/api/tech-support/my-history',   'GET',  techSupport.handleGetMySubmitHistory,{ auth:'required' });
    // 常见故障模板（运营共享）：静态路由优先于下方 ([^/]+) 详情正则
    authRouter.register('/api/tech-support/common-faults',        'GET',    techSupport.handleListCommonFaults,   { auth:'required' });
    authRouter.register('/api/tech-support/common-faults',        'POST',   techSupport.handleAddCommonFault,    { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/tech-support\/common-faults\/([^/]+)$/, 'DELETE', techSupport.handleDeleteCommonFault, { auth:'required' });
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)$/,              'GET',    techSupport.handleGetTechSupportDetail,  { auth:'required' });
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)\/respond$/,     'POST',   techSupport.handleRespondTechSupport,    { auth:'required' });
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)\/complete$/,    'POST',   techSupport.handleCompleteTechSupport,   { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)$/,              'DELETE', techSupport.handleDeleteTechSupport,     { auth:'required' });
    authRouter.register('/api/export/tech-support-xlsx','GET',  techSupport.handleExportTechSupportXLSX,{ auth:'required' });

    // ---- authRouter — Solutions (解决方案跟踪) ----
    authRouter.register('/api/solutions',            'GET',  solutions.handleList,   { auth:'required' });
    authRouter.register('/api/solutions',            'POST', solutions.handleCreate, { auth:'required', body:true });
    authRouter.register('/api/solutions/stats',      'GET',  solutions.handleStats,  { auth:'required' });
    authRouter.registerPattern(/^\/api\/solutions\/([^/]+)$/, 'GET',    solutions.handleGet,    { auth:'required' });
    authRouter.registerPattern(/^\/api\/solutions\/([^/]+)$/, 'PUT',    solutions.handleUpdate, { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/solutions\/([^/]+)$/, 'DELETE', solutions.handleDelete, { auth:'required' });
    // 解决方案与技术支持工单关联
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)\/solutions$/,          'GET',  solutions.handleGetLinked, { auth:'required' });
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)\/solutions$/,          'POST', solutions.handleLink,      { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/tech-support\/([^/]+)\/solutions\/([^/]+)$/, 'DELETE', solutions.handleUnlink,  { auth:'required' });

    // ---- authRouter — Chat (帮助中心实时聊天) ----
    authRouter.register('/api/chat/send',              'POST', chat.handleSendMessage, { auth:'required', body:true });
    authRouter.register('/api/chat/history',           'GET',  chat.handleGetHistory,  { auth:'required' });
    authRouter.register('/api/chat/unread',            'GET',  chat.handleGetUnread,   { auth:'required' });
    authRouter.register('/api/chat/conversations',    'GET',  chat.handleGetConversations, { auth:'required' });
    authRouter.register('/api/chat/mark-read',         'POST', chat.handleMarkRead,          { auth:'required', body:true });
    authRouter.register('/api/chat/helpdesk',         'GET',  chat.handleGetHelpdesk,      { auth:'required' });
    authRouter.register('/api/sop',                   'GET',  sop.handleList,              { auth:'required' });
    authRouter.register('/api/sop',                   'POST', sop.handleCreate,            { auth:'required', body:true });
    authRouter.register('/api/sop/delete',            'POST', sop.handleDelete,            { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/sop\/serve\/(.+)$/, 'GET', sop.handleServeFile,  { auth:'required' });

    // ---- authRouter — SN Registry ----
    authRouter.register('/api/sn-registry',             'GET',  snRegistry.handleGetSNRegistry,        { auth:'required' });
    authRouter.register('/api/sn-registry', 'POST', snRegistry.handleUpsertSNRegistry, {
      auth:'required', body:true,
      validate: { body: {
        snCode:        { type:'string', required:true, max:128, regex:/^[A-Za-z0-9_-]+$/, regexMsg:'SN码只能含字母、数字、下划线、短横线' },
        equipmentType: { type:'string', max:64 },
        handType:      { type:'string', enum:['left','right',''] },
        status:        { type:'string', enum:['available','in_use','damaged','in_repair','transferred','repaired','shipped','scrapped'] },
        machineNumber: { type:'string', max:64 },
        trackingNumber:{ type:'string', max:128 },
        damageReason:  { type:'string', max:1000 },
        location_code: { type:'string', max:64 },
      } }
    });
    authRouter.register('/api/sn-registry/batch-insert','POST', snRegistry.handleBatchInsertSNRegistry,{ auth:'required', body:true });
    authRouter.register('/api/sn-registry/delete-full', 'POST', snRegistry.handleDeleteSNFull,         { auth:'required', body:true });
    authRouter.register('/api/sn-registry/ship', 'POST', snRegistry.handleShipSN, {
      auth:'required', body:true,
      validate: { body: {
        snCode:        { type:'string', required:true, max:128, regex:/^[A-Za-z0-9_-]+$/, regexMsg:'SN码只能含字母、数字、下划线、短横线' },
        trackingNumber:{ type:'string', required:true, max:128 },
        manufacturer:  { type:'string', max:128 },
      } }
    });
    authRouter.register('/api/sn-registry/repair-complete', 'POST', snRegistry.handleRepairCompleteSN, {
      auth:'required', body:true,
      validate: { body: {
        snCode:  { type:'string', required:true, max:128, regex:/^[A-Za-z0-9_-]+$/, regexMsg:'SN码只能含字母、数字、下划线、短横线' },
        supplier:{ type:'string', max:128 },
      } }
    });
    authRouter.registerPattern(/^\/api\/sn-registry\/([^/]+)$/, 'DELETE', snRegistry.handleDeleteSNRegistry, { auth:'required' });
    authRouter.register('/api/sn-status-change', 'POST', snRegistry.handleSNStatusChange, {
      auth:'required', body:true,
      validate: { body: {
        snCode:        { type:'string', required:true, max:128, regex:/^[A-Za-z0-9_-]+$/, regexMsg:'SN码只能含字母、数字、下划线、短横线' },
        newStatus:     { type:'string', required:true, enum:['available','in_use','damaged','in_repair','transferred','repaired','shipped','scrapped'] },
        reason:        { type:'string', max:1000 },
        machineNumber: { type:'string', max:64 },
        trackingNumber:{ type:'string', max:128 },
      } }
    });
    authRouter.register('/api/sync-inventory',          'POST', inventory.handleSyncInventoryNow,      { auth:'required' });

    // ===== Phase 2.2: remaining routes migrated from if-chain =====
    // Audit Log
    authRouter.register('/api/audit-log',                 'GET',  handleGetAuditLog,                   { auth:'required' });
    // Settings
    authRouter.register('/api/settings',                  'GET',  handleGetSettings,                   { auth:'required' });
    authRouter.register('/api/settings',                  'POST', handleSaveSettings,                  { auth:'required', body:true });
    // Popup Messages
    authRouter.register('/api/popup-messages',            'GET',  handleGetPopupMessages,              { auth:'required' });
    authRouter.register('/api/popup-messages/random',     'GET',  handleGetRandomPopupMessage,         { auth:'required' });
    authRouter.register('/api/popup-messages',            'POST', handleAddPopupMessage,               { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/popup-messages\/([^/]+)$/, 'DELETE', handleDeletePopupMessage,  { auth:'required' });
    // Group Transfers
    authRouter.register('/api/group/transfers',           'GET',  handleGetGroupTransfers,             { auth:'required' });
    authRouter.register('/api/group/members',             'GET',  handleGetGroupMembers,               { auth:'required' });
    authRouter.register('/api/team/member-repair-stats',  'GET',  handleGetMemberRepairStats,          { auth:'required' });
    authRouter.register('/api/group/transfer',            'POST', handleCreateGroupTransfer,           { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/group\/transfer\/([^/]+)\/approve$/, 'POST', handleApproveGroupTransfer, { auth:'required' });
    authRouter.registerPattern(/^\/api\/group\/transfer\/([^/]+)\/reject$/,  'POST', handleRejectGroupTransfer,  { auth:'required' });
    authRouter.registerPattern(/^\/api\/group\/transfer\/([^/]+)\/cancel$/,  'POST', handleCancelGroupTransfer,  { auth:'required' });
    // Equipment Config
    authRouter.register('/api/equipment-config',          'GET',  configuration.handleGetEquipmentConfig,            { auth:'required' });
    authRouter.register('/api/equipment-config',          'POST', configuration.handleSaveEquipmentConfig,           { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/equipment-config\/(.+)$/, 'DELETE', configuration.handleDeleteEquipmentConfig, { auth:'required' });
    // Inventory Config
    authRouter.register('/api/inventory-config',          'GET',  configuration.handleGetInventoryConfig,            { auth:'required' });
    authRouter.register('/api/inventory-config',          'POST', configuration.handleSaveInventoryConfig,           { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/inventory-config\/(.+)$/, 'DELETE', configuration.handleDeleteInventoryConfig, { auth:'required' });
    // Inventory Config — 增量操作（动态添加/更新/导入物品库存，无需改代码/重部署）
    authRouter.register('/api/inventory-config/item', 'POST', configuration.handleAddInventoryConfigItem, {
      auth:'required', body:true,
      validate: { body: {
        name:          { type:'string', required:true, max:64 },
        sku:           { type:'string', required:true, max:64, regex:/^\S+$/, regexMsg:'SKU不能包含空白字符' },
        icon:          { type:'string', max:32 },
        hasLeftRight:  { type:'boolean', coerce:true },
        trackingMode:  { type:'string', enum:['sn','quantity'] },
      } }
    });
    authRouter.register('/api/inventory-config/import', 'POST', configuration.handleImportInventoryConfig, {
      auth:'required', body:true,
      validate: { body: {
        items: { type:'array', required:true, min:1, max:500, items:{
          name: { type:'string', required:true, max:64 },
          sku:  { type:'string', max:64 },
          icon: { type:'string', max:32 },
          hasLeftRight: { type:'boolean', coerce:true },
          trackingMode: { type:'string', enum:['sn','quantity'] },
        }},
      } }
    });
    authRouter.registerPattern(/^\/api\/inventory-config\/item\/([^/]+)$/, 'PUT', configuration.handleUpdateInventoryConfigItem, {
      auth:'required', body:true,
      validate: { body: {
        name:          { type:'string', required:true, max:64 },
        sku:           { type:'string', max:64 },
        icon:          { type:'string', max:32 },
        hasLeftRight:  { type:'boolean', coerce:true },
        trackingMode:  { type:'string', enum:['sn','quantity'] },
      } }
    });
    // Inventory Alerts
    authRouter.register('/api/inventory-alerts',          'GET',  handleGetInventoryAlerts,            { auth:'required' });
    authRouter.register('/api/inventory-alerts',          'POST', handleSetInventoryAlert,             { auth:'required', body:true });
    // Stocktakes（盘点单：创建快照/录入/完成差异调整/历史）
    authRouter.register('/api/stocktakes',                'POST', stocktakes.handleCreateStocktake,    { auth:'required', body:true });
    authRouter.register('/api/stocktakes',                'GET',  stocktakes.handleListStocktakes,     { auth:'required' });
    authRouter.registerPattern(/^\/api\/stocktakes\/([^/]+)$/, 'GET', stocktakes.handleGetStocktake,   { auth:'required' });
    authRouter.registerPattern(/^\/api\/stocktakes\/([^/]+)$/, 'PUT', stocktakes.handleSaveStocktake,  { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/stocktakes\/([^/]+)\/complete$/, 'POST', stocktakes.handleCompleteStocktake, { auth:'required' });
    authRouter.registerPattern(/^\/api\/stocktakes\/([^/]+)$/, 'DELETE', stocktakes.handleCancelStocktake, { auth:'required' });
    // Stocktaking
    authRouter.register('/api/stocktaking',               'GET',  handleGetStocktaking,                { auth:'required' });
    authRouter.register('/api/stocktaking',               'POST', handleStocktaking,                   { auth:'required', body:true });
    // Inbound Orders
    authRouter.register('/api/inbound-orders',            'GET',  handleGetInboundOrders,              { auth:'required' });
    authRouter.register('/api/inbound-orders',            'POST', handleCreateInboundOrder,            { auth:'required', body:true });
    // Outbound Orders
    authRouter.register('/api/outbound-orders',           'GET',  handleGetOutboundOrders,             { auth:'required' });
    authRouter.register('/api/outbound-orders',           'POST', handleCreateOutboundOrder,           { auth:'required', body:true });
    // Data integrity
    authRouter.register('/api/data-integrity',            'GET',  handleDataIntegrity,                 { auth:'required' });
    // Sync (polling fallback)
    authRouter.register('/api/sync',                      'GET',  handleSync,                          { auth:'required' });
    // CSRF Token
    authRouter.register('/api/csrf-token',                'GET',  handleGetCSRFToken,                  { auth:'required' });
    // PWA Web Push
    authRouter.register('/api/vapid-public-key',          'GET',  push.handleGetVapidPublicKey,         { auth:'required' });
    authRouter.register('/api/push/subscribe',            'POST', push.handlePushSubscribe,             { auth:'required', body:true });
    authRouter.register('/api/push/unsubscribe',          'POST', push.handlePushUnsubscribe,           { auth:'required', body:true });
    authRouter.register('/api/push/test',                 'POST', push.handlePushTest,                  { auth:'required', body:true });
    // Last backup
    authRouter.register('/api/last-backup',               'GET',  handleLastBackup,                    { auth:'required' });
    // Excel export
    authRouter.register('/api/export/xlsx',               'GET',  handleExportXLSX,                    { auth:'required' });
    authRouter.register('/api/export/sn-links-xlsx',      'GET',  snRegistry.handleExportSNLinksXLSX,  { auth:'required' });
    // Full export (ZIP with images)
    authRouter.register('/api/export/full',               'GET',  handleExportFull,                    { auth:'required' });
    // Full import (ZIP with images)
    authRouter.register('/api/import/full',               'POST', handleImportFull,                    { auth:'required', body:true });
    // Clear all data (admin only)
    authRouter.register('/api/clear-all-data',            'POST', handleClearAllData,                  { auth:'required' });
    // File upload / delete
    authRouter.register('/api/upload',                    'POST', handleUpload,                        { auth:'required', body:true });
    authRouter.register('/api/delete-upload',             'POST', handleDeleteUpload,                  { auth:'required', body:true });
    // Operations (ops_orders, ops_customers, ops_production)
    authRouter.register('/api/ops-orders',                'GET',  (req, res, authUser) => handleGetOps(req, res, 'ops_orders'),       { auth:'required' });
    authRouter.register('/api/ops-orders',                'POST', (req, res, authUser, body) => handleSaveOps(req, res, 'ops_orders', body),       { auth:'required', body:true });
    authRouter.register('/api/ops-customers',             'GET',  (req, res, authUser) => handleGetOps(req, res, 'ops_customers'),    { auth:'required' });
    authRouter.register('/api/ops-customers',             'POST', (req, res, authUser, body) => handleSaveOps(req, res, 'ops_customers', body),    { auth:'required', body:true });
    authRouter.register('/api/ops-production',            'GET',  (req, res, authUser) => handleGetOps(req, res, 'ops_production'),   { auth:'required' });
    authRouter.register('/api/ops-production',            'POST', (req, res, authUser, body) => handleSaveOps(req, res, 'ops_production', body),   { auth:'required', body:true });
    // Weighted scores
    authRouter.register('/api/weighted-scores',           'POST', handleSaveWeightedScore,              { auth:'required', body:true });
    authRouter.register('/api/weighted-scores/ranking',   'GET',  handleGetWeightedRanking,            { auth:'required' });
    authRouter.register('/api/weighted-scores/employees', 'GET',  handleGetWeightedScoreEmployees,     { auth:'required' });
    authRouter.register('/api/weighted-scores/day',       'GET',  handleGetDayWeightedScores,          { auth:'required' });
    authRouter.register('/api/weighted-scores/month',     'GET',  handleGetMonthWeightedScores,        { auth:'required' });
    authRouter.register('/api/weighted-scores/batch',     'POST', handleBatchImportScores,             { auth:'required', body:true });

    // Agent (智能助手) — 已注释
    // authRouter.register('/api/agent/chat',               'POST', agent.handleAgentChat,               { auth:'required', body:true });

    // ---- authRouter — Replacement (手套置换库存) ----
    authRouter.register('/api/replacement/add',    'POST', replacement.handleAddReplacement,    { auth:'required', body:true });
    authRouter.register('/api/replacement/return', 'POST', replacement.handleReturnReplacement, { auth:'required', body:true });
    authRouter.register('/api/replacement/ship',   'POST', replacement.handleShipReplacement,   { auth:'required', body:true });
    authRouter.register('/api/replacement/list',   'GET',  replacement.handleListReplacements,  { auth:'required' });
    authRouter.register('/api/replacement/batch-add-by-source', 'POST', replacement.handleBatchAddReplacementBySource, { auth:'required', body:true });

    // ---- authRouter — Delivery Notes (发货单) ----
    authRouter.register('/api/delivery-notes/save', 'POST', handleSaveDeliveryNote, { auth:'required', body:true });
    authRouter.register('/api/delivery-notes/list', 'GET',  handleListDeliveryNotes, { auth:'required' });
    authRouter.registerPattern(/^\/api\/delivery-notes\/([^/]+)$/, 'GET',    handleGetDeliveryNote,    { auth:'required' });
    authRouter.registerPattern(/^\/api\/delivery-notes\/([^/]+)$/, 'PUT',   handleUpdateDeliveryNote, { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/delivery-notes\/([^/]+)$/, 'DELETE', handleDeleteDeliveryNote, { auth:'required' });

    // Server Dashboard (服务器看板)
    authRouter.register('/api/server-status', 'GET', handleServerStatus, { auth:'required' });

    // Storage Locations (库位管理)
    authRouter.register('/api/storage-locations', 'GET',  storageLocations.handleGetAll, { auth:'required' });
    authRouter.register('/api/storage-locations', 'POST', storageLocations.handleCreate, { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/storage-locations\/([^/]+)$/, 'PUT', storageLocations.handleUpdate, { auth:'required', body:true });
    authRouter.registerPattern(/^\/api\/storage-locations\/([^/]+)$/, 'DELETE', storageLocations.handleDelete, { auth:'required' });
    authRouter.registerPattern(/^\/api\/storage-locations\/([^/]+)\/sns$/, 'GET', storageLocations.handleGetLocationSNs, { auth:'required' });

    const pr = publicRouter.size(), ar = authRouter.size();
    console.log(`[Router] public:${pr.total} (static:${pr.static}/pattern:${pr.pattern}) + auth:${ar.total} (static:${ar.static}/pattern:${ar.pattern}) = ${pr.total + ar.total} routes registered`);


    await migrateDB();
    await migrateFromJSON();
    await seedDefaults();
    // Sync inventory from sn_registry to fix any existing inconsistencies
    try {
      await _syncInventoryFromSN(pool);
      console.log('[DB] Inventory synced from sn_registry');
    } catch (e) {
      console.error('[DB] Inventory sync failed:', e.message);
    }
    console.log('[DB] Database initialized successfully');

    // Init realtime engine (WebSocket + SSE 双通道)
    // S5.2: inject validateToken so WebSocket connections can authenticate via
    // HttpOnly cookie (design A — web path) at handshake time, without looping
    // back through /api/auth/verify.
    realtime.init(server, { isConnected: () => redisClient && redisClient.isReady, subscribe: async (ch, fn) => { if (redisSub) await redisSub.subscribe(ch, fn); }, SSE_CHANNEL: 'sse:all' }, { validateToken });

    // Agent WebSocket fast channel: collector snapshots are pushed every few
    // seconds and served from the in-memory edge-live cache.
    const { WebSocketServer } = require('ws');
    const edgeLive = require('./src/edge-live');
    const edgeWss = new WebSocketServer({ server, path: '/api/edge/ws' });
    edgeWss.on('connection', (ws, req) => {
      const u = new URL(req.url, 'http://localhost');
      const token = u.searchParams.get('token') || '';
      const machineNumber = String(u.searchParams.get('machine') || '').trim().toLowerCase();
      if (!machineNumber || token !== (process.env.EDGE_TOKEN || '')) { ws.close(4001, 'unauthorized'); return; }
      edgeLive.markEdgeWsConnected(machineNumber, true);
      ws.on('message', raw => { try { const msg = JSON.parse(raw.toString()); if (msg.type === 'fast' && msg.data) edgeLive.setEdgeLive(machineNumber, msg.data); } catch {} });
      ws.on('close', () => edgeLive.markEdgeWsConnected(machineNumber, false));
    });

    // Feishu sync initialized lazily on first tech_support operation
  } catch (e) {
    console.error('[FATAL] Database initialization failed:', e.message);
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const workerId = process.env.pm_id || 'standalone';
    console.log(`\n🧤 手套管理系统服务器已启动 [Worker ${workerId}] (MySQL+Redis/Cluster)`);
    console.log(`   本地访问: http://localhost:${PORT}`);
    for (const [, addrs] of Object.entries(nets)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) console.log(`   局域网访问: http://${addr.address}:${PORT}`);
      }
    }
    console.log(`   数据库: MySQL ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    console.log('');

    // 预缓存静态文件，启动后运行时零同步阻塞
    precacheStaticFiles();
  });
}

// ==================== CRASH PREVENTION ====================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), `${new Date().toISOString()} ${err.message}\n${err.stack}\n\n`); } catch {}
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection (non-fatal):', reason?.message || reason);
  // Do NOT crash — unhandled rejections are often transient (e.g., pool connection reset)
  // Log it for debugging but keep the server running
});

let shuttingDown = false;
let memoryCleanupTimer = null;
let techSupportCleanupTimer = null;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (memoryCleanupTimer) clearTimeout(memoryCleanupTimer);
  if (techSupportCleanupTimer) clearTimeout(techSupportCleanupTimer);
  console.log(`\n[SHUTDOWN] Received ${signal}, shutting down gracefully...`);
  const allSSE = realtime.getSSEClients();
  allSSE.forEach(res => { try { res.end(); } catch {} });
  allSSE.clear();
  try { await pool.end(); console.log('[SHUTDOWN] MySQL pool closed.'); } catch {}
  try { if (redisClient) { await redisClient.quit(); console.log('[SHUTDOWN] Redis closed.'); } } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Server error handling
server.on('error', (err) => {
  console.error('[SERVER ERROR]', err.message);
  if (err.code === 'EADDRINUSE') { console.error('Port in use, retrying in 5s...'); setTimeout(() => process.exit(1), 5000); }
});

server.timeout = 5 * 60 * 1000;
server.keepAliveTimeout = 120 * 1000;
server.maxConnections = 500;

// ==================== PERIODIC MAINTENANCE ====================
// SSE cleanup every 2 min — clean zombie connections promptly (mobile network drops)
setInterval(() => {
  let deadCount = 0;
  sseClients.forEach(res => {
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) { sseClients.delete(res); deadCount++; }
  });
  if (deadCount > 0) console.log(`[MAINT] Cleaned ${deadCount} dead SSE connections (remaining: ${sseClients.size})`);
}, 2 * 60 * 1000);

// ==================== DAILY TECH SUPPORT CLEANUP ====================
// 仅保留上海时区的今天和昨天；无有效提交时间的脏记录也一并清理。
function getShanghaiYesterdayStartUTC() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = {};
  parts.forEach(part => { if (part.type !== 'literal') values[part.type] = Number(part.value); });
  const yesterdayUTCDate = Date.UTC(values.year, values.month - 1, values.day) - (24 * 60 * 60 * 1000);
  // Asia/Shanghai is UTC+08:00 and has no DST transitions.
  return new Date(yesterdayUTCDate - (8 * 60 * 60 * 1000)).toISOString();
}

async function cleanupOldTechSupport() {
  if (!pool) return;
  const cutoff = getShanghaiYesterdayStartUTC();
  try {
    const [result] = await pool.execute(
      `DELETE FROM tech_support
       WHERE COALESCE(submitted_ts, JSON_UNQUOTE(JSON_EXTRACT(data, '$.submittedAt'))) < ?
          OR COALESCE(submitted_ts, JSON_UNQUOTE(JSON_EXTRACT(data, '$.submittedAt'))) IS NULL
          OR COALESCE(submitted_ts, JSON_UNQUOTE(JSON_EXTRACT(data, '$.submittedAt'))) = ?`,
      [cutoff, '']
    );
    const deleted = result.affectedRows || 0;
    // 每个 worker 都清理本地查询缓存，避免页面继续看到旧记录。
    _cache.delete('tech_support');
    if (deleted > 0) {
      console.log(`[TECH SUPPORT CLEANUP] Deleted ${deleted} records older than ${cutoff}`);
      broadcastChange('tech_support', ['machines'], { action: 'daily_cleanup', deleted });
    } else {
      console.log(`[TECH SUPPORT CLEANUP] No records older than ${cutoff}`);
    }
  } catch (e) {
    console.error('[TECH SUPPORT CLEANUP] Error:', e.message);
  }
}

// ==================== Server Dashboard API ====================
async function handleServerStatus(req, res, authUser) {
  try {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const procMem = process.memoryUsage();
    const uptime = process.uptime();
    const sseCount = sseClients ? sseClients.size : 0;
    // Pool stats — use SHOW STATUS for accurate real-time connection count
    let poolActive = 0, poolIdle = 0, poolTotal = 0, poolPending = 0;
    try {
      const [statusRows] = await pool.execute("SHOW STATUS LIKE 'Threads_connected'");
      const threadsConnected = parseInt(statusRows[0]?.Value) || 0;
      poolTotal = threadsConnected;
      // Also get pool internal queue depth if accessible
      const innerPool = pool.pool || pool;
      poolActive = innerPool._acquiringConnections || 0;
      poolIdle = innerPool._idleConnections ? innerPool._idleConnections.length : 0;
      poolPending = innerPool._pendingQueue ? innerPool._pendingQueue.length : 0;
      // If poolTotal from Threads_connected is < pool._allConnections length, use the larger
      const allConns = (innerPool._allConnections || []).length;
      if (allConns > poolTotal) poolTotal = allConns;
    } catch {}
    // CPU usage % (1min average / cores)
    const cpuPct = Math.min(100, Math.round((loadAvg[0] / cpus.length) * 100));
    const memPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const procMemMB = Math.round(procMem.heapUsed / 1048576);
    const procMemTotalMB = Math.round(procMem.heapTotal / 1048576);
    sendJSON(res, {
      success: true,
      server: {
        version: SERVER_VERSION || 'unknown',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: Math.floor(uptime),
        startTime: new Date(Date.now() - uptime * 1000).toISOString(),
      },
      cpu: {
        cores: cpus.length,
        model: cpus[0] ? cpus[0].model.trim() : '',
        loadAvg1: loadAvg[0],
        loadAvg5: loadAvg[1],
        loadAvg15: loadAvg[2],
        usagePct: cpuPct,
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        usagePct: memPct,
        processHeapUsed: procMem.heapUsed,
        processHeapTotal: procMem.heapTotal,
        processHeapUsedMB: procMemMB,
        processHeapTotalMB: procMemTotalMB,
        rssMB: Math.round(procMem.rss / 1048576),
      },
      pool: {
        active: poolActive,
        idle: poolIdle,
        total: poolTotal,
        pending: poolPending,
        connectionLimit: 80,
      },
      sseClients: sseCount,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[ServerStatus] Error:', e.message);
    sendJSON(res, { error: '获取服务器状态失败' }, 500);
  }
}

// Health log every 2 hours
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[HEALTH] Memory: ${Math.round(mem.heapUsed / 1048576)}MB | SSE: ${sseClients.size} | Uptime: ${Math.round(process.uptime() / 3600)}h`);
}, 2 * 3600 * 1000);

// ==================== STATIC FILE CACHE ====================
const staticCache = new Map(); // path → { data, gzipped, contentType, ts }

function getStaticFile(filePath, contentType, cacheKey) {
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const cached = staticCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    const data = fs.readFileSync(filePath);
    const gzipped = zlib.gzipSync(data);
    const entry = { data, gzipped, contentType, ts: Date.now(), mtimeMs };
    staticCache.set(cacheKey, entry);
    return entry;
  } catch { return null; }
}

// ==================== DAILY MEMORY MAINTENANCE ====================
// 只释放可重建的进程内缓存和过期会话，不删除 MySQL、上传文件、离线消息，
// 也不执行 Redis FLUSH。每个 PM2 worker 都独立清理自己的 V8 堆。
function cleanupProcessMemory() {
  const before = process.memoryUsage();
  let expiredTokens = 0;
  Object.keys(tokens).forEach(token => {
    if (!tokens[token] || tokens[token].expires <= Date.now()) {
      delete tokens[token];
      expiredTokens++;
    }
  });

  const cacheEntries = _cache.size;
  _cache.clear();
  const staticEntries = staticCache.size;
  staticCache.clear();

  // 仅清理已断开的 SSE 响应；离线消息队列属于业务通知数据，不能删除。
  let deadSSE = 0;
  sseClients.forEach(res => {
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
      sseClients.delete(res);
      deadSSE++;
    }
  });

  if (typeof global.gc === 'function') global.gc();
  const after = process.memoryUsage();
  console.log(`[MEMORY MAINT] cache=${cacheEntries}->0 static=${staticEntries}->0 ` +
    `expiredTokens=${expiredTokens} deadSSE=${deadSSE} ` +
    `heap=${Math.round(before.heapUsed / 1048576)}MB->${Math.round(after.heapUsed / 1048576)}MB ` +
    `rss=${Math.round(before.rss / 1048576)}MB->${Math.round(after.rss / 1048576)}MB`);
}

function scheduleDailyMemoryCleanup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();
  memoryCleanupTimer = setTimeout(() => {
    try { cleanupProcessMemory(); } catch (e) { console.error('[MEMORY MAINT] Error:', e.message); }
    scheduleDailyMemoryCleanup();
  }, delay);
  console.log(`[MEMORY MAINT] Scheduled next cleanup at ${next.toISOString()}`);
}

scheduleDailyMemoryCleanup();

function scheduleDailyTechSupportCleanup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();
  techSupportCleanupTimer = setTimeout(async () => {
    await cleanupOldTechSupport();
    scheduleDailyTechSupportCleanup();
  }, delay);
  console.log(`[TECH SUPPORT CLEANUP] Scheduled next cleanup at ${next.toISOString()}`);
}

scheduleDailyTechSupportCleanup();

/** 启动时预缓存所有静态文件，运行时零同步阻塞 */
function precacheStaticFiles() {
  const dirs = ['/css/', '/js/', '/assets/'];
  const rootFiles = ['/index.html', '/mobile.html', '/mobile-ops.html', '/login.html'];
  const start = Date.now();
  let count = 0;
  const allFiles = [];
  // 收集所有 JS/CSS 文件
  for (const dir of dirs) {
    const absDir = path.join(__dirname, dir);
    try {
      const files = fs.readdirSync(absDir);
      for (const f of files) {
        if (f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.json') || f.endsWith('.svg')) {
          allFiles.push(dir + f);
        }
      }
    } catch {}
  }
  // 收集根目录 HTML
  for (const f of rootFiles) {
    const absPath = path.join(__dirname, f);
    try { if (fs.statSync(absPath).isFile()) allFiles.push(f); } catch {}
  }
  // 预缓存
  for (const relPath of allFiles) {
    const absPath = path.join(__dirname, relPath);
    const ext = path.extname(relPath);
    const contentType = MIME_TYPES[ext];
    if (contentType && getStaticFile(absPath, contentType, absPath)) count++;
  }
  console.log(`[CACHE] Pre-cached ${count} static files in ${Date.now() - start}ms`);
}

// Start the server (single process — SSE broadcasting requires shared memory)
startup();
