'use strict';

const { spawn } = require('node:child_process');

function emailAddress(value) {
  return typeof value === 'string' && /^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/.test(value);
}

function formatNotice({ to, from, siteUrl, note, comment, test = false }) {
  // All header fields are configured by the site operator, never submitted by visitors.
  if (!emailAddress(to) || !emailAddress(from)) throw new Error('Invalid notification email settings.');
  const adminUrl = new URL('/notes-admin.html#comments', siteUrl).href;
  const noteUrl = note ? new URL('/notes/' + encodeURIComponent(note.slug) + '#comments', siteUrl).href : '';
  const subject = test ? 'Notes comments: test email' : 'New Notes comment awaiting approval';
  const text = test
    ? 'This is a test notification from your Notes comments service.\n\nIf you received it, email delivery is configured correctly.\n\nModeration: ' + adminUrl
    : [
      comment.parentId ? 'A visitor has replied to a comment.' : 'A visitor has left a new comment.',
      '',
      'Note: ' + String(note?.title || '(unknown note)').replace(/[\r\n]/g, ' '),
      'Name: ' + String(comment.name).replace(/[\r\n]/g, ' '),
      'Submitted: ' + comment.createdAt,
      '',
      'Comment:',
      String(comment.body),
      '',
      'Moderate: ' + adminUrl,
      'View note: ' + noteUrl,
      '',
      'This comment is not public until you approve it.',
    ].join('\n');

  return [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
    '',
    text,
    '',
  ].join('\r\n');
}

function spawnSendmail(program, args, message, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let settled = false;
    let errorText = '';
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Mail transport timed out.'));
    }, timeoutMs);
    timer.unref();
    child.on('error', finish);
    child.on('close', code => {
      finish(code === 0 ? null : new Error('Mail transport exited ' + code + ': ' + errorText.slice(0, 160)));
    });
    child.stderr.on('data', chunk => {
      errorText = (errorText + String(chunk)).slice(-300);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  });
}

function createCommentMailer({
  readStore,
  writeStore,
  readNotes,
  siteUrl,
  environment = process.env,
  send = spawnSendmail,
  logger = console,
  now = () => Date.now(),
  startTimer = true,
}) {
  const to = environment.COMMENTS_NOTIFY_EMAIL || '';
  const from = environment.COMMENTS_NOTIFY_FROM || to;
  const program = environment.COMMENTS_SENDMAIL_PATH || '';
  const msmtpConfig = environment.COMMENTS_MSMTP_CONFIG || '';
  const enabled = Boolean(emailAddress(to) && emailAddress(from) && program &&
    (!msmtpConfig || msmtpConfig.startsWith('/')));
  const args = msmtpConfig ? ['--file=' + msmtpConfig, '-t', '-i'] : ['-t', '-i'];
  let running = false;
  let testSentAt = 0;

  function mark(commentId, update) {
    const data = readStore();
    const existing = data.comments.find(c => c.id === commentId);
    if (!existing || !existing.emailNotice || existing.emailNotice.status !== 'queued') return;
    existing.emailNotice = { ...existing.emailNotice, ...update };
    writeStore(data);
  }

  async function sendOne(comment) {
    const notes = readNotes().notes || [];
    const note = notes.find(n => n.id === comment.noteId);
    const message = formatNotice({ to, from, siteUrl, note, comment });
    await send(program, args, message);
  }

  async function flush() {
    if (!enabled || running) return;
    running = true;
    try {
      const pending = readStore().comments.filter(c =>
        !c.author && c.emailNotice?.status === 'queued' &&
        (!c.emailNotice.retryAt || c.emailNotice.retryAt <= now())).slice(0, 10);
      for (const comment of pending) {
        try {
          await sendOne(comment);
          mark(comment.id, { status: 'sent', sentAt: new Date(now()).toISOString(), retryAt: null });
        } catch (error) {
          const attempts = (comment.emailNotice.attempts || 0) + 1;
          // Retry temporarily unavailable mail servers. Cap delays at 1 hour.
          const wait = Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempts - 1, 6)));
          mark(comment.id, {
            attempts,
            retryAt: now() + wait,
            lastErrorAt: new Date(now()).toISOString(),
          });
          logger.error('Notes comment email not delivered, will retry:', error.message);
        }
      }
    } catch (error) {
      logger.error('Notes comment email queue could not be processed:', error);
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (!enabled) return;
    setImmediate(() => { void flush(); });
  }

  async function sendTest() {
    if (!enabled) throw new Error('Set COMMENTS_NOTIFY_EMAIL and COMMENTS_SENDMAIL_PATH first.');
    if (testSentAt && now() - testSentAt < 60 * 1000) {
      throw new Error('Wait one minute before sending another test email.');
    }
    testSentAt = now();
    await send(program, args, formatNotice({ to, from, siteUrl, test: true }));
  }

  function status() {
    const queued = readStore().comments.filter(c => c.emailNotice?.status === 'queued').length;
    return { configured: enabled, destination: enabled ? to : null, queued };
  }

  if (startTimer) {
    const timer = setInterval(() => { void flush(); }, 60 * 1000);
    timer.unref();
    schedule();
  }

  return { schedule, flush, sendTest, status };
}

module.exports = { createCommentMailer, formatNotice, spawnSendmail };
