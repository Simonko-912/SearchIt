const { fetchPage, parsePage, normalizeUrl, getDomain } = require('./scraper');

// ── Config ────────────────────────────────────────────────────────────────
const CONCURRENCY         = 8;   // parallel async fetches (8GB RAM = comfortable)
const TICK_MS             = 150;
const MAX_DEPTH           = 4;
const MAX_LINKS_PER_PAGE  = 60;  // cap links enqueued per page
const MAX_IMAGES_PER_PAGE = 50;  // cap images stored per page
const POOL_SIZE           = 40;  // candidate rows loaded per tick

const PRI_SEED    = 10000;
const PRI_DEPTH_1 = 500;
const PRI_DEPTH_2 = 200;
const PRI_DEPTH_3 = 80;
const PRI_DEPTH_4 = 20;

const DOMAIN_PENALTY_PER_PAGE = 5;
const UNIQUE_DOMAIN_BONUS     = 2000;

function basePriority(depth) {
  if (depth === 0) return PRI_SEED;
  if (depth === 1) return PRI_DEPTH_1;
  if (depth === 2) return PRI_DEPTH_2;
  if (depth === 3) return PRI_DEPTH_3;
  return PRI_DEPTH_4;
}

class Crawler {
  constructor(db) {
    this.db           = db;
    this.running      = false;
    this.paused       = false;
    this.activeTasks  = 0;
    this._interval    = null;
    this._activeDomains = new Set();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._interval = setInterval(() => this._tick(), TICK_MS);
    console.log('[Crawler] Started (concurrency=' + CONCURRENCY + ')');
  }

  stop() {
    this.running = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    console.log('[Crawler] Stopped');
  }

  pause()  { this.paused = true;  console.log('[Crawler] Paused');  }
  resume() { this.paused = false; console.log('[Crawler] Resumed'); }

  enqueue(url, depth = 0) {
    const domain   = this._domainOf(url);
    const priority = basePriority(depth);
    if (depth === 0) {
      // Manually added seed: always upsert with full seed priority,
      // even if the URL is already in the queue at a lower priority.
      this.db.run(
        `INSERT INTO crawl_queue (url, domain, depth, priority)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           priority = MAX(excluded.priority, priority),
           depth    = excluded.depth`,
        [url, domain, depth, priority], () => {}
      );
    } else {
      // Discovered link: only insert if not already queued.
      // Don't downgrade priority of something already queued higher.
      this.db.run(
        `INSERT INTO crawl_queue (url, domain, depth, priority)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           priority = MAX(excluded.priority, priority)`,
        [url, domain, depth, priority], () => {}
      );
    }
  }

  _tick() {
    if (this.paused || !this.running) return;
    const slots = CONCURRENCY - this.activeTasks;
    if (slots <= 0) return;

    const excDomains = [...this._activeDomains];
    const excClause  = excDomains.length
      ? `AND domain NOT IN (${excDomains.map(() => '?').join(',')})`
      : '';

    this.db.all(
      `SELECT id, url, depth, priority, COALESCE(domain,'') AS domain
       FROM crawl_queue
       WHERE 1=1 ${excClause}
       ORDER BY priority DESC, id ASC
       LIMIT ?`,
      [...excDomains, POOL_SIZE],
      (err, rows) => {
        if (err || !rows || rows.length === 0) return;
        this._pickAndDispatch(rows, slots);
      }
    );
  }

