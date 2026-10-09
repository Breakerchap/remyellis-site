'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNoteSubscriptions, composeEmail, validEmail } = require('./note-subscriptions');

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-subscribe-'));
  const file = path.join(dir, 'private', 'notes-subscribers.json');
  const published = { id: 'note-1', slug: 'stacking', title: 'The Stacking Problem', status: 'published' };
  const notes = [published];
  const sent = [];
  const failures = [];
  let clock = Date.parse('2026-10-09T06:00:00Z');
  let failed = false;
  const mailer = createNoteSubscriptions({
    dataPath: file,
    siteUrl: 'https://remyellis.au',
    readNotes: () => ({ notes }),
    readJsonBody: async req => req.input,
    sameOrigin: () => true,
    clientIp: req => req.ip || '203.0.113.5',
    environment: {
      NOTES_SUBSCRIBE_FROM: 'notifications@remyellis.au',
      COMMENTS_SENDMAIL_PATH: '/usr/bin/msmtp',
      COMMENTS_MSMTP_CONFIG: '/var/lib/remy-notes/msmtp.conf',
      ...(options.notifyEmail ? { COMMENTS_NOTIFY_EMAIL: options.notifyEmail } : {}),
    },
    now: () => clock,
    startTimer: false,
    send: async (program, args, raw) => {
      if (failed) throw new Error('Temporary SMTP outage');
      sent.push({ program, args, raw });
    },
    logger: { error: e => failures.push(e) },
  });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return {
    mailer, notes, sent, failures, read, cleanup,
    tick: ms => { clock += ms; },
    breakSmtp: bool => { failed = bool; },
    time: () => clock,
  };
}
test('safe email formats and list unsubscribe headers', () => {
  assert.ok(validEmail('remy@remyellis.au'));
  assert.equal(validEmail('test,another@example.com'), false);
  assert.equal(validEmail('x\r\nBcc:other@example.com'), false);
  const message = composeEmail({
    from: 'notifications@remyellis.au', to: 'someone@example.com',
    subject: 'Hi\r\nBcc: bad', text: 'New Notes',
    unsubscribeUrl: 'https://remyellis.au/api/notes-subscriptions/unsubscribe?token=' + 'a'.repeat(64),
  });
  assert.match(message, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.doesNotMatch(message, /\r\nBcc:/);
  assert.match(message, /Content-Type: text\/plain/);
});

test('double opt-in: only confirmed recipients receive initial-publication updates', async t => {
  const m = setup(); t.after(m.cleanup);
  assert.deepEqual(m.mailer.status(), { configured: true, active: 0 });

  m.mailer.subscribe('Sample@Example.COM', 'ip-one');
  let store = m.read();
  assert.equal(store.subscribers[0].email, 'sample@example.com');
  assert.equal(store.subscribers[0].status, 'pending');
  assert.equal(store.subscribers[0].confirmMail.status, 'queued');
  assert.equal(m.mailer.enqueuePublishedNote(m.notes[0]), 0);

  await m.mailer.flush();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0].raw, /Confirm your Notes subscription/);
  assert.match(m.sent[0].raw, /\/api\/notes-subscriptions\/confirm\?token=/);
  const confirmationToken = m.read().subscribers[0].confirmToken;
  assert.ok(m.mailer.confirm(confirmationToken));
  assert.equal(m.mailer.confirm(confirmationToken), false);
  assert.equal(m.mailer.status().active, 1);
  assert.equal(m.mailer.enqueuePublishedNote(m.notes[0]), 1);
  await m.mailer.flush();

  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1].raw, /New Notes: The Stacking Problem/);
  assert.match(m.sent[1].raw, /\/notes\/stacking/);
  assert.match(m.sent[1].raw, /List-Unsubscribe/);
  assert.equal(m.sent[1].program, '/usr/bin/msmtp');
  assert.deepEqual(m.sent[1].args, ['--file=/var/lib/remy-notes/msmtp.conf', '-t', '-i']);
  assert.equal(m.read().deliveries[0].status, 'sent');
  assert.equal(m.mailer.enqueuePublishedNote(m.notes[0]), 1);
  await m.mailer.flush();
  assert.equal(m.sent.length, 2, 'a second publish cannot send the same note twice');

  const unsub = m.read().subscribers[0].unsubscribeToken;
  assert.ok(m.mailer.unsubscribe(unsub));
  assert.equal(m.mailer.status().active, 0);
  assert.equal(m.mailer.enqueuePublishedNote({ id: 'note-2', title: 'Next', slug: 'next' }), 0);
  assert.equal(m.mailer.confirm(confirmationToken), false);
  assert.equal(m.mailer.unsubscribe('0'.repeat(64)), false);
});


