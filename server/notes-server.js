'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { renderFragment: renderWmdFragment } = require('wmd');

const HOST = process.env.NOTES_HOST || '127.0.0.1';
const PORT = Number(process.env.NOTES_PORT || 8790);
const DATA_PATH = process.env.NOTES_DATA_PATH || path.join(__dirname, 'data', 'notes.json');
const ADMIN_PASSWORD = process.env.NOTES_ADMIN_PASSWORD;
const SECURE_COOKIE = process.env.NOTES_SECURE_COOKIE !== '0';
const SERVE_STATIC = process.env.NOTES_SERVE_STATIC === '1';
const SITE_ROOT = path.resolve(__dirname, '..');
const SITE_URL = (process.env.SITE_URL || 'https://remyellis.au').replace(/\/+$/, '');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES_PER_IP = 5;
const LOGIN_IP_BLOCK_MS = 30 * 60 * 1000;
const GLOBAL_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_FAILURE_THRESHOLD = 25;
const GLOBAL_SLOW_MODE_MS = 15 * 60 * 1000;
const GLOBAL_FAILURE_DELAY_MS = 10 * 1000;
const LOGIN_FAILURE_DELAYS_MS = [1000, 2000, 5000, 10000];
const COOKIE_NAME = 'remy_notes_session';

if (!ADMIN_PASSWORD) {
  console.error('NOTES_ADMIN_PASSWORD must be set.');
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('NOTES_PORT must be a valid TCP port.');
  process.exit(1);
}

const sessions = new Map();
const loginAttempts = new Map();
const globalLoginFailures = [];
let globalSlowModeUntil = 0;

function nowIso() {
  return new Date().toISOString();
}

function renderWikiMd(source) {
  const rendered = renderWmdFragment(String(source || ''), { html: true });
  return {
    html: rendered.html || '',
    compilerCss: rendered.css || '',
    warnings: Array.isArray(rendered.warnings) ? rendered.warnings : [],
  };
}

function baseHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...extra,
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, baseHeaders({
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  }));
  res.end(body);
}

function sendNoContent(res, extraHeaders = {}) {
  res.writeHead(204, {
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end();
}

function sendText(res, statusCode, body, contentType, extraHeaders = {}) {
  const text = String(body);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders,
  });
  if (res.req?.method === 'HEAD') {
    res.end();
  } else {
    res.end(text);
  }
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function ensureStore() {
  const dir = path.dirname(DATA_PATH);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ version: 1, notes: [] }, null, 2) + '\n', { mode: 0o600 });
  }
}

function readStore() {
  ensureStore();
  const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.notes)) {
    throw new Error('Notes data file has an unsupported format.');
  }
  return parsed;
}

