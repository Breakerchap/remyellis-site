'use strict';

// Comments use a separate private JSON store; no visitor-controlled HTML is ever trusted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCommentMailer } = require('./comment-mailer');

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_GLOBAL = 60;
const attempts = new Map();
const allAttempts = [];
const previews = new Map();
const MAX_NAME = 60;
const MAX_COMMENT = 4000;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function commentError(message, code = 400) {
  return Object.assign(new Error(message), { statusCode: code });
}

function checkComment(source) {
  if (typeof source !== 'string' || source.trim().length < 3 || source.length > MAX_COMMENT) {
    throw commentError('Comments must contain 3–4000 characters.');
  }
  // Admin-only WMD directives are not allowed, even though our renderer never evaluates them.
  if (/^\s*@(?:config|endconfig|style|endstyle|tab|title)\b/im.test(source)) {
    throw commentError('Custom WMD configuration and styles are not supported in comments.');
  }
  return source.trim();
}

// Deliberately implement a small, safe WMD subset rather than using the
// unrestricted site-owner compiler. No arbitrary HTML, CSS, embeds or directives.
function inlineWmd(source) {
  const pattern = /(\x60[^\x60\n]+\x60|\[([^\]\n]{1,200})\]\(([^)\s]{1,1000})\)|\*([^*\n]+)\*|_([^_\n]+)_|<<<([^\n<>]+)>>>|<<([^\n<>]+)>>)/g;
  let output = '';
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    output += escapeHtml(source.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('\x60')) {
      output += '<code>' + escapeHtml(token.slice(1, -1)) + '</code>';
    } else if (match[2] !== undefined) {
      const rawUrl = match[3];
      let safe = false;
      try {
        const url = new URL(rawUrl, 'https://remyellis.au');
        safe = (url.protocol === 'https:' || url.protocol === 'http:') &&
          (/^https?:\/\//i.test(rawUrl) || (rawUrl.startsWith('/') && !rawUrl.startsWith('//')));
      } catch { /* invalid URL */ }
      output += safe
        ? '<a href="' + escapeHtml(rawUrl) + '" rel="nofollow ugc noopener noreferrer" target="_blank">' + escapeHtml(match[2]) + '</a>'
        : escapeHtml(token);
    } else if (match[4] !== undefined) {
      output += '<strong>' + escapeHtml(match[4]) + '</strong>';
    } else if (match[5] !== undefined) {
      output += '<em>' + escapeHtml(match[5]) + '</em>';
    } else {
      output += '<span class="comment-prose">' + escapeHtml(match[6] || match[7]) + '</span>';
    }
    last = match.index + token.length;
  }
  return output + escapeHtml(source.slice(last));
}

