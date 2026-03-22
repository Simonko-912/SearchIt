const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { URL } = require('url');

const TIMEOUT = 15000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'ScrapeItBot/1.0 (+https://scrapeit.local/bot)';

// Normalize URL: strip www., remove fragment, remove trailing slash on non-root
function normalizeUrl(rawUrl, base) {
  try {
    const resolved = new URL(rawUrl, base);
    if (!['http:', 'https:'].includes(resolved.protocol)) return null;
    if (resolved.hostname.startsWith('www.')) {
      resolved.hostname = resolved.hostname.slice(4);
    }
    resolved.hash = '';
    let href = resolved.href;
    if (resolved.pathname !== '/' && href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function detectCharset(contentType, rawBuffer) {
  if (contentType) {
    const m = contentType.match(/charset\s*=\s*([^\s;]+)/i);
    if (m) return m[1].trim().toLowerCase();
  }
  const head = rawBuffer.slice(0, 4096).toString('ascii');
  const m1 = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"';\s>]+)/i);
  if (m1) return m1[1].trim().toLowerCase();
  const m2 = head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([^"';\s>]+)/i);
  if (m2) return m2[1].trim().toLowerCase();
  return 'utf-8';
}

function charsetToEncoding(charset) {
  const c = (charset || '').toLowerCase().replace(/[-_]/g, '');
  if (c === 'utf8' || c === 'utf8bom') return 'utf8';
  if (['latin1','iso88591','iso885915','windows1252','cp1252','windows1250','cp1250'].includes(c)) return 'latin1';
  if (c === 'ascii' || c === 'usascii') return 'ascii';
  return 'utf8';
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      follow: MAX_REDIRECTS,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { status: res.status, html: null, finalUrl: res.url, error: 'Non-HTML content' };
    }
    const buffer = await res.buffer();
    const charset = detectCharset(contentType, buffer);
    const encoding = charsetToEncoding(charset);
    const html = buffer.toString(encoding);
    // Strip www. from final URL too
    let finalUrl = res.url;
    try {
      const fu = new URL(res.url);
      if (fu.hostname.startsWith('www.')) { fu.hostname = fu.hostname.slice(4); finalUrl = fu.href; }
    } catch {}
    return { status: res.status, html, finalUrl, error: null };
  } catch (err) {
    clearTimeout(timer);
    return { status: null, html: null, finalUrl: url, error: err.message };
  }
}

function parsePage(html, pageUrl) {
  const $ = cheerio.load(html, { decodeEntities: true });

  const title = $('title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() || '';
  const description = $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() || '';
  const keywords = $('meta[name="keywords"]').attr('content')?.trim() || '';
  const lang = $('html').attr('lang')?.trim() || '';

  let favicon = $('link[rel="icon"]').attr('href') ||
    $('link[rel="shortcut icon"]').attr('href') ||
    $('link[rel="apple-touch-icon"]').attr('href') ||
    '/favicon.ico';
  favicon = normalizeUrl(favicon, pageUrl) || favicon;

  let og_image = $('meta[property="og:image"]').attr('content')?.trim() || '';
  if (og_image) og_image = normalizeUrl(og_image, pageUrl) || og_image;

  const links = [];
  const seenLinks = new Set();

  function addLink(href, anchor) {
    if (!href) return;
    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized || seenLinks.has(normalized)) return;
    seenLinks.add(normalized);
    links.push({ url: normalized, anchor: (anchor || '').trim().slice(0, 200) });
  }

  // 1. Standard <a href> links
  $('a[href]').each((_, el) => {
    addLink($(el).attr('href'), $(el).text());
  });

  // 2. Buttons with onclick="location.href='...'" or window.location patterns
  $('button[onclick], a[onclick]').each((_, el) => {
    const oc = $(el).attr('onclick') || '';
    const m = oc.match(/(?:window\.location(?:\.href)?|location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/);
    if (m) addLink(m[1], $(el).text());
  });

  // 3. Any element with data-href, data-url, data-link attributes (common in SPAs)
  $('[data-href], [data-url], [data-link]').each((_, el) => {
    const href = $(el).attr('data-href') || $(el).attr('data-url') || $(el).attr('data-link');
    addLink(href, $(el).text());
  });

  // 4. <form action> — forms that navigate to a URL on submit
  $('form[action]').each((_, el) => {
    const action = $(el).attr('action');
    if (action && !action.startsWith('#') && !action.includes('?')) {
      addLink(action, '');
    }
  });

  // 5. <meta http-equiv="refresh"> redirects: <meta content="0; url=https://...">
  $('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]').each((_, el) => {
    const content = $(el).attr('content') || '';
    const m = content.match(/url=(['"]?)([^'"\s]+)\1/i);
    if (m) addLink(m[2], '');
  });

  // 6. Canonical and alternate links in <head>
  $('link[rel="canonical"], link[rel="alternate"]').each((_, el) => {
    addLink($(el).attr('href'), '');
  });

  // 7. Plain-text URLs in the page body (http/https URLs not already in href)
  //    Scan text nodes for URLs like "visit https://example.com for more"
  const TEXT_URL_RE = /https?:\/\/[^\s<>"'()\[\]{}|\\^`]{4,}/g;
  $('p, li, td, div, span, blockquote, article, section').each((_, el) => {
    // Only look at direct text, not all descendants (avoid huge DOMs)
    const text = $(el).clone().children().remove().end().text();
    let m;
    while ((m = TEXT_URL_RE.exec(text)) !== null) {
      // Strip trailing punctuation that was part of the sentence
      const raw = m[0].replace(/[.,;:!?)]+$/, '');
      addLink(raw, '');
    }
    TEXT_URL_RE.lastIndex = 0;
  });

  // 8. srcset attributes on <img> and <source> — extract the URLs
  //    (these are image variants but may point to different subpages)
  $('source[src], iframe[src], frame[src], embed[src]').each((_, el) => {
    addLink($(el).attr('src'), '');
  });

  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (!src) return;
    const normalized = normalizeUrl(src, pageUrl);
    if (!normalized) return;
    const alt = $(el).attr('alt')?.trim() || '';
    const imgTitle = $(el).attr('title')?.trim() || '';
    const width = parseInt($(el).attr('width')) || null;
    const height = parseInt($(el).attr('height')) || null;
    if ((width && width < 10) || (height && height < 10)) return;
    if (normalized.startsWith('data:')) return;
    images.push({ src: normalized, alt, title: imgTitle, width, height, site_url: pageUrl });
  });

  return { title, description, keywords, lang, favicon, og_image, links, images };
}

module.exports = { fetchPage, parsePage, normalizeUrl, getDomain };