function writeStore(store) {
  ensureStore();
  const dir = path.dirname(DATA_PATH);
  const tempPath = path.join(dir, `.notes-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tempPath, DATA_PATH);
}

function parseCookies(req) {
  const result = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function sessionCookie(token, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = SECURE_COOKIE ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAgeSeconds}`;
}

function expireSessionCookie() {
  const secure = SECURE_COOKIE ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Authentication required.' }, { 'Cache-Control': 'no-store' });
    return null;
  }
  return session;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function constantTimePasswordMatch(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const cloudflareIp = req.headers['cf-connecting-ip'];
  if (typeof cloudflareIp === 'string' && cloudflareIp.trim()) return cloudflareIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();

  return req.socket.remoteAddress || 'unknown';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pruneGlobalLoginFailures(now = Date.now()) {
  const cutoff = now - GLOBAL_LOGIN_WINDOW_MS;
  while (globalLoginFailures.length && globalLoginFailures[0] < cutoff) {
    globalLoginFailures.shift();
  }
}

function recordGlobalLoginFailure(now = Date.now()) {
  pruneGlobalLoginFailures(now);
  globalLoginFailures.push(now);

  if (globalLoginFailures.length >= GLOBAL_FAILURE_THRESHOLD) {
    globalSlowModeUntil = Math.max(globalSlowModeUntil, now + GLOBAL_SLOW_MODE_MS);
  }
}

function globalSlowModeActive(now = Date.now()) {
  pruneGlobalLoginFailures(now);
  if (globalSlowModeUntil <= now) {
    globalSlowModeUntil = 0;
    return false;
  }
  return true;
}

function loginRateState(ip, now = Date.now()) {
  const existing = loginAttempts.get(ip);

  if (!existing) {
    const fresh = {
      failures: 0,
      windowStartedAt: now,
      blockedUntil: 0,
    };
    loginAttempts.set(ip, fresh);
    return fresh;
  }

  if (existing.blockedUntil > now) return existing;

  if (existing.blockedUntil && existing.blockedUntil <= now) {
    existing.failures = 0;
    existing.windowStartedAt = now;
    existing.blockedUntil = 0;
    return existing;
  }

  if (existing.windowStartedAt + LOGIN_WINDOW_MS <= now) {
    existing.failures = 0;
    existing.windowStartedAt = now;
  }

  return existing;
}

function failureDelayMs(failures) {
  const index = Math.min(Math.max(failures, 1), LOGIN_FAILURE_DELAYS_MS.length) - 1;
  return LOGIN_FAILURE_DELAYS_MS[index];
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'untitled-note';
}

function plainTextFromBody(note) {
  let text;
  try {
    text = renderWikiMd(note.body).html;
  } catch {
    text = String(note.body || '');
  }

  return text
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeExcerpt(note) {
  const text = plainTextFromBody(note);
  if (text.length <= 360) return text;
  const sliced = text.slice(0, 360);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, lastSpace > 260 ? lastSpace : 360).trim()}…`;
}

function excerptSource(note) {
  const lines = String(note.body || '').split(/\r?\n/);
  const selected = [];
  let characters = 0;
  let substantiveLines = 0;
  let proseCloser = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (!proseCloser && trimmed === '[[[') {
      proseCloser = ']]]';
    }

    if (!trimmed) {
      if (selected.length) selected.push('');
    } else {
      selected.push(line);
      characters += line.length;
      substantiveLines += 1;
    }

    if (proseCloser && trimmed === proseCloser) {
      proseCloser = '';
    }

    if (!proseCloser && (substantiveLines >= 4 || characters >= 520)) break;
  }

  return selected.join('\n').trim();
}

function makeRenderedExcerpt(note) {
  const source = excerptSource(note);
  if (!source) return { html: '', css: '' };

  const rendered = renderWikiMd(source);
  const html = rendered.html.replace(
    /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    '<p class="note-excerpt-heading"><strong>$3</strong></p>'
  );

  return { html, css: rendered.compilerCss || '' };
}

function notePath(slug) {
  return `/notes/${encodeURIComponent(slug)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function safeStyleText(value) {
  return String(value || '').replace(/<\/style/gi, '<\\/style');
}

function sanitiseRenderedHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?(?:object|embed|base|meta)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
    .replace(/\s+(?:href|src|xlink:href)\s*=\s*javascript:[^\s>]+/gi, '');
}

function compactDescription(note) {
  const text = makeExcerpt(note);
  if (text.length <= 180) return text;
  const sliced = text.slice(0, 177);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, lastSpace > 130 ? lastSpace : 177).trim()}…`;
}

function displayDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function isoDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function renderNotePage(note) {
  const rendered = renderWikiMd(note.body);
  const canonicalUrl = `${SITE_URL}${notePath(note.slug)}`;
  const description = compactDescription(note);
  const publishedAt = isoDateTime(note.publishedAt) || `${note.date}T00:00:00.000Z`;
  const updatedAt = isoDateTime(note.updatedAt) || publishedAt;
  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: note.title,
    description,
    datePublished: publishedAt,
    dateModified: updatedAt,
    inLanguage: 'en-AU',
    mainEntityOfPage: canonicalUrl,
    author: {
      '@type': 'Person',
      '@id': `${SITE_URL}/#person`,
      name: 'Remy Ellis',
      url: `${SITE_URL}/`,
    },
    isPartOf: {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: 'Remy Ellis',
      url: `${SITE_URL}/`,
    },
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE HTML>
<html lang="en-AU">
<head>
  <title>${escapeHtml(note.title)} – Remy Ellis</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="author" content="Remy Ellis" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="theme-color" content="#0b7f98" />

  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <link rel="author" href="${SITE_URL}/" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Remy Ellis" />
  <meta property="og:title" content="${escapeHtml(note.title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:locale" content="en_AU" />
  <meta property="article:published_time" content="${escapeHtml(publishedAt)}" />
  <meta property="article:modified_time" content="${escapeHtml(updatedAt)}" />

  <script type="application/ld+json">${structuredData}</script>

  <link rel="icon" type="image/png" href="/assets/css/images/Signature.png" />
  <link rel="stylesheet" href="/assets/css/main.css" />
  <link rel="stylesheet" href="/assets/css/remy.css" />
  <link rel="stylesheet" href="/assets/css/notes.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />

  <style>
