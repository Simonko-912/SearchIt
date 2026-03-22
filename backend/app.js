const API = 'http://wherever-logs-del-windsor.trycloudflare.com'

// ── State ──────────────────────────────────────────────────────────────────
let currentPage = 'home';
let searchTab = 'web';
let searchCurrentPage = 1;
let sitesCurrentPage = 1;
let sitesFilter = null;
let crawlerRunning = true;
let statsInterval = null;

// ── Theme ──────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  setTheme(saved);
}
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.getElementById('icon-sun').style.display = theme === 'light' ? 'block' : 'none';
  document.getElementById('icon-moon').style.display = theme === 'dark' ? 'block' : 'none';
}
document.getElementById('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'light' ? 'dark' : 'light');
});

// ── Navigation ─────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  currentPage = name;

  const headerSearch = document.getElementById('header-search-wrap');
  headerSearch.style.display = name === 'home' ? 'none' : 'flex';

  if (name === 'stats') {
    loadStats();
    if (!statsInterval) statsInterval = setInterval(loadStats, 4000);
  } else {
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  }

  if (name === 'sites') loadSites(sitesFilter);
  if (name === 'home') headerSearch.style.display = 'none';
}

// ── Search ─────────────────────────────────────────────────────────────────
function switchTab(tab) {
  searchTab = tab;
  document.getElementById('tab-web').classList.toggle('active', tab === 'web');
  document.getElementById('tab-images').classList.toggle('active', tab === 'images');
  const q = document.getElementById('main-search-input').value.trim();
  if (q) { searchCurrentPage = 1; doSearch(); }
}

async function doSearch(page = 1) {
  const q = document.getElementById('main-search-input').value.trim() ||
            document.getElementById('header-search-input').value.trim();
  if (!q) return;

  searchCurrentPage = page;
  const section = document.getElementById('results-section');
  const listEl = document.getElementById('results-list');
  const countEl = document.getElementById('results-count');
  const paginationEl = document.getElementById('pagination');

  section.classList.remove('hidden');
  listEl.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  paginationEl.innerHTML = '';

  try {
    const endpoint = searchTab === 'images' ? '/search/images' : '/search';
    const limit = searchTab === 'images' ? 20 : 10;
    const res = await fetch(`${API}${endpoint}?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`);
    const data = await res.json();

    countEl.textContent = `${formatNum(data.total)} result${data.total !== 1 ? 's' : ''} for "${q}"`;

    if (data.total === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>No results found. Try adding some sites first.</p></div>';
      return;
    }

    if (searchTab === 'images') {
      renderImageResults(listEl, data.results);
    } else {
      renderWebResults(listEl, data.results);
    }

    renderPagination(paginationEl, page, Math.ceil(data.total / limit), (p) => doSearch(p));
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

function renderWebResults(container, results) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'result-list';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = `
      <img class="result-favicon" src="${escHtml(r.favicon || '')}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect width=%2216%22 height=%2216%22 rx=%222%22 fill=%22%23e5e7eb%22/></svg>'" alt="">
      <div class="result-body">
        <div class="result-domain">${escHtml(r.domain)}</div>
        <div class="result-title"><a href="${escHtml(r.url)}" target="_blank" rel="noopener">${escHtml(r.title || r.url)}</a></div>
        <div class="result-desc">${escHtml(r.description || 'No description available.')}</div>
      </div>
    `;
    list.appendChild(item);
  }
  container.appendChild(list);
}

