const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDb } = require('./db');
const { initAnalytics, track, getAnalytics } = require('./analytics');
const { Crawler } = require('./crawler');
const { normalizeUrl, getDomain } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;

const db = initDb();
initAnalytics();
const crawler = new Crawler(db);

// ── Startup migration: deduplicate www. and fix domains ──────────────────
async function runMigrations() {
  try {
    // 1. Find all sites that have www. in their URL
    const wwwSites = await db.allAsync(
      "SELECT id, url, domain FROM sites WHERE url LIKE 'http://www.%' OR url LIKE 'https://www.%'"
    );
    let removed = 0, renamed = 0;
    for (const site of wwwSites) {
      // Strip www. from URL: https://www.google.com/x -> https://google.com/x
      const canonical = site.url.replace('://www.', '://');
      const canonicalDomain = site.domain.startsWith('www.') ? site.domain.slice(4) : site.domain;
      // Does a non-www version already exist?
      const existing = await db.getAsync('SELECT id FROM sites WHERE url = ?', [canonical]);
      if (existing) {
        // Duplicate — delete the www. version
        await db.runAsync('DELETE FROM sites WHERE id = ?', [site.id]).catch(() => {});
        removed++;
      } else {
        // No canonical yet — rename this one
        await db.runAsync('UPDATE sites SET url = ?, domain = ? WHERE id = ?',
          [canonical, canonicalDomain, site.id]).catch(() => {});
        renamed++;
      }
    }

    // 2. Also fix any www. entries in crawl_queue
    const wwwQueue = await db.allAsync(
      "SELECT id, url FROM crawl_queue WHERE url LIKE 'http://www.%' OR url LIKE 'https://www.%'"
    );
    for (const row of wwwQueue) {
      const canonical = row.url.replace('://www.', '://');
      const inSites = await db.getAsync('SELECT id FROM sites WHERE url = ?', [canonical]);
      if (inSites) {
        await db.runAsync('DELETE FROM crawl_queue WHERE id = ?', [row.id]).catch(() => {});
      } else {
        await db.runAsync('UPDATE crawl_queue SET url = ? WHERE id = ?', [canonical, row.id]).catch(() => {});
      }
    }

    // 3. Fix domain column for any rows where domain still has www.
    await db.runAsync(
      "UPDATE sites SET domain = SUBSTR(domain, 5) WHERE domain LIKE 'www.%'"
    ).catch(() => {});

    console.log('[Migration] www dedup complete — removed: ' + removed + ', renamed: ' + renamed);
  } catch (e) {
    console.error('[Migration] Error:', e.message);
  }
}

setTimeout(async () => {
  await runMigrations();
  crawler.start();
}, 600);

app.use(cors());
app.use(express.json());

// ── Usage tracking middleware ──────────────────────────────────────────────
app.use((req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  if (req.method === 'GET' && req.path === '/api/search' && req.query.q) {
    track('search', req.query.q, ip);
  } else if (req.method === 'GET' && req.path === '/api/search/images' && req.query.q) {
    track('image_search', req.query.q, ip);
  } else if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/admin')) {
    track('pageview', req.path, ip);
  }
  next();
});

// Auto-detect frontend location
const possibleFrontendPaths = [
  path.join(__dirname, '..', 'frontend', 'public'),
  path.join(__dirname, 'public'),
  path.join(__dirname, '..', 'public'),
  __dirname,
];
const frontendPath = possibleFrontendPaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || possibleFrontendPaths[0];
console.log('[Static] Serving frontend from: ' + frontendPath);
app.use(express.static(frontendPath));

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await crawler.getStats();
    const topDomains = await db.allAsync(
      "SELECT domain, COUNT(*) as count FROM sites WHERE status='done' GROUP BY domain ORDER BY count DESC LIMIT 10"
    );
    const recentSites = await db.allAsync(
      "SELECT url, title, domain, scraped_at FROM sites WHERE status='done' ORDER BY scraped_at DESC LIMIT 5"
    );
    const statusBreakdown = await db.allAsync(
      "SELECT status, COUNT(*) as count FROM sites GROUP BY status"
    );
    res.json({ ...stats, topDomains, recentSites, statusBreakdown });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sites