  async _pickAndDispatch(rows, slots) {
    // Get domain saturation counts for candidates only
    const domains = [...new Set(rows.map(r => r.domain).filter(Boolean))];
    const domainCounts = {};

    if (domains.length > 0) {
      const ph = domains.map(() => '?').join(',');
      const [indexed, queued] = await Promise.all([
        this.db.allAsync(
          `SELECT domain, COUNT(*) as c FROM sites WHERE domain IN (${ph}) AND status='done' GROUP BY domain`,
          domains
        ).catch(() => []),
        this.db.allAsync(
          `SELECT domain, COUNT(*) as c FROM crawl_queue WHERE domain IN (${ph}) GROUP BY domain`,
          domains
        ).catch(() => []),
      ]);
      for (const r of indexed) domainCounts[r.domain] = (domainCounts[r.domain] || 0) + r.c;
      for (const r of queued)  domainCounts[r.domain] = (domainCounts[r.domain] || 0) + r.c;
    }

    // Score and sort
    const scored = rows.map(row => {
      const count   = domainCounts[row.domain] || 0;
      const score   = row.priority - (count * DOMAIN_PENALTY_PER_PAGE) + (count === 0 ? UNIQUE_DOMAIN_BONUS : 0);
      return { ...row, score };
    }).sort((a, b) => b.score - a.score || a.id - b.id);

    // Pick one per domain up to slots
    const seenDomains = new Set(this._activeDomains);
    const chosen = [];
    for (const row of scored) {
      if (chosen.length >= slots) break;
      const dom = row.domain || this._domainOf(row.url);
      if (!dom || seenDomains.has(dom)) continue;
      seenDomains.add(dom);
      chosen.push(row);
    }
    // Top up if needed
    if (chosen.length < slots) {
      for (const row of scored) {
        if (chosen.length >= slots) break;
        if (!chosen.some(c => c.id === row.id)) chosen.push(row);
      }
    }

    for (const row of chosen) {
      this.db.run('DELETE FROM crawl_queue WHERE id = ?', [row.id]);
      const dom = row.domain || this._domainOf(row.url);
      if (dom) this._activeDomains.add(dom);
      this.activeTasks++;
      this._processUrl(row.url, row.depth)
        .catch(() => {})
        .finally(() => {
          this.activeTasks--;
          if (dom) this._activeDomains.delete(dom);
        });
    }
  }