function getDisplayAlt(img) {
  if (img.display_alt && img.display_alt.trim().length > 0) return img.display_alt.trim();
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

function renderImageResults(container, results) {
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'image-grid';
  for (const img of results) {
    const displayAlt = getDisplayAlt(img);
    const hasRealAlt = (img.alt && img.alt.trim().length > 0) || (img.title && img.title.trim().length > 0);
    const card = document.createElement('div');
    card.className = 'image-card';
    card.innerHTML = `
      <img src="${escHtml(img.src)}" alt="${escHtml(displayAlt)}" loading="lazy" onerror="this.parentElement.style.display='none'">
      <div class="image-card-info">
        <div class="image-card-alt${hasRealAlt ? '' : ' image-card-alt--filename'}">${escHtml(displayAlt)}</div>
        <div class="image-card-domain">${escHtml(img.domain || '')}</div>
      </div>
    `;
    card.querySelector('img').addEventListener('click', () => openLightbox(img));
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

// ── Add Site ───────────────────────────────────────────────────────────────
async function addSite() {
  const input = document.getElementById('add-url');
  const alert = document.getElementById('add-alert');
  const url = input.value.trim();
  if (!url) { showAlert(alert, 'error', 'Please enter a URL.'); return; }

  const btn = document.querySelector('#page-add .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Adding...';

  try {
    const res = await fetch(`${API}/sites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showAlert(alert, 'success', `✓ ${data.message} — <strong>${escHtml(data.url)}</strong>`);
    input.value = '';
    updateBadge();
  } catch (err) {
    showAlert(alert, 'error', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Add & Start Crawling';
  }
}

function showAlert(el, type, html) {
  el.className = `alert alert-${type} show`;
  el.innerHTML = html;
  setTimeout(() => el.classList.remove('show'), 8000);
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch(`${API}/stats`);
    const data = await res.json();

    // Count unique domains from topDomains list, fall back to doneSites
    const uniqueDomains = data.topDomains ? data.topDomains.length : 0;
    // Count failed from statusBreakdown
    const failedEntry = data.statusBreakdown ? data.statusBreakdown.find(s => s.status === 'error') : null;
    const failedCount = failedEntry ? failedEntry.count : 0;

    document.getElementById('stat-sites').textContent   = formatNum(data.doneSites);
    document.getElementById('stat-images').textContent  = formatNum(data.totalImages);
    document.getElementById('stat-domains').textContent = formatNum(uniqueDomains);
    document.getElementById('stat-links').textContent   = formatNum(data.totalLinks);
    document.getElementById('stat-queue').textContent   = formatNum(data.queueSize);
    document.getElementById('stat-failed').textContent  = formatNum(failedCount);

    const dot       = document.getElementById('crawler-dot');
    const statusText = document.getElementById('crawler-status-text');
    const currentUrl = document.getElementById('crawler-current-url');
    const toggleBtn  = document.getElementById('crawler-toggle-btn');

    crawlerRunning = data.crawlerRunning;
    if (data.crawlerRunning) {
      dot.className = 'status-dot running';
      const workerInfo = data.workers ? ` (${data.activeTasks}/${data.workers} threads)` : '';
      statusText.textContent = data.activeTasks > 0
        ? `Crawling${workerInfo}`
        : 'Idle — waiting for queue';
      currentUrl.textContent = data.queueSize > 0 ? `${formatNum(data.queueSize)} URLs queued` : '';
      toggleBtn.textContent = 'Pause';
      toggleBtn.className = 'btn btn-sm btn-secondary';
    } else {
      dot.className = 'status-dot stopped';
      statusText.textContent = 'Crawler paused';
      currentUrl.textContent = '';
      toggleBtn.textContent = 'Resume';
      toggleBtn.className = 'btn btn-sm btn-primary';
    }

    const recentList = document.getElementById('recent-list');
    if (data.recentSites && data.recentSites.length > 0) {
      recentList.innerHTML = data.recentSites.map(s => `
        <div class="recent-item">
          <div class="recent-item-info">
            <div class="recent-item-title">${escHtml(s.title || s.url)}</div>
            <div class="recent-item-url">${escHtml(s.url)}</div>
          </div>
          <div class="recent-item-time">${s.scraped_at ? new Date(s.scraped_at).toLocaleString() : '—'}</div>
        </div>
      `).join('');
    } else {
      document.getElementById('recent-list').innerHTML = '<div class="empty-state"><p>No sites crawled yet</p></div>';
    }

    updateBadge(data.totalSites);
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function toggleCrawler() {
  const endpoint = crawlerRunning ? '/crawler/pause' : '/crawler/resume';
  await fetch(`${API}${endpoint}`, { method: 'POST' });
  await loadStats();
}

// ── Sites List ─────────────────────────────────────────────────────────────
async function loadSites(status = null, filterEl = null) {
  sitesFilter = status;

  if (filterEl) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    filterEl.classList.add('active');
  }

  const tbody = document.getElementById('sites-tbody');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="7"><div class="spinner"></div></td></tr>';

  const statusParam = status !== null ? `&status=${status}` : '';
  try {
    const res = await fetch(`${API}/sites?page=${sitesCurrentPage}&limit=20${statusParam}`);
    const data = await res.json();

    const sitesList = data.sites || data.results || [];
    if (sitesList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">No sites found</td></tr>';
      document.getElementById('sites-pagination').innerHTML = '';
      return;
    }

    tbody.innerHTML = sitesList.map(s => `
      <tr>
        <td class="text-mono">${escHtml(s.domain)}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          <a href="${escHtml(s.url)}" target="_blank" rel="noopener">${escHtml(s.title || s.url)}</a>
        </td>
        <td>${statusBadge(s.status)}</td>
        <td class="text-mono">${s.image_count || 0}</td>
        <td class="text-mono">${s.link_count || 0}</td>
        <td class="text-mono" style="font-size:0.75rem;">${s.last_scraped ? timeAgo(s.last_scraped) : '—'}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteSite(${s.id}, this)" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14H6L5 6M9 6V4h6v2"/></svg>
          </button>
        </td>
      </tr>
    `).join('');

    renderPagination(
      document.getElementById('sites-pagination'),
      sitesCurrentPage,
      Math.ceil(data.total / 20),
      (p) => { sitesCurrentPage = p; loadSites(sitesFilter); }
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">${err.message}</td></tr>`;
  }
}

async function deleteSite(id, btn) {
  if (!confirm('Delete this site and all its data?')) return;
  btn.disabled = true;
  await fetch(`${API}/sites/${id}`, { method: 'DELETE' });
  loadSites(sitesFilter);
  updateBadge();
}

// ── Helpers ────────────────────────────────────────────────────────────────
function statusBadge(status) {
  if (status === 'done')     return '<span class="status-badge ok">Indexed</span>';
  if (status === 'error')    return '<span class="status-badge fail">Failed</span>';
  if (status === 'crawling') return '<span class="status-badge crawling">Crawling</span>';
  if (status === 'skipped')  return '<span class="status-badge skipped">Skipped</span>';
  return '<span class="status-badge pending">Pending</span>';
}

function renderPagination(container, current, total, onClick) {
  container.innerHTML = '';
  if (total <= 1) return;

  const makeBtn = (label, page, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.innerHTML = label;
    btn.disabled = disabled;
    if (!disabled && !active) btn.addEventListener('click', () => onClick(page));
    container.appendChild(btn);
  };

  makeBtn('‹', current - 1, current === 1);
  const start = Math.max(1, current - 2);
  const end = Math.min(total, start + 4);
  for (let i = start; i <= end; i++) makeBtn(i, i, false, i === current);
  makeBtn('›', current + 1, current === total);
}

function formatNum(n) {
  if (n === undefined || n === null) return '—';
  n = Number(n);
  if (n < 10000) return n.toLocaleString();
  if (n < 1000000) return (n / 1000).toFixed(n < 100000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(n < 10000000 ? 1 : 0) + 'm';
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function updateBadge(count) {
  if (count === undefined) {
    try {
      const res = await fetch(`${API}/stats`);
      const data = await res.json();
      count = data.totalSites;
    } catch { return; }
  }
  document.getElementById('sites-badge').textContent = formatNum(count);
}

// ── Lightbox ───────────────────────────────────────────────────────────────
function openLightbox(img) {
  const displayAlt = getDisplayAlt(img);
  const hasRealAlt = (img.alt && img.alt.trim().length > 0) || (img.title && img.title.trim().length > 0);
  document.getElementById('lightbox-img').src = img.src;
  document.getElementById('lightbox-img').alt = displayAlt;
  const sourceUrl = img.site_url || img.page_url || '';
  document.getElementById('lightbox-info').innerHTML =
    `<span class="${hasRealAlt ? '' : 'lightbox-filename'}">${escHtml(displayAlt)}</span>` +
    (sourceUrl ? ` · <a href="${escHtml(sourceUrl)}" target="_blank" rel="noopener" style="color:inherit;opacity:0.7">${escHtml(img.domain || sourceUrl)}</a>` : '');
  document.getElementById('lightbox').classList.add('open');
}

function closeLightbox(e) {
  if (e && e.target !== document.getElementById('lightbox') && !e.target.classList.contains('lightbox-close')) return;
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLightbox({ target: document.getElementById('lightbox') });
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.getElementById('main-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { searchCurrentPage = 1; doSearch(); }
});
document.getElementById('header-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    document.getElementById('main-search-input').value = e.target.value;
    showPage('home');
    searchCurrentPage = 1;
    doSearch();
  }
});

// Sync inputs
document.getElementById('main-search-input').addEventListener('input', e => {
  document.getElementById('header-search-input').value = e.target.value;
});

document.getElementById('add-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') addSite();
});

// ── Init ───────────────────────────────────────────────────────────────────
initTheme();
showPage('home');
updateBadge();
