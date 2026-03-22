const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'scrapeit.db');

function initDb() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const db = new sqlite3.Database(DB_PATH);

  // Helper: run a single statement synchronously-style via promise
  db.runAsync = (sql, params = []) => new Promise((res, rej) => {
    db.run(sql, params, function (err) {
      if (err) rej(err); else res({ lastID: this.lastID, changes: this.changes });
    });
  });

  db.getAsync = (sql, params = []) => new Promise((res, rej) => {
    db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); });
  });

  db.allAsync = (sql, params = []) => new Promise((res, rej) => {
    db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); });
  });

  // Synchronous exec for schema setup
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');

    db.run(`CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      title TEXT,
      description TEXT,
      favicon TEXT,
      keywords TEXT,
      og_image TEXT,
      lang TEXT,
      status TEXT DEFAULT 'pending',
      http_status INTEGER,
      error TEXT,
      scraped_at DATETIME,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_crawled DATETIME,
      crawl_depth INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      src TEXT NOT NULL,
      alt TEXT,
      title TEXT,
      width INTEGER,
      height INTEGER,
      site_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      found_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_url TEXT NOT NULL,
      to_url TEXT NOT NULL,
      anchor_text TEXT,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_url, to_url)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS crawl_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      domain TEXT,
      depth INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      priority INTEGER DEFAULT 0
    )`);
    // Add domain column if upgrading from older schema
    db.run(`ALTER TABLE crawl_queue ADD COLUMN domain TEXT`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_images_site_id ON images(site_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_crawl_queue_priority ON crawl_queue(priority DESC, id ASC)`);
  });

  return db;
}

module.exports = { initDb, DB_PATH };