function renderComment(source) {
  const lines = checkComment(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  let listType = 'ul';
  let quote = [];
  let code = null;

  function flushParagraph() {
    if (paragraph.length) blocks.push('<p>' + paragraph.map(inlineWmd).join('<br>') + '</p>');
    paragraph = [];
  }
  function flushList() {
    if (list.length) blocks.push('<' + listType + '>' + list.map(item => '<li>' + inlineWmd(item) + '</li>').join('') + '</' + listType + '>');
    list = [];
  }
  function flushQuote() {
    if (quote.length) blocks.push('<blockquote><p>' + quote.map(inlineWmd).join('<br>') + '</p></blockquote>');
    quote = [];
  }
  for (const line of lines) {
    if (/^\s*\x60{3}/.test(line)) {
      flushParagraph(); flushList(); flushQuote();
      if (code !== null) {
        blocks.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph(); flushList(); flushQuote();
      continue;
    }
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const level = heading[1].length + 2;
      blocks.push('<h' + level + '>' + inlineWmd(heading[2]) + '</h' + level + '>');
    } else if (bullet || numbered) {
      flushParagraph(); flushQuote();
      const nextType = bullet ? 'ul' : 'ol';
      if (list.length && listType !== nextType) flushList();
      listType = nextType;
      list.push((bullet || numbered)[1]);
    } else if (quoted) {
      flushParagraph(); flushList(); quote.push(quoted[1]);
    } else {
      flushList(); flushQuote(); paragraph.push(line);
    }
  }
  flushParagraph(); flushList(); flushQuote();
  if (code !== null) blocks.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
  return blocks.join('\n');
}

function createComments(options) {
  const dataPath = process.env.COMMENTS_DATA_PATH ||
    path.join(path.dirname(options.notesDataPath), 'comments.json');
  const siteKey = process.env.COMMENTS_TURNSTILE_SITE_KEY || '';
  const secret = process.env.COMMENTS_TURNSTILE_SECRET || '';
  const testCredentials = siteKey === '1x00000000000000000000AA' &&
    secret === '1x0000000000000000000000000000000AA';
  // Public test credentials are intentionally unsafe on the production website.
  const development = process.env.NOTES_SERVE_STATIC === '1' &&
    ['127.0.0.1', 'localhost', '::1'].includes(process.env.NOTES_HOST || '127.0.0.1');
  const enabled = Boolean(siteKey && secret && (!testCredentials || development));
  const siteUrl = new URL(options.siteUrl);
  const allowedHosts = new Set([siteUrl.hostname, ...String(process.env.COMMENTS_ALLOWED_HOSTNAMES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)]);

  function read() {
    fs.mkdirSync(path.dirname(dataPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(dataPath)) {
      fs.writeFileSync(dataPath, JSON.stringify({ version: 1, comments: [] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.comments)) throw new Error('Unsupported comments file.');
    return data;
  }

  function write(data) {
    const temp = dataPath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temp, dataPath);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  function publicComment(comment) {
    return {
      id: comment.id,
      parentId: comment.parentId,
      name: comment.author ? 'Remy Ellis' : comment.name,
      author: Boolean(comment.author),
      createdAt: comment.createdAt,
      html: renderComment(comment.body),
    };
  }

  function pruneRateLimit() {
    const cutoff = Date.now() - WINDOW_MS;
    while (allAttempts.length && allAttempts[0] < cutoff) allAttempts.shift();
    for (const [key, times] of attempts) {
      const live = times.filter(t => t >= cutoff);
      if (live.length) attempts.set(key, live);
      else attempts.delete(key);
    }
  }

  function rateLimit(ip) {
    pruneRateLimit();
    const key = crypto.createHash('sha256').update(ip).digest('hex');
    const times = attempts.get(key) || [];
    if (times.length >= MAX_PER_IP || allAttempts.length >= MAX_GLOBAL) {
      throw commentError('Too many comments. Please try again later.', 429);
    }
    // Count even invalid submissions so failed challenges cannot be retried indefinitely.
    const now = Date.now();
    if (attempts.size >= 5000 && !attempts.has(key)) throw commentError('Please try again later.', 429);
    times.push(now);
    attempts.set(key, times);
    allAttempts.push(now);
  }

  async function verifyTurnstile(token) {
    if (!enabled) throw commentError('Comment submissions are not configured yet.', 503);
    if (typeof token !== 'string' || token.length < 1 || token.length > 2048) {
      throw commentError('Please complete the spam check.');
    }
    let response;
    try {
      response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw commentError('Spam check temporarily unavailable. Please try again.', 503);
    }
    if (!response.ok) throw commentError('Spam check temporarily unavailable. Please try again.', 503);
    const result = await response.json();
    // Hostname check is relaxed only for Cloudflare's published test keys.
    if (!result.success || (!testCredentials && !allowedHosts.has(String(result.hostname || '').toLowerCase()))) {
      throw commentError('Spam check failed or expired. Please try again.');
    }
  }

  const mailer = createCommentMailer({
    readStore: read,
    writeStore: write,
    readNotes: options.readNotes,
    siteUrl: options.siteUrl,
  });

  function findPublished(slug) {
    return options.readNotes().notes.find(n => n.slug === slug && n.status === 'published');
  }

  function serializeAdmin(data) {
    const notes = new Map(options.readNotes().notes.map(n => [n.id, n]));
    return data.comments.slice().reverse().map(comment => ({
      ...comment,
      html: renderComment(comment.body),
      noteTitle: notes.get(comment.noteId)?.title || '(deleted note)',
      noteUrl: notes.get(comment.noteId)?.status === 'published'
        ? '/notes/' + encodeURIComponent(notes.get(comment.noteId).slug) + '#comments' : null,
    }));
  }

  async function route(req, res, pathname) {
    const json = (code, value) => options.sendJson(res, code, value, {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    if (req.method === 'GET' && pathname === '/api/comments/config') {
      json(200, { enabled, siteKey: enabled ? siteKey : '', owner: Boolean(options.getSession(req)) });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/comments/preview') {
      if (!req.headers.origin || !options.sameOrigin(req)) throw commentError('Origin rejected.', 403);
      const ip = crypto.createHash('sha256').update(options.clientIp(req)).digest('hex');
      const now = Date.now();
      for (const [key, times] of previews) {
        const recent = times.filter(t => t > now - 60000);
        if (recent.length) previews.set(key, recent); else previews.delete(key);
      }
      const times = previews.get(ip) || [];
      if (times.length >= 20 || previews.size > 2000) throw commentError('Too many previews.', 429);
      times.push(now);
      previews.set(ip, times);
      const input = await options.readJsonBody(req);
      json(200, { html: renderComment(input.body) });
      return true;
    }

    const publicMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (publicMatch && (req.method === 'GET' || req.method === 'POST')) {
      let slug;
      try { slug = decodeURIComponent(publicMatch[1]); } catch { throw commentError('Invalid note.', 404); }
      const note = findPublished(slug);
      if (!note) throw commentError('Note not found.', 404);
      if (req.method === 'GET') {
        const approved = read().comments.filter(c => c.noteId === note.id && c.status === 'approved');
        const visibleIds = new Set(approved.filter(c => !c.parentId).map(c => c.id));
        const comments = approved.filter(c => !c.parentId || visibleIds.has(c.parentId)).map(publicComment);
        json(200, { comments });
        return true;
      }
      // Require an actual browser Origin for anonymous writes, not just an absent/matching Origin.
      if (!req.headers.origin || !options.sameOrigin(req)) throw commentError('Origin rejected.', 403);
      const owner = Boolean(options.getSession(req));
      if (!owner) rateLimit(options.clientIp(req));
      const input = await options.readJsonBody(req);
      if (!owner && input.website) { json(202, { pending: true }); return true; } // honeypot
      const name = owner ? 'Remy Ellis' : (typeof input.name === 'string' ? input.name.trim() : '');
      if (!owner && (name.length < 2 || name.length > MAX_NAME || /[\u0000-\u001f\u007f<>]/.test(name))) {
        throw commentError('Please provide a name (2–60 characters).');
      }
      if (!owner && /\bremy\b|\badmin\b|\bauthor\b|r[\W_]*h[\W_]*ellis/i.test(name)) {
        throw commentError('That name is reserved for the site author.');
      }
      const body = checkComment(input.body);
      renderComment(body); // Validate before verification.
      const data = read();
      let parentId = null;
      if (input.parentId != null) {
        if (typeof input.parentId !== 'string') throw commentError('Invalid reply.');
        const parent = data.comments.find(c => c.id === input.parentId &&
          c.noteId === note.id && c.status === 'approved');
        if (!parent) throw commentError('The comment being replied to is unavailable.', 404);
        parentId = parent.parentId || parent.id; // one level of nesting
      }
      if (!owner) await verifyTurnstile(input.turnstileToken);
      const comment = {
        id: crypto.randomUUID(), noteId: note.id, parentId, name, body,
        author: owner, status: owner ? 'approved' : 'pending', createdAt: new Date().toISOString(),
        ...(!owner ? { emailNotice: { status: 'queued', attempts: 0 } } : {}),
      };
      // Reload after network verification so writes from other requests are not lost.
      const fresh = read();
      fresh.comments.push(comment);
      write(fresh);
      if (!owner) mailer.schedule();
      json(201, {
        pending: !owner,
        message: owner ? 'Your author comment is published.' : 'Thanks – your comment is awaiting approval.',
      });
      return true;
    }

    if (!pathname.startsWith('/api/admin/comments')) return false;
    if (!options.requireAuth(req, res)) return true;
    if (req.method !== 'GET' && (!req.headers.origin || !options.sameOrigin(req))) {
      throw commentError('Origin rejected.', 403);
    }
    const data = read();
    if (req.method === 'GET' && pathname === '/api/admin/comments/mail-status') {
      json(200, { mail: mailer.status() });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/admin/comments/test-email') {
      try {
        await mailer.sendTest();
      } catch (error) {
        console.error('Notes comment test email failed:', error.message);
        json(503, { error: 'Test email could not be delivered. Check the Notes service logs and mail configuration.' });
        return true;
      }
      json(200, { message: 'Test email sent to the configured address.' });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/admin/comments') {
      const comments = serializeAdmin(data);
      json(200, { comments, pendingCount: comments.filter(c => c.status === 'pending').length });
      return true;
    }
    const action = pathname.match(/^\/api\/admin\/comments\/([a-f0-9-]+)\/(approve|reject|reply|edit)$/);
    if (action && req.method === 'POST') {
      const comment = data.comments.find(c => c.id === action[1]);
      if (!comment) throw commentError('Comment not found.', 404);
      if (action[2] === 'edit') {
        const input = await options.readJsonBody(req);
        comment.body = checkComment(input.body);
        comment.editedAt = new Date().toISOString();
        write(data);
        json(200, { updated: true });
        return true;
      }
      if (action[2] === 'reply') {
        if (comment.status !== 'approved') throw commentError('Approve the original comment before replying.');
        const input = await options.readJsonBody(req);
        const body = checkComment(input.body);
        const reply = {
          id: crypto.randomUUID(), noteId: comment.noteId, parentId: comment.parentId || comment.id,
          name: 'Remy Ellis', body, author: true, status: 'approved', createdAt: new Date().toISOString(),
        };
        data.comments.push(reply);
        write(data);
        json(201, { comment: publicComment(reply) });
        return true;
      }
      comment.status = action[2] === 'approve' ? 'approved' : 'rejected';
      comment.reviewedAt = new Date().toISOString();
      write(data);
      json(200, { updated: true });
      return true;
    }
    const remove = pathname.match(/^\/api\/admin\/comments\/([a-f0-9-]+)$/);
    if (remove && req.method === 'DELETE') {
      const before = data.comments.length;
      // When removing a parent, remove its replies too; no orphaned threads.
      const descendants = new Set([remove[1]]);
      data.comments = data.comments.filter(c => !descendants.has(c.id) && !descendants.has(c.parentId));
      if (data.comments.length === before) throw commentError('Comment not found.', 404);
      write(data);
      options.sendNoContent(res, { 'Cache-Control': 'no-store' });
      return true;
    }
    return false;
  }

  return {
    route,
    deleteForNote(id) {
      if (!fs.existsSync(dataPath)) return;
      const data = read();
      data.comments = data.comments.filter(c => c.noteId !== id);
      write(data);
    },
    dataPath,
  };
}

module.exports = { createComments, renderComment, checkComment };