app.post('/api/sites', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    const normalized = normalizeUrl(url, url);
    if (!normalized) return res.status(400).json({ error: 'Invalid URL' });
    const domain = getDomain(normalized);
    if (!domain) return res.status(400).json({ error: 'Invalid domain' });
    const existing = await db.getAsync('SELECT id FROM sites WHERE url=?', [normalized]);
    if (existing) return res.status(409).json({ error: 'URL already exists', url: normalized });
    await db.runAsync("INSERT INTO sites (url, domain, status, crawl_depth) VALUES (?, ?, 'pending', 0)", [normalized, domain]);
    crawler.enqueue(normalized, 0);
    res.json({ success: true, url: normalized, message: 'URL added and queued for crawling' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sites
app.get('/api/sites', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const q = req.query.q?.trim() || '';
    const status = req.query.status || '';
    let where = [], params = [];
    if (q) { where.push("(url LIKE ? OR title LIKE ? OR description LIKE ? OR domain LIKE ?)"); params.push('%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%'); }
    if (status) { where.push("status = ?"); params.push(status); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRow = await db.getAsync("SELECT COUNT(*) as c FROM sites " + wc, params);
    const sites = await db.allAsync(
      "SELECT id,url,domain,title,description,favicon,status,http_status,scraped_at,added_at,crawl_depth FROM sites " + wc + " ORDER BY added_at DESC LIMIT ? OFFSET ?",
      [...params, limit, offset]
    );
    res.json({ sites, total: countRow.c, page, limit, pages: Math.ceil(countRow.c / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/search
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q?.trim() || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    if (!q) return res.json({ results: [], total: 0, page, limit, query: q });

    const qLower = q.toLowerCase().trim();
    const terms = qLower.split(/\s+/).filter(Boolean);

    const anyTermWhere = terms.map(() =>
      "(LOWER(title) LIKE ? OR LOWER(url) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(domain) LIKE ?)"
    ).join(' OR ');
    const anyTermParams = terms.flatMap(t => ['%'+t+'%','%'+t+'%','%'+t+'%','%'+t+'%','%'+t+'%']);

    // Build extra filter clauses from query params
    const filterParts = [];
    const filterVals  = [];
    if (req.query.domain) {
      const d = req.query.domain.toLowerCase().trim();
      filterParts.push("(LOWER(domain) = ? OR LOWER(domain) LIKE ?)");
      filterVals.push(d, '%.' + d);
    }
    if (req.query.lang) {
      filterParts.push("LOWER(lang) LIKE ?");
      filterVals.push(req.query.lang.toLowerCase().trim() + '%');
    }
    if (req.query.has_image === '1') {
      filterParts.push("og_image IS NOT NULL AND og_image != ''");
    }
    if (req.query.after) {
      filterParts.push("scraped_at >= ?");
      filterVals.push(req.query.after);
    }
    const filterClause = filterParts.length ? ' AND ' + filterParts.join(' AND ') : '';

    const candidates = await db.allAsync(
      "SELECT id,url,domain,title,description,favicon,og_image,scraped_at,keywords,crawl_depth,lang FROM sites WHERE status='done' AND (" + anyTermWhere + ")" + filterClause + " LIMIT 5000",
      [...anyTermParams, ...filterVals]
    );

    const scored = candidates.map(row => {
      const titleL    = (row.title       || '').toLowerCase();
      const domainL   = (row.domain      || '').toLowerCase();
      const urlL      = (row.url         || '').toLowerCase();
      const descL     = (row.description || '').toLowerCase();
      const keywordsL = (row.keywords    || '').toLowerCase();
      let score = 0;

      // ── Parse URL structure ───────────────────────────────────────────────
      let hostname = domainL;
      let pathname = '/';
      let pathDepth = 0;
      try {
        const pu = new URL(row.url);
        hostname = pu.hostname.toLowerCase();
        pathname = pu.pathname;
        pathDepth = pathname.split('/').filter(Boolean).length;
      } catch {}

      const hostNoWww        = hostname.replace(/^www\./, '');
      const hostParts        = hostNoWww.split('.');
      const registrable      = hostParts.slice(-2).join('.');
      const registrableLabel = hostParts[hostParts.length - 2] || '';
      const subdomainDepth   = Math.max(0, hostParts.length - 2);
      const isRootDomain     = subdomainDepth === 0;
      const isRootPath       = pathname === '/' || pathname === '';

      // ── DOMAIN IDENTITY ───────────────────────────────────────────────────
      // Does the DOMAIN NAME itself match the query?
      // "google" -> registrableLabel "google" = TRUE  (google.com, play.google.com)
      // "sonyrangs" query for "google" page   = FALSE (content-only match)
      const domainIsQuery =
        registrableLabel === qLower ||
        registrable === qLower ||
        registrable === qLower + '.com' ||
        registrable === qLower + '.org' ||
        registrable === qLower + '.net' ||
        registrable === qLower + '.io'  ||
        registrable === qLower + '.co';

      if (domainIsQuery) {
        // ── Results that BELONG to the queried domain ─────────────────────
        // These always rank above content-only results.
        // Within this group, rank: root homepage > root subpages > subdomains
        if (isRootDomain && isRootPath)  score += 1000000; // google.com/
        else if (isRootDomain)           score += 500000 - pathDepth * 5000;
        else if (isRootPath)             score += 100000 - subdomainDepth * 40000;
        else                             score += 60000  - subdomainDepth * 40000 - pathDepth * 2000;
      } else {
        // ── Content-only results (page mentions the query but domain != query) ─
        // Hard ceiling: always below any domain-identity result.
        score -= 500000;

        // Title: only reward when query is genuinely prominent in the title,
        // not just a passing word like "Google TV | Buy Rangs..."
        if (titleL === qLower) {
          score += 80000; // title IS the query
        } else if (titleL.startsWith(qLower + ' ') || titleL.startsWith(qLower + ':') || titleL.startsWith(qLower + ',')) {
          score += 25000; // query starts the title
        } else {
          // Partial matches: score per term, but with word-boundary preference
          for (const term of terms) {
            const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const wb  = new RegExp('(?:^|\\W)' + esc + '(?:\\W|$)');
            if (wb.test(titleL))            score += 8000;
            else if (titleL.includes(term)) score += 2000;
          }
          if (terms.length > 1 && titleL.includes(qLower)) score += 6000;
        }

        // Description / keywords (secondary content signals)
        for (const term of terms) {
          if (descL.includes(term))     score += 1000;
          if (keywordsL.includes(term)) score +=  500;
        }

        // Content quality
        if (row.description && row.description.length > 80) score += 3000;
        else if (row.description && row.description.length > 20) score += 1000;
        if (row.title && row.title.length > 5) score += 500;

        // Prefer root pages over deep subpages for content results too
        if (isRootPath) score += 5000;
        else score -= pathDepth * 500;
      }

      // ── CRAWL DEPTH (minor tiebreaker only) ──────────────────────────────
      score += Math.max(0, (5 - (row.crawl_depth || 0))) * 100;

      return { ...row, score };
    });

    // Primary sort: score desc. Tiebreak: shallower crawl depth first.
    scored.sort((a, b) => b.score - a.score || (a.crawl_depth || 0) - (b.crawl_depth || 0));
    const total = scored.length;
    res.json({ results: scored.slice(offset, offset + limit), total, page, limit, pages: Math.ceil(total / limit), query: q });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Derive display alt text (falls back to filename)
function getDisplayAlt(img) {
  if (img.alt && img.alt.trim().length > 0) return img.alt.trim();
  if (img.title && img.title.trim().length > 0) return img.title.trim();
  try {
    const u = new URL(img.src);
    const filename = u.pathname.split('/').pop() || '';
    const name = filename.replace(/\.[^.]+$/, '').replace(/[-_+%20]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length > 0) return name;
  } catch {}
  return '';
}

// Image quality score: resolution + alt text signal
function imageQualityScore(img) {
  let q = 0;
  const pixels = (img.width || 0) * (img.height || 0);
  if      (pixels >= 3840 * 2160) q += 700;
  else if (pixels >= 1920 * 1080) q += 500;
  else if (pixels >= 1280 *  720) q += 350;
  else if (pixels >=  640 *  480) q += 200;
  else if (pixels >=  300 *  200) q +=  80;
  else if (pixels > 0)            q +=  20;
  const hasAlt = img.alt && img.alt.trim().length > 2;
  if (hasAlt) q += 400; else q -= 300;
  return q;
}

// GET /api/search/images
app.get('/api/search/images', async (req, res) => {
  try {
    const q = req.query.q?.trim() || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 24;
    const offset = (page - 1) * limit;

    if (!q) {
      const total = (await db.getAsync('SELECT COUNT(*) as c FROM images')).c;
      const images = await db.allAsync(
        "SELECT i.id,i.src,i.alt,i.title,i.width,i.height,i.site_url,s.title as site_title,s.domain FROM images i LEFT JOIN sites s ON i.site_id=s.id ORDER BY CASE WHEN (i.alt IS NOT NULL AND TRIM(i.alt) != '') THEN 1 ELSE 0 END DESC, COALESCE(i.width,0)*COALESCE(i.height,0) DESC, i.found_at DESC LIMIT ? OFFSET ?",
        [limit, offset]
      );
      return res.json({ results: images.map(img => ({ ...img, display_alt: getDisplayAlt(img) })), total, page, limit, pages: Math.ceil(total/limit), query: q });
    }

    const qLower = q.toLowerCase().trim();
    const terms = qLower.split(/\s+/).filter(Boolean);
    const anyTermWhere = terms.map(() =>
      "(LOWER(i.alt) LIKE ? OR LOWER(i.title) LIKE ? OR LOWER(i.src) LIKE ? OR LOWER(i.site_url) LIKE ?)"
    ).join(' OR ');
    const anyTermParams = terms.flatMap(t => ['%'+t+'%','%'+t+'%','%'+t+'%','%'+t+'%']);

    const candidates = await db.allAsync(
      "SELECT i.id,i.src,i.alt,i.title,i.width,i.height,i.site_url,s.title as site_title,s.domain FROM images i LEFT JOIN sites s ON i.site_id=s.id WHERE " + anyTermWhere + " LIMIT 3000",
      anyTermParams
    );

    const scored = candidates.map(img => {
      const altL      = (img.alt      || '').toLowerCase();
      const imgTitleL = (img.title    || '').toLowerCase();
      const srcL      = (img.src      || '').toLowerCase();
      const siteUrlL  = (img.site_url || '').toLowerCase();
      let score = 0;

      for (const term of terms) {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wb = new RegExp('(?:^|[^a-z0-9])' + esc + '(?:$|[^a-z0-9])');
        if (altL === qLower)               score += 50000;
        if (wb.test(altL))                 score +=  8000;
        else if (altL.includes(term))      score +=  3000;
        if (wb.test(imgTitleL))            score +=  6000;
        else if (imgTitleL.includes(term)) score +=  2000;
        const filename = srcL.split('/').pop().replace(/\?.*$/, '');
        if (filename.includes(term))       score +=  1500;
        if (siteUrlL.includes(term))       score +=   600;
      }

      score += imageQualityScore(img);
      return { ...img, score, display_alt: getDisplayAlt(img) };
    });

    scored.sort((a, b) => b.score - a.score);
    const total = scored.length;
    res.json({ results: scored.slice(offset, offset + limit), total, page, limit, pages: Math.ceil(total/limit), query: q });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/dedup — manually trigger www deduplication
app.post('/api/admin/dedup', async (req, res) => {
  try {
    await runMigrations();
    const total = (await db.getAsync('SELECT COUNT(*) as c FROM sites')).c;
    res.json({ success: true, totalSites: total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/sites/:id
app.delete('/api/sites/:id', async (req, res) => {
  try {
    const site = await db.getAsync('SELECT id FROM sites WHERE id=?', [req.params.id]);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    await db.runAsync('DELETE FROM sites WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sites/:id/recrawl
app.post('/api/sites/:id/recrawl', async (req, res) => {
  try {
    const site = await db.getAsync('SELECT id,url FROM sites WHERE id=?', [req.params.id]);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    await db.runAsync("UPDATE sites SET status='pending' WHERE id=?", [req.params.id]);
    crawler.enqueue(site.url, 0);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/crawler/status', async (req, res) => res.json(await crawler.getStats()));
app.post('/api/crawler/pause', (req, res) => { crawler.pause(); res.json({ paused: true }); });
app.post('/api/crawler/resume', (req, res) => { crawler.resume(); res.json({ paused: false }); });


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════════════════════════
const { ADMIN_TOKEN } = require('./admin-config');
const os = require('os');

// Serve admin HTML panel at /admin/<token>/
app.get('/admin/:token', (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/admin/:token/', (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Middleware: validate token for all /admin-api/* routes
app.use('/admin-api/:token', (req, res, next) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  next();
});

// ── Admin: Stats (reuse public stats) ────────────────────────────────────
app.get('/admin-api/:token/stats', async (req, res) => {
  try {
    const stats = await crawler.getStats();
    const topDomains = await db.allAsync(
      "SELECT domain, COUNT(*) as count FROM sites WHERE status='done' GROUP BY domain ORDER BY count DESC LIMIT 10"
    );
    const recentSites = await db.allAsync(
      "SELECT url, title, domain, scraped_at FROM sites WHERE status='done' ORDER BY scraped_at DESC LIMIT 10"
    );
    const statusBreakdown = await db.allAsync(
      "SELECT status, COUNT(*) as count FROM sites GROUP BY status"
    );
    res.json({ ...stats, topDomains, recentSites, statusBreakdown });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: System usage ───────────────────────────────────────────────────
app.get('/admin-api/:token/system', async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;

    // CPU: sample over 200ms
    function getCpuPct() {
      return new Promise(resolve => {
        const start = os.cpus().map(c => ({ ...c.times }));
        setTimeout(() => {
          const end = os.cpus();
          let totalDiff = 0, idleDiff = 0;
          end.forEach((cpu, i) => {
            const s = start[i];
            const total = Object.values(cpu.times).reduce((a, b) => a + b, 0) -
                          Object.values(s).reduce((a, b) => a + b, 0);
            const idle  = cpu.times.idle - s.idle;
            totalDiff += total; idleDiff += idle;
          });
          resolve(totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0);
        }, 200);
      });
    }
    const cpu = await getCpuPct();

    // DB file size
    const dbPath = require('./db').DB_PATH;
    let dbSize = '—';
    try {
      const stat = require('fs').statSync(dbPath);
      dbSize = (stat.size / 1024 / 1024).toFixed(2) + ' MB';
    } catch {}

    // Disk (just the drive the process is on)
    let diskUsed = '—', diskPct = 0;
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        const out = execSync('wmic logicaldisk get size,freespace,caption').toString();
        const lines = out.trim().split('\n').slice(1).filter(Boolean);
        let totalB = 0, freeB = 0;
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) { freeB += Number(parts[1])||0; totalB += Number(parts[2])||0; }
        }
        if (totalB > 0) {
          diskPct = Math.round((1 - freeB / totalB) * 100);
          diskUsed = ((totalB - freeB) / 1e9).toFixed(1) + ' / ' + (totalB / 1e9).toFixed(1) + ' GB';
        }
      }
    } catch {}

    const upSec = process.uptime();
    const uptime = upSec < 60 ? Math.round(upSec) + 's'
      : upSec < 3600 ? Math.round(upSec/60) + 'm'
      : Math.round(upSec/3600) + 'h ' + Math.round((upSec%3600)/60) + 'm';

    res.json({
      cpu,
      ramPct:   Math.round(usedMem / totalMem * 100),
      ramUsed:  (usedMem / 1024 / 1024).toFixed(0) + ' / ' + (totalMem / 1024 / 1024).toFixed(0) + ' MB',
      heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1) + ' MB',
      heapTotal:(mem.heapTotal / 1024 / 1024).toFixed(1) + ' MB',
      diskUsed, diskPct,
      dbSize, dbPath,
      nodeVersion: process.version,
      platform: process.platform + ' ' + os.arch(),
      uptime,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Sites (with filtering) ─────────────────────────────────────────
app.get('/admin-api/:token/sites', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const q      = req.query.q?.trim() || '';
    const status = req.query.status || '';
    let where = [], params = [];
    if (q) { where.push('(url LIKE ? OR title LIKE ? OR domain LIKE ?)'); params.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
    if (status) { where.push('status = ?'); params.push(status); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (await db.getAsync('SELECT COUNT(*) as c FROM sites ' + wc, params)).c;
    const sites = await db.allAsync(
      'SELECT id,url,domain,title,status,crawl_depth,scraped_at,crawl_priority FROM sites ' + wc + ' ORDER BY added_at DESC LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );
    res.json({ sites, total, page, pages: Math.ceil(total/limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Delete site ────────────────────────────────────────────────────
app.delete('/admin-api/:token/sites/:id', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM sites WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Recrawl site ───────────────────────────────────────────────────
app.post('/admin-api/:token/sites/:id/recrawl', async (req, res) => {
  try {
    const site = await db.getAsync('SELECT url FROM sites WHERE id=?', [req.params.id]);
    if (!site) return res.status(404).json({ error: 'Not found' });
    const priority = parseInt(req.body?.priority) || 100;
    await db.runAsync("UPDATE sites SET status='pending', crawl_priority=? WHERE id=?", [priority, req.params.id]);
    crawler.enqueue(site.url, 0, priority);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Set site priority ───────────────────────────────────────────────
app.post('/admin-api/:token/sites/:id/priority', async (req, res) => {
  try {
    const priority = parseInt(req.body?.priority) || 100;
    await db.runAsync('UPDATE sites SET crawl_priority=? WHERE id=?', [priority, req.params.id]);
    await db.runAsync('UPDATE crawl_queue SET priority=? WHERE url=(SELECT url FROM sites WHERE id=?)', [priority, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Add site ───────────────────────────────────────────────────────
app.post('/admin-api/:token/sites', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    const normalized = normalizeUrl(url, url);
    if (!normalized) return res.status(400).json({ error: 'Invalid URL' });
    const domain = getDomain(normalized);
    const existing = await db.getAsync('SELECT id FROM sites WHERE url=?', [normalized]);
    if (existing) return res.status(409).json({ error: 'URL already exists' });
    await db.runAsync("INSERT INTO sites (url,domain,status,crawl_depth) VALUES (?,?,'pending',0)", [normalized, domain]);
    crawler.enqueue(normalized, 0);
    res.json({ success: true, url: normalized });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Queue ──────────────────────────────────────────────────────────
app.get('/admin-api/:token/queue', async (req, res) => {
  try {
    const total = (await db.getAsync('SELECT COUNT(*) as c FROM crawl_queue')).c;
    const queue = await db.allAsync('SELECT id,url,depth,priority,added_at FROM crawl_queue ORDER BY priority DESC, id ASC LIMIT 100');
    res.json({ queue, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/admin-api/:token/queue/:id', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM crawl_queue WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/admin-api/:token/queue', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM crawl_queue');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Crawler control ────────────────────────────────────────────────
app.post('/admin-api/:token/crawler/pause',  (req, res) => { crawler.pause();  res.json({ paused: true }); });
app.post('/admin-api/:token/crawler/resume', (req, res) => { crawler.resume(); res.json({ paused: false }); });

// ── Admin: Debug commands ─────────────────────────────────────────────────
app.post('/admin-api/:token/debug/:cmd', async (req, res) => {
  try {
    const cmd = req.params.cmd;

    if (cmd === 'dedup') {
      await runMigrations();
      const total = (await db.getAsync('SELECT COUNT(*) as c FROM sites')).c;
      return res.json({ success: true, message: 'Dedup complete', totalSites: total });
    }

    if (cmd === 'requeue-errors') {
      const result = await db.runAsync("UPDATE sites SET status='pending' WHERE status='error'");
      const errors = await db.allAsync("SELECT url FROM sites WHERE status='pending'");
      for (const s of errors) crawler.enqueue(s.url, 0);
      return res.json({ success: true, message: 'Re-queued ' + (result.changes||0) + ' errored sites' });
    }

    if (cmd === 'requeue-all') {
      await db.runAsync("UPDATE sites SET status='pending'");
      const all = await db.allAsync('SELECT url FROM sites');
      for (const s of all) crawler.enqueue(s.url, 0);
      return res.json({ success: true, message: 'Re-queued all ' + all.length + ' sites' });
    }

    if (cmd === 'fix-domains') {
      await db.runAsync("UPDATE sites SET domain = SUBSTR(domain, 5) WHERE domain LIKE 'www.%'");
      return res.json({ success: true, message: 'Domain column fixed' });
    }

    if (cmd === 'count-dupes') {
      const dupes = await db.allAsync(
        "SELECT url, COUNT(*) as c FROM sites GROUP BY url HAVING c > 1"
      );
      return res.json({ success: true, duplicates: dupes.length, urls: dupes.slice(0, 20) });
    }

    if (cmd === 'vacuum') {
      await db.runAsync('VACUUM');
      return res.json({ success: true, message: 'Database vacuumed' });
    }

    res.status(400).json({ error: 'Unknown command: ' + cmd });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Raw SQL (SELECT only) ──────────────────────────────────────────
app.post('/admin-api/:token/debug/sql', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: 'No SQL provided' });
    const sqlTrim = sql.trim().toLowerCase();
    if (!sqlTrim.startsWith('select')) {
      return res.status(400).json({ error: 'Only SELECT queries are allowed' });
    }
    const rows = await db.allAsync(sql);
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: Danger zone ────────────────────────────────────────────────────
app.post('/admin-api/:token/danger/:action', async (req, res) => {
  try {
    const action = req.params.action;

    if (action === 'delete-errors') {
      const r = await db.runAsync("DELETE FROM sites WHERE status='error'");
      return res.json({ success: true, message: 'Deleted ' + (r.changes||0) + ' errored sites' });
    }
    if (action === 'delete-images') {
      const r = await db.runAsync('DELETE FROM images');
      return res.json({ success: true, message: 'Deleted ' + (r.changes||0) + ' images' });
    }
    if (action === 'clear-queue') {
      await db.runAsync('DELETE FROM crawl_queue');
      return res.json({ success: true, message: 'Queue cleared' });
    }
    if (action === 'wipe-all') {
      await db.runAsync('DELETE FROM sites');
      await db.runAsync('DELETE FROM images');
      await db.runAsync('DELETE FROM links');
      await db.runAsync('DELETE FROM crawl_queue');
      await db.runAsync('DELETE FROM stats');
      return res.json({ success: true, message: 'All data wiped' });
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Analytics ─────────────────────────────────────────────────────────────
app.get('/admin-api/:token/analytics', async (req, res) => {
  const { ADMIN_TOKEN } = require('./admin-config');
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  try {
    res.json(await getAnalytics());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log('\n🔍 ScrapeIt running at http://localhost:' + PORT + '\n');
});
