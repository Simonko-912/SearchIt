const API = window.location.origin + '/api';

// ── State ──────────────────────────────────────────────────────────────────
let currentPage = 'home';
let searchTab = 'web';
let searchCurrentPage = 1;
let sitesCurrentPage = 1;
let sitesFilter = null;
let crawlerRunning = true;
let statsInterval = null;
// New page state
let domainPage=1,domainSort='pages',domainQuery='',domainDetailName=null,domainDetailPage=1;

// ── Search filter state ────────────────────────────────────────────────────
let filterDomain    = '';
let filterLang      = '';
let filterHasImage  = false;
let filterDateAfter = '';

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

  // Highlight active secondary nav button
  document.querySelectorAll('.sec-nav-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('onclick').includes("'" + name + "'"));
  });
  if (name === 'sites')     loadSites(sitesFilter);
  if (name === 'trending')  loadTrending();
  if (name === 'domains')   { domainDetailName=null; loadDomains(); }
  if (name === 'random')    loadRandom();
  if (name === 'bookmarks') { renderBookmarks(); renderHistory(); }
  if (name === 'home') headerSearch.style.display = 'none';
}

// ── Search ─────────────────────────────────────────────────────────────────
// ── Search Filters ─────────────────────────────────────────────────────────
function toggleFilterPanel() {
  document.getElementById('filter-panel').classList.toggle('open');
}

function applyFilters() {
  filterDomain    = document.getElementById('filter-domain').value.trim().toLowerCase();
  const langRaw   = document.getElementById('filter-lang').value.trim();
  filterLang      = langRaw.split(/[\s\u2014-]/)[0].trim().toLowerCase();
  filterHasImage  = document.getElementById('filter-has-image').checked;
  filterDateAfter = document.getElementById('filter-date').value;
  updateFilterBadge();
  document.getElementById('filter-panel').classList.remove('open');
  const q = document.getElementById('main-search-input').value.trim();
  if (q) { searchCurrentPage = 1; doSearch(); }
}

function clearFilters() {
  filterDomain = filterLang = filterDateAfter = '';
  filterHasImage = false;
  document.getElementById('filter-domain').value        = '';
  document.getElementById('filter-lang').value          = '';
  document.getElementById('filter-has-image').checked   = false;
  document.getElementById('filter-date').value          = '';
  updateFilterBadge();
  document.getElementById('filter-panel').classList.remove('open');
  const q = document.getElementById('main-search-input').value.trim();
  if (q) { searchCurrentPage = 1; doSearch(); }
}