${safeStyleText(rendered.compilerCss)}
${safeStyleText(note.customCss || '')}
  </style>

  <noscript>
    <link rel="stylesheet" href="/assets/css/noscript.css" />
  </noscript>

  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script defer src="/assets/js/note-page.js"></script>
</head>

<body class="is-preload notes-page">
  <section id="sidebar">
    <div class="inner">
      <a class="site-mark" href="/" aria-label="Remy Ellis home">
        <img src="/assets/css/images/Signature.png" alt="RE" width="40" height="40" />
      </a>
      <nav aria-label="Note navigation">
        <ul>
          <li><a href="/">Home</a></li>
          <li><a class="active" href="/notes.html">Notes</a></li>
        </ul>
      </nav>
    </div>
  </section>

  <div id="wrapper">
    <section class="wrapper notes-hero fade-up">
      <div class="inner">
        <p class="eyebrow">Note</p>
        <h1>${escapeHtml(note.title)}</h1>
        <p class="lead"><time datetime="${escapeHtml(note.date)}">${escapeHtml(displayDate(note.date))}</time></p>
      </div>
    </section>

    <section class="wrapper section-shell notes-section fade-up">
      <div class="inner notes-inner">
        <article id="note-content" class="note-body">
${sanitiseRenderedHtml(rendered.html)}
        </article>
        <p><a class="text-link" href="/notes.html">← All notes</a></p>
      </div>
    </section>
  </div>

  <footer id="footer">
    <div class="inner">
      <p>&copy; 2026 Remy Ellis &nbsp;·&nbsp; <a href="/notes.html">Notes</a> &nbsp;·&nbsp; <a href="/">Home</a></p>
    </div>
  </footer>

  <script src="/assets/js/jquery.min.js"></script>
  <script src="/assets/js/jquery.scrollex.min.js"></script>
  <script src="/assets/js/jquery.scrolly.min.js"></script>
  <script src="/assets/js/browser.min.js"></script>
  <script src="/assets/js/breakpoints.min.js"></script>
  <script src="/assets/js/util.js"></script>
  <script src="/assets/js/main.js"></script>