  async _processUrl(url, depth) {
    const db = this.db;

    // Skip if crawled within 24h
    const existing = await db.getAsync('SELECT scraped_at FROM sites WHERE url=?', [url]);
    if (existing && existing.scraped_at) {
      if (Date.now() - new Date(existing.scraped_at).getTime() < 86400000) return;
    }

    const domain = getDomain(url);
    if (!domain) return;

    const now = new Date().toISOString();

    try {
      await db.runAsync(
        `INSERT INTO sites (url, domain, status, crawl_depth, last_crawled)
         VALUES (?, ?, 'crawling', ?, ?)
         ON CONFLICT(url) DO UPDATE SET status='crawling', last_crawled=excluded.last_crawled`,
        [url, domain, depth, now]
      );

      const { status, html, finalUrl, error } = await fetchPage(url);

      if (error || !html) {
        await db.runAsync(
          `UPDATE sites SET status='error', http_status=?, error=?, scraped_at=? WHERE url=?`,
          [status, error || 'No HTML', now, url]
        );
        console.log(`[Crawler] ✗ ${url} — ${error || 'no HTML'}`);
        return;
      }

      if (finalUrl && finalUrl !== url) {
        const norm = normalizeUrl(finalUrl, finalUrl);
        if (norm && norm !== url) this.enqueue(norm, depth);
      }

      // Parse — then immediately null out html to free memory
      const parsed = parsePage(html, finalUrl || url);

      await db.runAsync(
        `UPDATE sites SET
           title=?, description=?, keywords=?, lang=?,
           favicon=?, og_image=?,
           status='done', http_status=?, scraped_at=?, error=NULL
         WHERE url=?`,
        [parsed.title, parsed.description, parsed.keywords, parsed.lang,
         parsed.favicon, parsed.og_image, status, now, url]
      );

      // Store images — capped, one at a time, no large array retained
      const siteRow = await db.getAsync('SELECT id FROM sites WHERE url=?', [url]);
      if (siteRow) {
        const imgs = parsed.images.slice(0, MAX_IMAGES_PER_PAGE);
        for (const img of imgs) {
          await db.runAsync(
            `INSERT OR IGNORE INTO images (url, src, alt, title, width, height, site_id, site_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [img.src, img.src, img.alt, img.title, img.width, img.height, siteRow.id, url]
          ).catch(() => {});
        }
      }

      // Enqueue links — interleave same/cross domain, hard cap
      if (depth < MAX_DEPTH) {
        const ownDomain   = domain;
        const sameDomain  = [];
        const crossDomain = [];
        const seenUrls    = new Set();

        for (const link of parsed.links) {
          if (seenUrls.has(link.url)) continue;
          seenUrls.add(link.url);
          if (this._domainOf(link.url) === ownDomain) sameDomain.push(link.url);
          else crossDomain.push(link.url);
        }

        // Interleave same/cross so we explore new domains while still going deep
        const toProcess = [];
        for (let i = 0; i < Math.max(sameDomain.length, crossDomain.length); i++) {
          if (i < sameDomain.length)  toProcess.push(sameDomain[i]);
          if (i < crossDomain.length) toProcess.push(crossDomain[i]);
          if (toProcess.length >= MAX_LINKS_PER_PAGE) break;
        }

        // Save ALL found links to the links table (for graph data), but only
        // enqueue up to MAX_LINKS_PER_PAGE new ones
        let enqueued = 0;
        for (const linkUrl of toProcess) {
          // Save the link relationship
          await db.runAsync(
            `INSERT OR IGNORE INTO links (from_url, to_url) VALUES (?, ?)`,
            [url, linkUrl]
          ).catch(() => {});

          if (enqueued < MAX_LINKS_PER_PAGE) {
            const inSites = await db.getAsync('SELECT id FROM sites WHERE url=?', [linkUrl]);
            if (!inSites) {
              const inQueue = await db.getAsync('SELECT id FROM crawl_queue WHERE url=?', [linkUrl]);
              if (!inQueue) {
                this.enqueue(linkUrl, depth + 1);
                enqueued++;
              }
            }
          }
        }
      }

      // Explicitly null out parsed data to help GC
      parsed.links  = null;
      parsed.images = null;

      await this._updateStats();
      console.log(`[Crawler] ✓ ${url} (depth:${depth})`);

    } catch (err) {
      console.error(`[Crawler] ✗ ${url}:`, err.message);
      await db.runAsync(
        `UPDATE sites SET status='error', error=?, scraped_at=? WHERE url=?`,
        [err.message.slice(0, 300), new Date().toISOString(), url]
      ).catch(() => {});
    }
  }

  _domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return null; }
  }

  async _updateStats() {
    try {
      const [total, done, imgs, links, queue] = await Promise.all([
        this.db.getAsync('SELECT COUNT(*) as c FROM sites'),
        this.db.getAsync("SELECT COUNT(*) as c FROM sites WHERE status='done'"),
        this.db.getAsync('SELECT COUNT(*) as c FROM images'),
        this.db.getAsync('SELECT COUNT(*) as c FROM links'),
        this.db.getAsync('SELECT COUNT(*) as c FROM crawl_queue'),
      ]);
      const up = (k, v) => this.db.runAsync(
        `INSERT INTO stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [k, String(v)]
      );
      await Promise.all([
        up('total_sites',  total.c),  up('done_sites',   done.c),
        up('total_images', imgs.c),   up('total_links',  links.c),
        up('queue_size',   queue.c),  up('last_updated', new Date().toISOString()),
      ]);
    } catch {}
  }

  async getStats() {
    try {
      const rows = await this.db.allAsync('SELECT key, value FROM stats');
      const s = {};
      for (const r of rows) s[r.key] = r.value;
      return {
        totalSites:     parseInt(s.total_sites  || '0'),
        doneSites:      parseInt(s.done_sites   || '0'),
        totalImages:    parseInt(s.total_images || '0'),
        totalLinks:     parseInt(s.total_links  || '0'),
        queueSize:      parseInt(s.queue_size   || '0'),
        lastUpdated:    s.last_updated || null,
        activeTasks:    this.activeTasks,
        crawlerRunning: this.running && !this.paused,
      };
    } catch {
      return { totalSites:0, doneSites:0, totalImages:0, totalLinks:0,
               queueSize:0, activeTasks:0, crawlerRunning:false };
    }
  }
}

module.exports = { Crawler };
