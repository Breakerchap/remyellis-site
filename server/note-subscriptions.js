'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSendmail } = require('./comment-mailer');

const TOKEN_RE = /^[a-f0-9]{64}$/;
const GENERIC_MESSAGE = 'If that address can subscribe, a confirmation email will arrive shortly.';
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value) &&
    !value.includes('..');
}
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cleanSubject(value) {
  return String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
}
function composeEmail({ from, to, subject, text, unsubscribeUrl }) {
  const headers = [
    'From: ' + from, 'To: ' + to, 'Subject: ' + cleanSubject(subject),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit', 'Auto-Submitted: auto-generated',
  ];
  if (unsubscribeUrl) {
    headers.push('List-Unsubscribe: <' + unsubscribeUrl + '>');
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  return [...headers, '', String(text), ''].join('\r\n');
}

function tokenPage({ title, message, action, button }) {
  // No scripts or third-party resources. A link scanner fetching this GET page
  // cannot confirm or unsubscribe; the user must submit the form.
  return '<!doctype html><html lang="en-AU"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>' + escapeHtml(title) + ' – Remy Ellis</title>' +
    '<style>body{margin:7vh auto;padding:0 1.4rem;max-width:36rem;' +
    'font:16px/1.65 system-ui,sans-serif;color:#294454;background:#f9fcfd}' +
    'h1{font-size:1.7rem;line-height:1.3}p{margin:1rem 0}' +
    'button{background:#087e92;color:white;border:0;border-radius:5px;' +
    'padding:.6rem 1rem;font:600 14px system-ui;cursor:pointer}' +
    'a{color:#087e92}</style></head><body><main><h1>' + escapeHtml(title) +
    '</h1><p>' + escapeHtml(message) + '</p>' +
    (action ? '<form method="POST" action="' + escapeHtml(action) + '">' +
      '<button type="submit">' + escapeHtml(button) + '</button></form>' : '') +
    '<p><a href="/notes.html">Back to Notes</a></p></main></body></html>';
}

function createNoteSubscriptions({
  dataPath, siteUrl, readNotes, readJsonBody, sameOrigin, clientIp,
  environment = process.env, send = spawnSendmail, logger = console,
  now = () => Date.now(), startTimer = true,
}) {
  const file = dataPath || path.join(process.cwd(), 'notes-subscribers.json');
  const from = environment.NOTES_SUBSCRIBE_FROM || environment.COMMENTS_NOTIFY_FROM || '';
  const transport = environment.COMMENTS_SENDMAIL_PATH || '';
  const config = environment.COMMENTS_MSMTP_CONFIG || '';
  const enabled = validEmail(from) && transport.startsWith('/') &&
    (!config || config.startsWith('/'));
  const args = config ? ['--file=' + config, '-t', '-i'] : ['-t', '-i'];
  const site = new URL(siteUrl);
  const attempts = new Map();
  const globalAttempts = [];
  let flushing = false;

  function read() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, subscribers: [], deliveries: [] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== 1 || !Array.isArray(data.subscribers) || !Array.isArray(data.deliveries)) {
      throw new Error('Unsupported subscription data format.');
    }
    return data;
  }
  function write(data) {
    const temp = file + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function postMail(to, message) {
    return send(transport, args, message);
  }
  function subscribe(email, ip) {
    if (!enabled) throw Object.assign(new Error('Subscriptions are not configured yet.'), { statusCode: 503 });
    const key = crypto.createHash('sha256').update(String(ip)).digest('hex');
    const current = now();
    while (globalAttempts.length && globalAttempts[0] < current - HOUR_MS) globalAttempts.shift();
    for (const [hash, times] of attempts) {
      const fresh = times.filter(t => t >= current - HOUR_MS);
      if (fresh.length) attempts.set(hash, fresh); else attempts.delete(hash);
    }
    const perIp = attempts.get(key) || [];
    if (perIp.length >= 6 || globalAttempts.length >= 80) {
      throw Object.assign(new Error('Please try again later.'), { statusCode: 429 });
    }
    perIp.push(current); attempts.set(key, perIp); globalAttempts.push(current);
    // Deliberately give indistinguishable responses for active, invalid and pending addresses.
    if (!validEmail(email)) return;
    const normalised = email.trim().toLowerCase();
    const data = read();
    let subscriber = data.subscribers.find(x => x.email === normalised);
    if (subscriber && (subscriber.status === 'active' ||
        current - subscriber.requestedAt < RESEND_COOLDOWN_MS)) return;
    if (!subscriber) {
      subscriber = { id: crypto.randomUUID(), email: normalised, status: 'pending',
        requestedAt: 0, unsubscribeToken: randomToken(), createdAt: new Date(current).toISOString() };
      data.subscribers.push(subscriber);
    }
    subscriber.status = 'pending';
    subscriber.confirmToken = randomToken();
    subscriber.confirmExpires = current + CONFIRM_TTL_MS;
    subscriber.confirmMail = { status: 'queued', attempts: 0 };
    subscriber.requestedAt = current;
    subscriber.unsubscribeToken = randomToken();
    write(data);
    schedule();
  }

  function confirm(token) {
    if (!TOKEN_RE.test(token || '')) return false;
    const data = read();
    const subscriber = data.subscribers.find(s => s.status === 'pending' &&
      s.confirmToken === token && s.confirmExpires > now());
    if (!subscriber) return false;
    subscriber.status = 'active';
    subscriber.confirmToken = null;
    subscriber.confirmExpires = null;
    subscriber.confirmMail = null;
    subscriber.confirmedAt = new Date(now()).toISOString();
    write(data);
    return true;
  }

  function unsubscribe(token) {
    if (!TOKEN_RE.test(token || '')) return false;
    const data = read();
    const subscriber = data.subscribers.find(s => s.unsubscribeToken === token);
    if (!subscriber) return false;
    subscriber.status = 'unsubscribed';
    subscriber.confirmToken = null;
    subscriber.confirmExpires = null;
    subscriber.confirmMail = null;
    subscriber.unsubscribedAt = new Date(now()).toISOString();
    data.deliveries = data.deliveries.filter(d => d.subscriberId !== subscriber.id);
    write(data);
    return true;
  }

  function enqueuePublishedNote(note) {
    if (!enabled) return 0;
    const data = read();
    const audience = data.subscribers.filter(s => s.status === 'active');
    for (const subscriber of audience) {
      if (data.deliveries.some(d => d.noteId === note.id && d.subscriberId === subscriber.id)) continue;
      data.deliveries.push({
        id: crypto.randomUUID(), noteId: note.id, subscriberId: subscriber.id,
        status: 'queued', attempts: 0, createdAt: now(),
      });
    }
    write(data);
    schedule();
    return audience.length;
  }

  async function flush() {
    if (!enabled || flushing) return;
    flushing = true;
    try {
      const snapshot = read();
      const pending = [];
      for (const subscriber of snapshot.subscribers) {
        if (subscriber.status === 'pending' && subscriber.confirmMail?.status === 'queued' &&
            subscriber.confirmExpires > now() &&
            (!subscriber.confirmMail.retryAt || subscriber.confirmMail.retryAt <= now())) {
          pending.push({ kind: 'confirm', id: subscriber.id });
        }
      }
      for (const delivery of snapshot.deliveries) {
        if (delivery.status === 'queued' && (!delivery.retryAt || delivery.retryAt <= now())) {
          pending.push({ kind: 'note', id: delivery.id });
        }
      }
      for (const job of pending.slice(0, 15)) {
        const data = read();
        const subscriber = job.kind === 'confirm'
          ? data.subscribers.find(s => s.id === job.id && s.status === 'pending')
          : data.subscribers.find(s => s.id === data.deliveries.find(d => d.id === job.id)?.subscriberId && s.status === 'active');
        if (!subscriber) {
          if (job.kind === 'note') {
            data.deliveries = data.deliveries.filter(d => d.id !== job.id);
            write(data);
          }
          continue;
        }
        const delivery = data.deliveries.find(d => d.id === job.id);
        const currentJob = job.kind === 'confirm' ? subscriber.confirmMail : delivery;
        if (!currentJob || currentJob.status !== 'queued') continue;
        if (currentJob.retryAt && currentJob.retryAt > now()) continue;
        let message;
        if (job.kind === 'confirm') {
          if (!subscriber.confirmToken || subscriber.confirmExpires <= now()) continue;
          const link = new URL('/api/notes-subscriptions/confirm?token=' + subscriber.confirmToken, site).href;
          message = composeEmail({
            from, to: subscriber.email, subject: 'Confirm your Notes subscription',
            text: 'You (or someone using this email address) requested updates when I publish new Notes.\n\n' +
              'Confirm your subscription:\n' + link + '\n\n' +
              'If you did not request this, ignore this email. The link expires in 48 hours.\n\n– Remy Ellis',
          });
        } else {
          const note = readNotes().notes.find(n => n.id === delivery.noteId && n.status === 'published');
          if (!note) {
            data.deliveries = data.deliveries.filter(d => d.id !== job.id);
            write(data);
            continue;
          }
          const url = new URL('/notes/' + encodeURIComponent(note.slug), site).href;
          const unsubscribeUrl = new URL('/api/notes-subscriptions/unsubscribe?token=' + subscriber.unsubscribeToken, site).href;
          const manageUrl = new URL('/api/notes-subscriptions/unsubscribe?token=' + subscriber.unsubscribeToken, site).href;
          message = composeEmail({
            from, to: subscriber.email,
            subject: 'New Notes: ' + note.title,
            text: 'A new note has been published on remyellis.au.\n\n' +
              cleanSubject(note.title) + '\n' + url + '\n\n' +
              'You are receiving this because you subscribed to Notes by Remy Ellis.\n' +
              'Unsubscribe: ' + manageUrl,
            unsubscribeUrl,
          });
        }

        try {
          await postMail(subscriber.email, message);
          // Re-read to avoid resurrecting an unsubscribe while SMTP was in flight.
          const fresh = read();
          if (job.kind === 'confirm') {
            const target = fresh.subscribers.find(s => s.id === job.id && s.status === 'pending');
            if (target && target.confirmMail?.status === 'queued') target.confirmMail = { status: 'sent', sentAt: now() };
          } else {
            const target = fresh.deliveries.find(d => d.id === job.id);
            if (target?.status === 'queued') Object.assign(target, { status: 'sent', sentAt: now(), retryAt: null });
          }
          write(fresh);
        } catch (error) {
          logger.error('Notes subscription mail delivery failed:', error.message);
          const fresh = read();
          const target = job.kind === 'confirm'
            ? fresh.subscribers.find(s => s.id === job.id)?.confirmMail
            : fresh.deliveries.find(d => d.id === job.id);
          if (target?.status === 'queued') {
            target.attempts = (target.attempts || 0) + 1;
            target.retryAt = now() + Math.min(3600000, 60000 * 2 ** Math.min(target.attempts - 1, 6));
            write(fresh);
          }
        }
      }
      // Keep delivery history for de-duplication on republish; purge none automatically.
    } catch (error) { logger.error('Notes subscription mail queue error:', error); }
    finally { flushing = false; }
  }

  function schedule() { if (enabled && startTimer) setImmediate(() => { void flush(); }); }

  function page(res, status, html) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
  }

  async function route(req, res, pathname, url, sendJson) {
    if (pathname === '/api/notes-subscriptions/config' && req.method === 'GET') {
      sendJson(res, 200, { enabled: Boolean(enabled) }, { 'Cache-Control': 'no-store' });
      return true;
    }
    if (pathname === '/api/notes-subscriptions' && req.method === 'POST') {
      if (!req.headers.origin || !sameOrigin(req)) {
        sendJson(res, 403, { error: 'Origin rejected.' }, { 'Cache-Control': 'no-store' }); return true;
      }
      const input = await readJsonBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        sendJson(res, 400, { error: 'Invalid subscription request.' }, { 'Cache-Control': 'no-store' });
        return true;
      }
      if (!input.website) subscribe(input.email, clientIp(req));
      sendJson(res, 200, { message: GENERIC_MESSAGE }, { 'Cache-Control': 'no-store' });
      return true;
    }

    const kinds = {
      '/api/notes-subscriptions/confirm': 'confirm',
      '/api/notes-subscriptions/unsubscribe': 'unsubscribe',
    };
    if (pathname in kinds && req.method === 'GET') {
      const kind = kinds[pathname];
      const token = url.searchParams.get('token') || '';
      const valid = TOKEN_RE.test(token);
      const title = kind === 'confirm' ? 'Confirm your subscription' : 'Unsubscribe from Notes';
      const action = '/api/notes-subscriptions/' + kind + '?token=' + encodeURIComponent(token);
      page(res, 200, tokenPage({
        title,
        message: valid
          ? (kind === 'confirm' ? 'Confirm to receive an email whenever I publish a new note.' :
            'You can stop Notes emails at any time. Click below to unsubscribe.')
          : 'This link is invalid.',
        action: valid ? action : null,
        button: kind === 'confirm' ? 'Confirm subscription' : 'Unsubscribe',
      }));
      return true;
    }

    if (pathname === '/api/notes-subscriptions/confirm' && req.method === 'POST') {
      const done = confirm(url.searchParams.get('token'));
      page(res, 200, tokenPage({
        title: done ? 'Subscription confirmed' : 'Link expired or already used',
        message: done ? "Thanks – you'll receive an email when I publish a new note." :
          'Please subscribe again from the Notes page if you still want updates.',
      }));
      return true;
    }
    if (pathname === '/api/notes-subscriptions/unsubscribe' && req.method === 'POST') {
      unsubscribe(url.searchParams.get('token'));
      page(res, 200, tokenPage({
        title: 'Unsubscribed',
        message: "You won't receive any more Notes updates. You can subscribe again whenever you like.",
      }));
      return true;
    }
    return false;
  }

  function status() {
    const data = read();
    return { configured: Boolean(enabled), active: data.subscribers.filter(s => s.status === 'active').length };
  }

  if (startTimer) {
    const timer = setInterval(() => { void flush(); }, 60000);
    timer.unref();
    schedule();
  }

  return { route, flush, subscribe, confirm, unsubscribe, enqueuePublishedNote, status, dataPath: file };
}

module.exports = { createNoteSubscriptions, composeEmail, validEmail };