</body>
</html>`;
}

function renderSitemap(notes) {
  const updatedValues = notes
    .map(note => isoDateTime(note.updatedAt || note.publishedAt))
    .filter(Boolean)
    .sort();
  const latestNotesUpdate = updatedValues.at(-1) || null;

  const entries = [
    { loc: `${SITE_URL}/` },
    { loc: `${SITE_URL}/notes.html`, lastmod: latestNotesUpdate },
    { loc: `${SITE_URL}/assets/A-Prime-Power-Obstruction-for-Equal-Divisor-Sums-at-Consecutive-Integers.pdf` },
    { loc: `${SITE_URL}/assets/Stale-Bread.pdf` },
    { loc: `${SITE_URL}/assets/What-You-Need-to-Know-About-Me.pdf` },
    ...notes.map(note => ({
      loc: `${SITE_URL}${notePath(note.slug)}`,
      lastmod: isoDateTime(note.updatedAt || note.publishedAt),
    })),
  ];

  const urls = entries.map(entry => {
    const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
    return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
  }).join('\n\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function publicSummary(note) {
  const renderedExcerpt = makeRenderedExcerpt(note);
  return {
    slug: note.slug,
    url: notePath(note.slug),
    title: note.title,
    date: note.date,
    format: 'wikimd',
    excerpt: makeExcerpt(note),
    excerptHtml: renderedExcerpt.html,
    excerptCss: renderedExcerpt.css,
    publishedAt: note.publishedAt,
    updatedAt: note.updatedAt,
  };
}

function publicNote(note) {
  const rendered = renderWikiMd(note.body);
  return {
    ...publicSummary(note),
    html: rendered.html,
    compilerCss: rendered.compilerCss,
    warnings: rendered.warnings,
    customCss: note.customCss || '',
  };
}

function normaliseNoteInput(input, existing, store) {
  const title = String(input.title ?? existing?.title ?? '').trim();
  if (!title || title.length > 180) {
    throw Object.assign(new Error('Title must be between 1 and 180 characters.'), { statusCode: 400 });
  }

  const requestedFormat = String(input.format ?? existing?.format ?? 'wikimd').toLowerCase();
  if (!['wikimd', 'markdown', 'html'].includes(requestedFormat)) {
    throw Object.assign(new Error('Unsupported note format.'), { statusCode: 400 });
  }
  const format = 'wikimd';

  const date = String(input.date ?? existing?.date ?? new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw Object.assign(new Error('Date must be YYYY-MM-DD.'), { statusCode: 400 });
  }

  const requestedSlug = String(input.slug ?? existing?.slug ?? '').trim();
  const slug = slugify(requestedSlug || title);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) {
    throw Object.assign(new Error('Slug contains unsupported characters.'), { statusCode: 400 });
  }

  const body = String(input.body ?? existing?.body ?? '');
  if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
    throw Object.assign(new Error('Note body is too large.'), { statusCode: 413 });
  }

  const customCss = String(input.customCss ?? existing?.customCss ?? '');
  if (Buffer.byteLength(customCss, 'utf8') > 64 * 1024) {
    throw Object.assign(new Error('Custom CSS is too large.'), { statusCode: 413 });
  }

  const collision = store.notes.find(note => note.slug === slug && note.id !== existing?.id);
  if (collision) {
    throw Object.assign(new Error('Another note already uses that slug.'), { statusCode: 409 });
  }

  return { title, slug, date, format, body, customCss };
}

function comparePublicFallback(a, b) {
  const byDate = b.date.localeCompare(a.date);
  if (byDate !== 0) return byDate;
  return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
}

function sortPublicNotes(notes) {
  return [...notes].sort((a, b) => {
    const aOrder = Number.isInteger(a.order) ? a.order : null;
    const bOrder = Number.isInteger(b.order) ? b.order : null;

    if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrder !== null && bOrder === null) return -1;
    if (aOrder === null && bOrder !== null) return 1;
    return comparePublicFallback(a, b);
  });
}

function sortAdminNotes(notes) {
  const drafts = notes
    .filter(note => note.status === 'draft')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const published = sortPublicNotes(notes.filter(note => note.status === 'published'));
  return [...drafts, ...published];
}

function routeParam(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length);
  if (!value || value.includes('/')) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

function staticContentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  if (!SERVE_STATIC || !['GET', 'HEAD'].includes(req.method)) return false;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  if (decodedPath.includes('\0')) return false;

  const relativePath = decodedPath === '/'
    ? 'index.html'
    : decodedPath.replace(/^\/+/, '');
  const publicPath = relativePath.split(path.sep).join('/');
  const allowedRootFiles = new Set(['index.html', 'notes.html', 'notes-admin.html']);
  if (!allowedRootFiles.has(publicPath) && !publicPath.startsWith('assets/')) return false;

  let filePath = path.resolve(SITE_ROOT, relativePath);
  const rootPrefix = `${SITE_ROOT}${path.sep}`;

  if (filePath !== SITE_ROOT && !filePath.startsWith(rootPrefix)) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.statSync(filePath);
    }
  } catch {
    return false;
  }

  if (!stat.isFile()) return false;

  const headers = {
    'Content-Type': staticContentType(filePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (['GET', 'HEAD'].includes(req.method) && pathname === '/sitemap.xml') {
    const store = readStore();
    const published = sortPublicNotes(store.notes.filter(note => note.status === 'published'));
    return sendText(res, 200, renderSitemap(published), 'application/xml; charset=utf-8', {
      'Cache-Control': 'no-cache',
    });
  }

  if (['GET', 'HEAD'].includes(req.method) && pathname === '/notes/') {
    res.writeHead(308, {
      Location: '/notes.html',
      'Cache-Control': 'public, max-age=3600',
    });
    return res.end();
  }

  if (['GET', 'HEAD'].includes(req.method)) {
    const slug = routeParam(pathname, '/notes/');
    if (slug) {
      const store = readStore();
      const note = store.notes.find(item => item.status === 'published' && item.slug === slug);
      if (!note) {
        return sendText(res, 404, 'Note not found.', 'text/plain; charset=utf-8', {
          'Cache-Control': 'no-cache',
          'X-Robots-Tag': 'noindex',
        });
      }
      return sendText(res, 200, renderNotePage(note), 'text/html; charset=utf-8', {
        'Cache-Control': 'no-cache',
        'Content-Language': 'en-AU',
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/notes') {
    const store = readStore();
    const published = sortPublicNotes(store.notes.filter(note => note.status === 'published'));
    return sendJson(res, 200, { notes: published.map(publicSummary) }, {
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  if (req.method === 'GET') {
    const slug = routeParam(pathname, '/api/notes/');
    if (slug) {
      const store = readStore();
      const note = store.notes.find(item => item.status === 'published' && item.slug === slug);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      return sendJson(res, 200, { note: publicNote(note) }, {
        'Cache-Control': 'no-cache',
        'X-Robots-Tag': 'noindex, nofollow',
      });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origin rejected.' }, { 'Cache-Control': 'no-store' });

    const now = Date.now();
    const ip = clientIp(req);
    const rate = loginRateState(ip, now);

    if (rate.blockedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((rate.blockedUntil - now) / 1000));
      return sendJson(res, 429, { error: 'Too many failed login attempts. Try again later.' }, {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfter),
      });
    }

    const body = await readJsonBody(req);
    if (!constantTimePasswordMatch(body.password)) {
      rate.failures += 1;
      recordGlobalLoginFailure();

      if (rate.failures >= MAX_LOGIN_FAILURES_PER_IP) {
        rate.blockedUntil = Date.now() + LOGIN_IP_BLOCK_MS;
      }

      const delay = globalSlowModeActive()
        ? Math.max(failureDelayMs(rate.failures), GLOBAL_FAILURE_DELAY_MS)
        : failureDelayMs(rate.failures);
      await sleep(delay);

      if (rate.blockedUntil > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((rate.blockedUntil - Date.now()) / 1000));
        return sendJson(res, 429, { error: 'Too many failed login attempts. Try again later.' }, {
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfter),
        });
      }

      return sendJson(res, 401, { error: 'Incorrect password.' }, { 'Cache-Control': 'no-store' });
    }

    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    return sendJson(res, 200, { authenticated: true }, {
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(token),
    });
  }

  if (pathname.startsWith('/api/admin/') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && !sameOrigin(req)) {
    return sendJson(res, 403, { error: 'Origin rejected.' }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    return sendNoContent(res, { 'Set-Cookie': expireSessionCookie() });
  }

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    if (!requireAuth(req, res)) return;
    return sendJson(res, 200, { authenticated: true }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'POST' && pathname === '/api/admin/render') {
    if (!requireAuth(req, res)) return;
    const input = await readJsonBody(req);
    const body = String(input.body || '');
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
      return sendJson(res, 413, { error: 'Note body is too large.' }, { 'Cache-Control': 'no-store' });
    }

    const rendered = renderWikiMd(body);
    return sendJson(res, 200, { rendered }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && pathname === '/api/admin/notes') {
    if (!requireAuth(req, res)) return;
    const store = readStore();
    const notes = sortAdminNotes(store.notes).map(note => ({
      id: note.id,
      title: note.title,
      slug: note.slug,
      date: note.date,
      format: note.format,
      status: note.status,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      publishedAt: note.publishedAt || null,
      order: Number.isInteger(note.order) ? note.order : null,
      excerpt: makeExcerpt(note),
    }));
    return sendJson(res, 200, { notes }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'PATCH' && pathname === '/api/admin/notes/order') {
    if (!requireAuth(req, res)) return;
    const store = readStore();
    const input = await readJsonBody(req);
    const ids = Array.isArray(input.ids) ? input.ids.map(id => String(id)) : null;

    if (!ids) {
      return sendJson(res, 400, { error: 'ids must be an array.' }, { 'Cache-Control': 'no-store' });
    }

    const published = store.notes.filter(note => note.status === 'published');
    const publishedIds = new Set(published.map(note => note.id));
    const requestedIds = new Set(ids);

    if (
      ids.length !== published.length ||
      requestedIds.size !== ids.length ||
      ids.some(id => !publishedIds.has(id))
    ) {
      return sendJson(res, 400, { error: 'Order must contain every published note exactly once.' }, { 'Cache-Control': 'no-store' });
    }

    const byId = new Map(store.notes.map(note => [note.id, note]));
    ids.forEach((id, index) => {
      byId.get(id).order = index;
    });

    writeStore(store);
    return sendJson(res, 200, { ordered: true }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET') {
    const id = routeParam(pathname, '/api/admin/notes/');
    if (id) {
      if (!requireAuth(req, res)) return;
      const store = readStore();
      const note = store.notes.find(item => item.id === id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' }, { 'Cache-Control': 'no-store' });
      return sendJson(res, 200, { note }, { 'Cache-Control': 'no-store' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/notes') {
    if (!requireAuth(req, res)) return;
    const store = readStore();
    const input = await readJsonBody(req);
    const values = normaliseNoteInput(input, null, store);
    const timestamp = nowIso();
    const note = {
      id: crypto.randomUUID(),
      ...values,
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
      publishedAt: null,
    };
    store.notes.push(note);
    writeStore(store);
    return sendJson(res, 201, { note }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'PUT') {
    const id = routeParam(pathname, '/api/admin/notes/');
    if (id) {
      if (!requireAuth(req, res)) return;
      const store = readStore();
      const index = store.notes.findIndex(item => item.id === id);
      if (index === -1) return sendJson(res, 404, { error: 'Note not found.' }, { 'Cache-Control': 'no-store' });
      const existing = store.notes[index];
      const input = await readJsonBody(req);
      const values = normaliseNoteInput(input, existing, store);
      const note = { ...existing, ...values, updatedAt: nowIso() };
      store.notes[index] = note;
      writeStore(store);
      return sendJson(res, 200, { note }, { 'Cache-Control': 'no-store' });
    }
  }

  const publishMatch = pathname.match(/^\/api\/admin\/notes\/([^/]+)\/publish$/);
  if (req.method === 'POST' && publishMatch) {
    if (!requireAuth(req, res)) return;
    const id = decodeURIComponent(publishMatch[1]);
    const store = readStore();
    const note = store.notes.find(item => item.id === id);
    if (!note) return sendJson(res, 404, { error: 'Note not found.' }, { 'Cache-Control': 'no-store' });
    if (!note.body.trim()) return sendJson(res, 400, { error: 'A note must have content before it can be published.' }, { 'Cache-Control': 'no-store' });

    const existingPublished = sortPublicNotes(
      store.notes.filter(item => item.status === 'published' && item.id !== note.id)
    );
    existingPublished.forEach((item, index) => {
      item.order = index + 1;
    });

    note.status = 'published';
    note.order = 0;
    note.updatedAt = nowIso();
    note.publishedAt = note.publishedAt || note.updatedAt;
    writeStore(store);
    return sendJson(res, 200, { note }, { 'Cache-Control': 'no-store' });
  }

  const unpublishMatch = pathname.match(/^\/api\/admin\/notes\/([^/]+)\/unpublish$/);
  if (req.method === 'POST' && unpublishMatch) {
    if (!requireAuth(req, res)) return;
    const id = decodeURIComponent(unpublishMatch[1]);
    const store = readStore();
    const note = store.notes.find(item => item.id === id);
    if (!note) return sendJson(res, 404, { error: 'Note not found.' }, { 'Cache-Control': 'no-store' });
    note.status = 'draft';
    note.order = null;
    note.updatedAt = nowIso();
    writeStore(store);
    return sendJson(res, 200, { note }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'DELETE') {
    const id = routeParam(pathname, '/api/admin/notes/');
    if (id) {
      if (!requireAuth(req, res)) return;
      const store = readStore();
      const index = store.notes.findIndex(item => item.id === id);
      if (index === -1) return sendJson(res, 404, { error: 'Note not found.' }, { 'Cache-Control': 'no-store' });
      store.notes.splice(index, 1);
      writeStore(store);
      return sendNoContent(res);
    }
  }

  if (!pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return;

  return sendJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) console.error(error);
    if (!res.headersSent) {
      sendJson(res, statusCode, { error: statusCode >= 500 ? 'Internal server error.' : error.message }, { 'Cache-Control': 'no-store' });
    } else {
      res.end();
    }
  });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [ip, state] of loginAttempts.entries()) {
    const windowExpired = state.windowStartedAt + LOGIN_WINDOW_MS <= now;
    const blockExpired = !state.blockedUntil || state.blockedUntil <= now;
    if (windowExpired && blockExpired) loginAttempts.delete(ip);
  }

  pruneGlobalLoginFailures(now);
  if (globalSlowModeUntil <= now) {
    globalSlowModeUntil = 0;
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, HOST, () => {
  ensureStore();
  console.log(`Notes server listening on http://${HOST}:${PORT}`);
  if (SERVE_STATIC) console.log(`Site: http://${HOST}:${PORT}/`);
  console.log(`Data file: ${DATA_PATH}`);
});
