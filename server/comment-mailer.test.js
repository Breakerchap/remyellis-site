'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommentMailer, formatNotice } = require('./comment-mailer');

const note = { id: 'note-1', title: 'The Stacking Problem', slug: 'stacking-problem' };
const comment = {
  id: 'comment-1',
  noteId: 'note-1',
  parentId: null,
  name: 'Alex',
  body: '*This* is interesting.\n<script>not executable</script>',
  author: false,
  status: 'pending',
  createdAt: '2026-10-09T06:00:00.000Z',
  emailNotice: { status: 'queued', attempts: 0 },
};
const settings = {
  COMMENTS_NOTIFY_EMAIL: 'remy@remyellis.au',
  COMMENTS_NOTIFY_FROM: 'remy@remyellis.au',
  COMMENTS_SENDMAIL_PATH: '/usr/bin/msmtp',
  COMMENTS_MSMTP_CONFIG: '/var/lib/remy-notes/msmtp.conf',
};

test('notification is plain text with correct links and private recipient', () => {
  const result = formatNotice({
    to: settings.COMMENTS_NOTIFY_EMAIL,
    from: settings.COMMENTS_NOTIFY_FROM,
    note, comment,
    siteUrl: 'https://remyellis.au',
  });
  assert.match(result, /To: remy@remyellis\.au/);
  assert.match(result, /New Notes comment awaiting approval/);
  assert.match(result, /Note: The Stacking Problem/);
  assert.match(result, /Name: Alex/);
  assert.match(result, /\*This\* is interesting/);
  assert.match(result, /https:\/\/remyellis\.au\/notes-admin\.html#comments/);
  assert.match(result, /https:\/\/remyellis\.au\/notes\/stacking-problem#comments/);
  assert.match(result, /Content-Type: text\/plain; charset=UTF-8/);
  assert.throws(() => formatNotice({
    to: 'bad@example.com\r\nBcc: someone@else.com',
    from: settings.COMMENTS_NOTIFY_FROM,
    siteUrl: 'https://remyellis.au', note, comment,
  }), /Invalid notification/);
});

test('mailer sends each queued visitor comment and skips authors and already sent items', async () => {
  let store = {
    version: 1,
    comments: [structuredClone(comment), {
      ...structuredClone(comment),
      id: 'author-reply',
      author: true,
    }, {
      ...structuredClone(comment),
      id: 'already-sent',
      emailNotice: { status: 'sent' },
    }],
  };
  const messages = [];
  const mailer = createCommentMailer({
    readStore: () => structuredClone(store),
    writeStore: next => { store = structuredClone(next); },
    readNotes: () => ({ notes: [note] }),
    environment: settings,
    siteUrl: 'https://remyellis.au',
    send: async (program, args, message) => { messages.push({ program, args, message }); },
    startTimer: false,
  });

  assert.deepEqual(mailer.status(), {
    configured: true, destination: 'remy@remyellis.au', queued: 2,
  });
  await mailer.flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].program, '/usr/bin/msmtp');
  assert.deepEqual(messages[0].args, ['--file=/var/lib/remy-notes/msmtp.conf', '-t', '-i']);
  assert.match(messages[0].message, /Name: Alex/);
  assert.equal(store.comments[0].emailNotice.status, 'sent');
  assert.ok(store.comments[0].emailNotice.sentAt);
  await mailer.flush();
  assert.equal(messages.length, 1);
  await mailer.sendTest();
  assert.equal(messages.length, 2);
  assert.match(messages[1].message, /Notes comments: test email/);
  await assert.rejects(mailer.sendTest(), /Wait one minute/);
});

test('failed emails remain queued, retry later and do not block comments', async () => {
  let store = { version: 1, comments: [structuredClone(comment)] };
  let now = 100000;
  let fail = true;
  let attempts = 0;
  const mailer = createCommentMailer({
    readStore: () => structuredClone(store),
    writeStore: next => { store = structuredClone(next); },
    readNotes: () => ({ notes: [note] }),
    environment: settings,
    siteUrl: 'https://remyellis.au',
    now: () => now,
    logger: { error: () => {} },
    send: async () => {
      attempts += 1;
      if (fail) throw new Error('temporary outage');
    },
    startTimer: false,
  });
  await mailer.flush();
  assert.equal(attempts, 1);
  assert.equal(store.comments[0].emailNotice.status, 'queued');
  const retryAt = store.comments[0].emailNotice.retryAt;
  assert.ok(retryAt > now);
  await mailer.flush();
  assert.equal(attempts, 1);
  now = retryAt + 1;
  fail = false;
  await mailer.flush();
  assert.equal(attempts, 2);
  assert.equal(store.comments[0].emailNotice.status, 'sent');
});

test('mailer stays disabled if recipient or mail transport is not configured', async () => {
  const mailer = createCommentMailer({
    readStore: () => ({ comments: [structuredClone(comment)] }),
    writeStore: () => { throw new Error('Unexpected write'); },
    readNotes: () => ({ notes: [note] }),
    environment: {},
    siteUrl: 'https://remyellis.au',
    startTimer: false,
  });
  assert.equal(mailer.status().configured, false);
  await mailer.flush();
  await assert.rejects(mailer.sendTest(), /Set COMMENTS_NOTIFY_EMAIL/);
});