test('owner is notified only after confirmation, with retry and no duplicate notifications', async t => {
  const m = setup({ notifyEmail: 'remy@remyellis.au' }); t.after(m.cleanup);
  m.mailer.subscribe('person@example.com', 'ip-owner');
  await m.mailer.flush();
  assert.equal(m.sent.length, 1);
  assert.doesNotMatch(m.sent[0].raw, /New confirmed Notes subscriber/);

  const token = m.read().subscribers[0].confirmToken;
  assert.ok(m.mailer.confirm(token));
  assert.equal(m.read().ownerNotices.length, 1);
  assert.equal(m.mailer.confirm(token), false);

  m.breakSmtp(true);
  await m.mailer.flush();
  assert.equal(m.read().ownerNotices[0].status, 'queued');
  assert.ok(m.read().ownerNotices[0].retryAt > m.time());

  m.breakSmtp(false);
  await m.mailer.flush();
  assert.equal(m.sent.length, 1, 'must respect retry delay');
  m.tick(61000);
  await m.mailer.flush();
  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1].raw, /To: remy@remyellis.au/);
  assert.match(m.sent[1].raw, /New confirmed Notes subscriber/);
  assert.match(m.sent[1].raw, /Email: person@example.com/);
  assert.equal(m.read().ownerNotices[0].status, 'sent');
  await m.mailer.flush();
  assert.equal(m.sent.length, 2, 'successful notification must not repeat');

  // A genuine new opt-in after unsubscribing should generate another notice.
  assert.ok(m.mailer.unsubscribe(m.read().subscribers[0].unsubscribeToken));
  m.tick(16 * 60 * 1000);
  m.mailer.subscribe('person@example.com', 'ip-owner');
  await m.mailer.flush();
  assert.ok(m.mailer.confirm(m.read().subscribers[0].confirmToken));
  await m.mailer.flush();
  assert.equal(m.read().ownerNotices.length, 2);
  assert.equal(m.sent.filter(m => /Subject: New confirmed Notes subscriber/.test(m.raw)).length, 2);
});

test('subscription endpoint gives generic response without listing email addresses', async t => {
  const m = setup(); t.after(m.cleanup);
  const reply = {};
  function respond(res, code, value) {
    Object.assign(reply, { code, value });
  }
  const url = new URL('https://remyellis.au/api/notes-subscriptions');
  const req = {
    method: 'POST', headers: { origin: 'https://remyellis.au' },
    input: { email: 'hello@example.com', website: '' },
  };
  const hit = await m.mailer.route(req, {}, url.pathname, url, respond);
  assert.equal(hit, true);
  assert.equal(reply.code, 200);
  assert.doesNotMatch(JSON.stringify(reply), /hello@example.com/);
  assert.match(JSON.stringify(reply), /confirmation email/);
  req.input.email = 'hello@example.com';
  await m.mailer.route(req, {}, url.pathname, url, respond);
  assert.equal(m.read().subscribers.length, 1);
  req.input.email = 'malformed email';
  await m.mailer.route(req, {}, url.pathname, url, respond);
  assert.equal(reply.code, 200);

  const token = m.read().subscribers[0].confirmToken;
  const getUrl = new URL('https://remyellis.au/api/notes-subscriptions/confirm?token=' + token);
  let page;
  const response = {
    writeHead(code, headers) { page = { code, headers, html: '' }; },
    end(html) { page.html = html; },
  };
  await m.mailer.route({ method: 'GET', headers: {} }, response, getUrl.pathname, getUrl, respond);
  assert.equal(page.code, 200);
  assert.match(page.html, /method="POST"/);
  assert.equal(m.read().subscribers[0].status, 'pending', 'GET cannot auto-confirm');
  assert.match(page.headers['Referrer-Policy'], /no-referrer/);
  await m.mailer.route({ method: 'POST', headers: {} }, response, getUrl.pathname, getUrl, respond);
  assert.equal(m.read().subscribers[0].status, 'active');

  const unsub = m.read().subscribers[0].unsubscribeToken;
  const unsubUrl = new URL('https://remyellis.au/api/notes-subscriptions/unsubscribe?token=' + unsub);
  await m.mailer.route({ method: 'GET', headers: {} }, response, unsubUrl.pathname, unsubUrl, respond);
  assert.equal(m.mailer.status().active, 1, 'GET cannot auto-unsubscribe');
  await m.mailer.route({ method: 'POST', headers: {} }, response, unsubUrl.pathname, unsubUrl, respond);
  assert.equal(m.mailer.status().active, 0);
});

test('failed SMTP delivery remains queued, retries, and expiry prevents old confirmations', async t => {
  const m = setup(); t.after(m.cleanup);
  m.mailer.subscribe('test@example.com', 'ip-three');
  m.breakSmtp(true);
  await m.mailer.flush();
  let state = m.read().subscribers[0];
  assert.equal(state.confirmMail.status, 'queued');
  assert.ok(state.confirmMail.retryAt > m.time());
  m.breakSmtp(false);
  await m.mailer.flush();
  assert.equal(m.sent.length, 0, 'SMTP retry respects delay');
  m.tick(61000);
  await m.mailer.flush();
  assert.equal(m.sent.length, 1);
  m.tick(49 * 60 * 60 * 1000);
  assert.equal(m.mailer.confirm(state.confirmToken), false);
});

test('mailer is inactive without a configured outgoing transport', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-subscribe-off-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mailer = createNoteSubscriptions({
    dataPath: path.join(dir, 'subscribers.json'),
    siteUrl: 'https://remyellis.au',
    readNotes: () => ({ notes: [] }),
    readJsonBody: async () => ({}),
    sameOrigin: () => true,
    clientIp: () => 'test',
    environment: {},
    startTimer: false,
  });
  assert.equal(mailer.status().configured, false);
  assert.throws(() => mailer.subscribe('person@example.com', 'test'), /not configured/);
});
