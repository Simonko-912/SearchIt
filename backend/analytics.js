const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const ANALYTICS_PATH = path.join(__dirname, 'data', 'analytics.db');

let analyticsDb = null;

function initAnalytics() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  analyticsDb = new sqlite3.Database(ANALYTICS_PATH);

  analyticsDb.serialize(() => {
    analyticsDb.run('PRAGMA journal_mode = WAL');

    // One row per event
    analyticsDb.run(`CREATE TABLE IF NOT EXISTS events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      type     TEXT    NOT NULL,  -- 'search', 'pageview', 'image_search'
      value    TEXT,              -- search query or page name
      ip_hash  TEXT,              -- SHA-256 of IP, never the raw IP
      ts       DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Daily rollup — pre-aggregated counts so admin queries stay fast
    analyticsDb.run(`CREATE TABLE IF NOT EXISTS daily_counts (
      day      TEXT NOT NULL,     -- YYYY-MM-DD
      type     TEXT NOT NULL,
      count    INTEGER DEFAULT 0,
      PRIMARY KEY (day, type)
    )`);

    // Top searches rollup
    analyticsDb.run(`CREATE TABLE IF NOT EXISTS top_queries (
      query    TEXT NOT NULL,
      count    INTEGER DEFAULT 0,
      last_seen DATETIME,
      PRIMARY KEY (query)
    )`);

    analyticsDb.run(`CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts)`);
    analyticsDb.run(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);

    // Auto-purge raw events older than 30 days (rollups are kept forever)
    analyticsDb.run(`DELETE FROM events WHERE ts < datetime('now','-30 days')`);
  });

  return analyticsDb;
}

// Hash IP for privacy — we never store the raw IP
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + 'scrapeit-salt').digest('hex').slice(0, 16);
}

// Record an event (fire-and-forget, never throws)
function track(type, value, rawIp) {
  if (!analyticsDb) return;
  const ipHash = rawIp ? hashIp(rawIp) : null;
  const day    = new Date().toISOString().slice(0, 10);

  // Insert raw event
  analyticsDb.run(
    `INSERT INTO events (type, value, ip_hash) VALUES (?, ?, ?)`,
    [type, value || null, ipHash],
    () => {}
  );

  // Increment daily rollup
  analyticsDb.run(
    `INSERT INTO daily_counts (day, type, count) VALUES (?, ?, 1)
     ON CONFLICT(day, type) DO UPDATE SET count = count + 1`,
    [day, type],
    () => {}
  );

  // Track top queries
  if (type === 'search' && value) {
    analyticsDb.run(
      `INSERT INTO top_queries (query, count, last_seen) VALUES (?, 1, datetime('now'))
       ON CONFLICT(query) DO UPDATE SET count = count + 1, last_seen = datetime('now')`,
      [value.toLowerCase().trim().slice(0, 200)],
      () => {}
    );
  }
}

// Get analytics summary for admin panel
function getAnalytics() {
  return new Promise((resolve, reject) => {
    if (!analyticsDb) return resolve({});

    const run = (sql, params=[]) => new Promise((res, rej) =>
      analyticsDb.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
    );
    const get = (sql, params=[]) => new Promise((res, rej) =>
      analyticsDb.get(sql, params, (err, row) => err ? rej(err) : res(row))
    );

    Promise.all([
      // Total counts all-time
      get(`SELECT COUNT(*) as total FROM events`),
      get(`SELECT COUNT(*) as total FROM events WHERE type='search'`),
      get(`SELECT COUNT(*) as total FROM events WHERE type='pageview'`),
      get(`SELECT COUNT(*) as total FROM events WHERE ts >= datetime('now','-24 hours')`),
      get(`SELECT COUNT(*) as total FROM events WHERE ts >= datetime('now','-7 days')`),
      // Unique visitors (by ip_hash) last 7 days
      get(`SELECT COUNT(DISTINCT ip_hash) as total FROM events WHERE ts >= datetime('now','-7 days') AND ip_hash IS NOT NULL`),
      // Daily counts last 30 days
      run(`SELECT day, type, count FROM daily_counts ORDER BY day DESC LIMIT 90`),
      // Top 20 searches
      run(`SELECT query, count, last_seen FROM top_queries ORDER BY count DESC LIMIT 20`),
      // Events per type today
      run(`SELECT type, COUNT(*) as count FROM events WHERE ts >= date('now') GROUP BY type`),
    ]).then(([total, searches, pageviews, today, week, uniqueVisitors, daily, topQueries, todayByType]) => {
      resolve({
        total:          total?.total || 0,
        totalSearches:  searches?.total || 0,
        totalPageviews: pageviews?.total || 0,
        today:          today?.total || 0,
        week:           week?.total || 0,
        uniqueVisitors: uniqueVisitors?.total || 0,
        daily,
        topQueries,
        todayByType,
      });
    }).catch(reject);
  });
}

module.exports = { initAnalytics, track, getAnalytics, ANALYTICS_PATH };
