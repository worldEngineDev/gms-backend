'use strict';

const { Pool } = require('pg');

function createGalioClient() {
  if (String(process.env.GALIO_ENABLED || 'true').toLowerCase() === 'false') return null;
  const pool = new Pool({
    host: process.env.GALIO_DB_HOST || '127.0.0.1',
    port: Number(process.env.GALIO_DB_PORT || 5433),
    user: process.env.GALIO_DB_USER || 'galio',
    password: process.env.GALIO_DB_PASSWORD || 'galio',
    database: process.env.GALIO_DB_NAME || 'galio',
    max: 3,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (error) => console.warn('[Galio] PostgreSQL pool error:', error.message));
  return pool;
}

async function loadGalioStations(pool) {
  if (!pool) return {};
  const { rows } = await pool.query(`
    SELECT s.id, s.code, s.name, s.host, s.status AS configured_status,
           ss.status AS snapshot_status, ss.last_polled_at, ss.last_poll_status,
           ss.last_poll_error, ss.health, ss.active_ticket_count, ss.updated_at,
           COUNT(cr.id) FILTER (WHERE cr.conclusion = 'pass')::int AS checks_pass,
           COUNT(cr.id) FILTER (WHERE cr.conclusion = 'fail')::int AS checks_fail,
           COUNT(cr.id) FILTER (WHERE cr.conclusion IS NULL OR cr.conclusion = 'partial')::int AS checks_other
      FROM station s
      LEFT JOIN station_snapshot ss ON ss.station_id = s.id
      LEFT JOIN check_run cr ON cr.station_id = s.id
        AND cr.deleted_at IS NULL AND cr.started_at >= now() - interval '24 hours'
     WHERE s.deleted_at IS NULL
     GROUP BY s.id, ss.station_id
  `);
  return Object.fromEntries(rows.map((row) => [String(row.code).toLowerCase(), {
    stationId: row.id,
    code: row.code,
    name: row.name,
    host: row.host,
    configuredStatus: row.configured_status,
    snapshotStatus: row.snapshot_status,
    lastPolledAt: row.last_polled_at,
    lastPollStatus: row.last_poll_status,
    lastPollError: row.last_poll_error,
    health: row.health || {},
    activeTicketCount: row.active_ticket_count || 0,
    snapshotUpdatedAt: row.updated_at,
    checks24h: { pass: row.checks_pass || 0, fail: row.checks_fail || 0, other: row.checks_other || 0 },
  }]));
}

module.exports = { createGalioClient, loadGalioStations };