function updateFilterBadge() {
  const badge = document.getElementById('filter-badge');
  if (!badge) return;
  const count = [filterDomain, filterLang, filterHasImage, filterDateAfter].filter(Boolean).length;
  badge.textContent   = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function filterByDomain(domain) {
  filterDomain = domain;
  document.getElementById('filter-domain').value = domain;
  updateFilterBadge();
  searchCurrentPage = 1;
  doSearch();
}

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
  addToHistory(q);
  const section = document.getElementById('results-section');
  const listEl = document.getElementById('results-list');
  const countEl = document.getElementById('results-count');
  const paginationEl = document.getElementById('pagination');

  section.classList.remove('hidden');
  listEl.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  paginationEl.innerHTML = '';

  try {
    const endpoint = searchTab === 'images' ? '/search/images' : '/search';
    const limit    = searchTab === 'images' ? 20 : 10;
    const params   = new URLSearchParams({ q, page, limit });
    if (searchTab === 'web') {
      if (filterDomain)    params.set('domain', filterDomain);
      if (filterLang)      params.set('lang', filterLang);
      if (filterHasImage)  params.set('has_image', '1');
      if (filterDateAfter) params.set('after', filterDateAfter);
    }
    const res = await fetch(`${API}${endpoint}?${params}`);
    const data = await res.json();

    const hasFilters = filterDomain || filterLang || filterHasImage || filterDateAfter;
    countEl.textContent = `${formatNum(data.total)} result${data.total !== 1 ? 's' : ''} for "${q}"${hasFilters ? ' (filtered)' : ''}`;

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
        <div class="result-domain">
          ${escHtml(r.domain)}
          <button class="filter-domain-btn" onclick="filterByDomain('${escAttr(r.domain)}')" title="Filter by this domain">⊕</button>
        </div>
        <div class="result-title"><a href="${escHtml(r.url)}" target="_blank" rel="noopener">${escHtml(r.title || r.url)}</a></div>
        <div class="result-desc">${escHtml(r.description || 'No description available.')}</div>
      </div>
    `;
    // Add action buttons via DOM (avoids quote nesting issues)
    var ra = document.createElement('div'); ra.className = 'result-actions';
    var simBtn = document.createElement('button'); simBtn.className = 'result-action-btn'; simBtn.textContent = 'Similar';
    (function(u,t){ simBtn.onclick = function(){ openSimilar(u,t); }; })(r.url, r.title||r.url);
    var bmBtn = document.createElement('button'); bmBtn.className = 'result-action-btn';
    bmBtn.textContent = isBookmarked(r.url) ? '★ Saved' : '☆ Save';
    (function(u,t,d,b){ bmBtn.onclick = function(){ toggleBookmark(u,t,d,b); }; })(r.url, r.title||r.url, r.domain, bmBtn);
    ra.appendChild(simBtn); ra.appendChild(bmBtn);
    item.querySelector('.result-body').appendChild(ra);
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
      <div class="image-wrap">
        <img src="${escHtml(img.src)}" alt="${escHtml(displayAlt)}" loading="lazy" onerror="this.parentElement.parentElement.style.display='none'">
      </div>
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
      statusText.textContent = data.activeTasks > 0
        ? `Crawling — ${data.activeTasks} active task${data.activeTasks !== 1 ? 's' : ''}`
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

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
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
  if (e.key === 'Escape') { closeLightbox({ target: document.getElementById('lightbox') }); closeSimilar(); }
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

// ═══════════════════════════════════════════════════════════════════════════
// NEW PAGES & FEATURES
// ═══════════════════════════════════════════════════════════════════════════

function escAttr(s) { return String(s||'').replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

// ── Similar Pages ──────────────────────────────────────────────────────────
async function openSimilar(url, title) {
  var modal = document.getElementById('similar-modal');
  var body  = document.getElementById('similar-body');
  document.getElementById('similar-title').textContent = (title||'').slice(0,70);
  modal.classList.add('open');
  body.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  try {
    var data = await (await fetch(API + '/similar?url=' + encodeURIComponent(url))).json();
    if (!data.results || !data.results.length) { body.innerHTML = '<p class="empty-msg">No similar pages found.</p>'; return; }
    body.innerHTML = '';
    data.results.forEach(function(r) {
      var el = document.createElement('div'); el.className = 'similar-item';
      var img = document.createElement('img'); img.className='result-favicon'; img.src=r.favicon||''; img.alt='';
      img.onerror = function(){this.style.display='none';};
      var info = document.createElement('div');
      var dom  = document.createElement('div'); dom.className='similar-domain'; dom.textContent=r.domain;
      var a    = document.createElement('a');   a.className='similar-link'; a.href=r.url; a.target='_blank'; a.rel='noopener'; a.textContent=r.title||r.url;
      var desc = document.createElement('div'); desc.className='similar-desc'; desc.textContent=(r.description||'').slice(0,120);
      info.appendChild(dom); info.appendChild(a); info.appendChild(desc);
      el.appendChild(img); el.appendChild(info);
      body.appendChild(el);
    });
  } catch(e) { body.innerHTML = '<p class="empty-msg">Error: ' + escHtml(e.message) + '</p>'; }
}
function closeSimilar() { document.getElementById('similar-modal').classList.remove('open'); }

// ── Bookmarks ──────────────────────────────────────────────────────────────
function getBookmarks() { try { return JSON.parse(localStorage.getItem('scrapeit-bookmarks')||'[]'); } catch(e) { return []; } }
function saveBookmarks(bm) { localStorage.setItem('scrapeit-bookmarks', JSON.stringify(bm)); }
function isBookmarked(url) { return getBookmarks().some(function(b){ return b.url===url; }); }
function toggleBookmark(url, title, domain, btn) {
  var bm = getBookmarks();
  if (isBookmarked(url)) {
    bm = bm.filter(function(b){ return b.url!==url; });
    if (btn) btn.textContent = '☆ Save';
  } else {
    bm.unshift({url:url, title:title, domain:domain, saved:Date.now()});
    if (btn) btn.textContent = '★ Saved';
  }
  saveBookmarks(bm);
  if (currentPage === 'bookmarks') renderBookmarks();
}
function clearBookmarks() {
  if (!confirm('Clear all bookmarks?')) return;
  saveBookmarks([]); renderBookmarks();
}
function renderBookmarks() {
  var el = document.getElementById('bookmarks-list');
  var bm = getBookmarks();
  if (!bm.length) { el.innerHTML = '<p class="empty-msg">No bookmarks yet. Click ☆ Save on any search result.</p>'; return; }
  el.innerHTML = '';
  bm.forEach(function(b) {
    var row  = document.createElement('div'); row.className = 'bookmark-item';
    var info = document.createElement('div'); info.className = 'bookmark-info';
    var dom  = document.createElement('span'); dom.className='bookmark-domain'; dom.textContent=b.domain;
    var a    = document.createElement('a'); a.className='bookmark-title'; a.href=b.url; a.target='_blank'; a.rel='noopener'; a.textContent=b.title;
    var time = document.createElement('span'); time.className='bookmark-time'; time.textContent='Saved '+timeAgo(b.saved/1000);
    var btn  = document.createElement('button'); btn.className='bm-remove'; btn.textContent='✕';
    (function(u){ btn.onclick = function(){ toggleBookmark(u,'','',null); }; })(b.url);
    info.appendChild(dom); info.appendChild(a); info.appendChild(time);
    row.appendChild(info); row.appendChild(btn);
    el.appendChild(row);
  });
}

// ── Search History ─────────────────────────────────────────────────────────
function getHistory() { try { return JSON.parse(localStorage.getItem('scrapeit-history')||'[]'); } catch(e) { return []; } }
function addToHistory(q) {
  if (!q.trim()) return;
  var h = getHistory().filter(function(x){ return x.query!==q; });
  h.unshift({query:q, time:Date.now()});
  localStorage.setItem('scrapeit-history', JSON.stringify(h.slice(0,30)));
}
function clearHistory() {
  if (!confirm('Clear all history?')) return;
  localStorage.removeItem('scrapeit-history'); renderHistory();
}
function renderHistory() {
  var el = document.getElementById('history-list');
  var h  = getHistory();
  if (!h.length) { el.innerHTML = '<p class="empty-msg">No history yet.</p>'; return; }
  el.innerHTML = '';
  h.forEach(function(item) {
    var row  = document.createElement('div'); row.className='history-item';
    var span = document.createElement('span'); span.className='history-query'; span.textContent=item.query;
    (function(q){ span.onclick = function(){ replaySearch(q); }; })(item.query);
    var time = document.createElement('span'); time.className='history-time'; time.textContent=timeAgo(item.time/1000);
    row.appendChild(span); row.appendChild(time);
    el.appendChild(row);
  });
}
function replaySearch(q) {
  document.getElementById('main-search-input').value = q;
  document.getElementById('header-search-input').value = q;
  showPage('home'); searchCurrentPage=1; doSearch();
}

// ── Trending ───────────────────────────────────────────────────────────────
async function loadTrending() {
  ['trending-top','trending-recent','trending-new'].forEach(function(id){
    document.getElementById(id).innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  });
  try {
    var data = await (await fetch(API + '/trending')).json();
    var max  = (data.topDomains && data.topDomains[0]) ? data.topDomains[0].page_count : 1;

    var topEl = document.getElementById('trending-top'); topEl.innerHTML='';
    (data.topDomains||[]).forEach(function(d,i){
      var row = document.createElement('div'); row.className='trend-row';
      (function(dom){ row.onclick=function(){ openDomainDetail(dom); }; })(d.domain);
      var rank = document.createElement('span'); rank.className='trend-rank'; rank.textContent=i+1;
      var info = document.createElement('div'); info.className='trend-info';
      var name = document.createElement('span'); name.className='trend-domain'; name.textContent=d.domain;
      var meta = document.createElement('span'); meta.className='trend-meta'; meta.textContent=formatNum(d.page_count)+' pages';
      info.appendChild(name); info.appendChild(meta);
      var bw = document.createElement('div'); bw.className='trend-bar-wrap';
      var b  = document.createElement('div'); b.className='trend-bar'; b.style.width=Math.round(d.page_count/max*100)+'%';
      bw.appendChild(b);
      var cnt = document.createElement('span'); cnt.className='trend-count'; cnt.textContent=formatNum(d.page_count);
      row.appendChild(rank); row.appendChild(info); row.appendChild(bw); row.appendChild(cnt);
      topEl.appendChild(row);
    });
    if (!topEl.children.length) topEl.innerHTML='<p class="empty-msg">No data yet.</p>';

    var recEl = document.getElementById('trending-recent'); recEl.innerHTML='';
    (data.recentSites||[]).forEach(function(s){
      var row  = document.createElement('div'); row.className='recent-site-row';
      var img  = document.createElement('img'); img.className='result-favicon'; img.src=s.favicon||''; img.alt='';
      img.onerror=function(){this.style.display='none';};
      var info = document.createElement('div'); info.className='recent-site-info';
      var a    = document.createElement('a'); a.className='recent-site-title'; a.href=s.url; a.target='_blank'; a.rel='noopener'; a.textContent=s.title||s.url;
      var sub  = document.createElement('span'); sub.className='recent-site-domain'; sub.textContent=s.domain;
      info.appendChild(a); info.appendChild(sub);
      row.appendChild(img); row.appendChild(info);
      recEl.appendChild(row);
    });
    if (!recEl.children.length) recEl.innerHTML='<p class="empty-msg">Nothing indexed yet.</p>';

    var newEl = document.getElementById('trending-new'); newEl.innerHTML='';
    (data.newDomains||[]).forEach(function(d){
      var row  = document.createElement('div'); row.className='new-domain-row';
      (function(dom){ row.onclick=function(){ openDomainDetail(dom); }; })(d.domain);
      var name = document.createElement('span'); name.className='new-domain-name'; name.textContent=d.domain;
      var meta = document.createElement('span'); meta.className='new-domain-meta'; meta.textContent=formatNum(d.page_count)+' pages';
      row.appendChild(name); row.appendChild(meta);
      newEl.appendChild(row);
    });
    if (!newEl.children.length) newEl.innerHTML='<p class="empty-msg">No new domains.</p>';

  } catch(e) { document.getElementById('trending-top').innerHTML='<p class="empty-msg">Error: '+escHtml(e.message)+'</p>'; }
}

// ── Domains ────────────────────────────────────────────────────────────────
async function loadDomains() {
  if (domainDetailName) { loadDomainDetail(domainDetailName); return; }
  document.getElementById('domain-detail-panel').style.display='none';
  document.getElementById('domain-browse-panel').style.display='block';
  document.getElementById('domain-search-input').value=domainQuery;
  document.getElementById('domain-sort-select').value=domainSort;
  var grid = document.getElementById('domain-grid');
  grid.innerHTML='<div class="empty-state"><div class="spinner"></div></div>';
  try {
    var p = new URLSearchParams({page:domainPage,limit:24,sort:domainSort});
    if (domainQuery) p.set('q',domainQuery);
    var data = await (await fetch(API+'/domains?'+p)).json();
    document.getElementById('domain-count-label').textContent=formatNum(data.total)+' domain'+(data.total!==1?'s':'');
    if (!data.domains||!data.domains.length) { grid.innerHTML='<div class="empty-state"><p>No domains yet.</p></div>'; return; }
    grid.innerHTML='';
    data.domains.forEach(function(d){
      var card = document.createElement('div'); card.className='domain-card';
      (function(dom){ card.onclick=function(){ openDomainDetail(dom); }; })(d.domain);
      var hdr  = document.createElement('div'); hdr.className='domain-card-header';
      var img  = document.createElement('img'); img.className='domain-favicon';
      img.src=d.favicon||'https://'+d.domain+'/favicon.ico';
      img.onerror=function(){this.style.display='none';};
      var name = document.createElement('span'); name.className='domain-card-name'; name.textContent=d.domain;
      var stat = document.createElement('div'); stat.className='domain-card-stats'; stat.textContent=formatNum(d.page_count)+' pages';
      hdr.appendChild(img); hdr.appendChild(name);
      card.appendChild(hdr); card.appendChild(stat);
      grid.appendChild(card);
    });
    renderPagination(document.getElementById('domain-pagination'),domainPage,data.pages,function(pg){domainPage=pg;loadDomains();});
  } catch(e) { grid.innerHTML='<div class="empty-state"><p>Error: '+escHtml(e.message)+'</p></div>'; }
}
function openDomainDetail(domain) { domainDetailName=domain; domainDetailPage=1; showPage('domains'); }
function closeDomainDetail() { domainDetailName=null; loadDomains(); }
async function loadDomainDetail(domain) {
  document.getElementById('domain-browse-panel').style.display='none';
  document.getElementById('domain-detail-panel').style.display='block';
  document.getElementById('domain-detail-name').textContent=domain;
  var list = document.getElementById('domain-detail-list');
  list.innerHTML='<div class="empty-state"><div class="spinner"></div></div>';
  try {
    var data = await (await fetch(API+'/domains/'+encodeURIComponent(domain)+'/pages?page='+domainDetailPage+'&limit=20')).json();
    document.getElementById('domain-detail-count').textContent=formatNum(data.total)+' page'+(data.total!==1?'s':'')+' indexed';
    if (!data.pages||!data.pages.length) { list.innerHTML='<p class="empty-msg">No pages found.</p>'; return; }
    list.innerHTML='';
    data.pages.forEach(function(pg){
      var row  = document.createElement('div'); row.className='domain-page-row';
      var info = document.createElement('div'); info.className='domain-page-info';
      var a    = document.createElement('a'); a.className='domain-page-title'; a.href=pg.url; a.target='_blank'; a.rel='noopener'; a.textContent=pg.title||pg.url;
      var url  = document.createElement('span'); url.className='domain-page-url'; url.textContent=pg.url;
      info.appendChild(a); info.appendChild(url);
      var btn = document.createElement('button'); btn.className='result-action-btn';
      btn.textContent=isBookmarked(pg.url)?'★':'☆';
      (function(u,t,b){ btn.onclick=function(){ toggleBookmark(u,t,domain,b); }; })(pg.url,pg.title||pg.url,btn);
      row.appendChild(info); row.appendChild(btn);
      list.appendChild(row);
    });
    renderPagination(document.getElementById('domain-detail-pagination'),domainDetailPage,data.pages_count,function(pg){domainDetailPage=pg;loadDomainDetail(domain);});
  } catch(e) { list.innerHTML='<p class="empty-msg">Error: '+escHtml(e.message)+'</p>'; }
}

// ── Random ─────────────────────────────────────────────────────────────────
async function loadRandom() {
  var card = document.getElementById('random-card');
  var btn  = document.getElementById('random-btn');
  btn.disabled=true;
  card.innerHTML='<div class="empty-state"><div class="spinner"></div></div>';
  try {
    var res = await fetch(API+'/random');
    if (res.status===404) { card.innerHTML='<p class="empty-msg">No indexed sites yet.</p>'; return; }
    var d = await res.json();
    card.innerHTML='';
    var result = document.createElement('div'); result.className='random-result';
    var hdr = document.createElement('div'); hdr.className='random-header';
    var img = document.createElement('img'); img.className='result-favicon'; img.src=d.favicon||''; img.alt='';
    img.onerror=function(){this.style.display='none';};
    var dom = document.createElement('span'); dom.className='random-domain'; dom.textContent=d.domain;
    hdr.appendChild(img); hdr.appendChild(dom);
    var title = document.createElement('a'); title.className='random-title'; title.href=d.url; title.target='_blank'; title.rel='noopener'; title.textContent=d.title||d.url;
    var desc  = document.createElement('p'); desc.className='random-desc'; desc.textContent=d.description||'No description available.';
    var acts  = document.createElement('div'); acts.className='random-actions';
    var visit = document.createElement('a'); visit.className='btn btn-primary'; visit.href=d.url; visit.target='_blank'; visit.rel='noopener'; visit.textContent='Visit →';
    var save  = document.createElement('button'); save.className='btn btn-secondary'; save.textContent=isBookmarked(d.url)?'★ Saved':'☆ Save';
    (function(u,t,dom2,b){ save.onclick=function(){ toggleBookmark(u,t,dom2,b); }; })(d.url,d.title||'',d.domain,save);
    var sim = document.createElement('button'); sim.className='btn btn-secondary'; sim.textContent='Similar';
    (function(u,t){ sim.onclick=function(){ openSimilar(u,t); }; })(d.url,d.title||d.url);
    acts.appendChild(visit); acts.appendChild(save); acts.appendChild(sim);
    result.appendChild(hdr);
    if (d.og_image) {
      var og=document.createElement('img'); og.className='random-image'; og.src=d.og_image; og.alt='';
      og.onerror=function(){this.style.display='none';};
      result.appendChild(og);
    }
    result.appendChild(title); result.appendChild(desc); result.appendChild(acts);
    card.appendChild(result);
  } catch(e) { card.innerHTML='<p class="empty-msg">Error: '+escHtml(e.message)+'</p>'; }
  finally { btn.disabled=false; }
}
