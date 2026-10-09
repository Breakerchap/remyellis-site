'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createComments, renderComment, checkComment } = require('./comments');

test('restricted WMD produces only safe HTML and basic formatting', () => {
  const input = '# Title\n\n*bold* _italic_ <<prose>>\n\n<script>alert(1)</script>\n\n[good](https://example.com) [bad](javascript:alert)';
  const html = renderComment(input);
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|href="javascript:/i);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /rel="nofollow ugc noopener noreferrer"/);
  assert.throws(() => checkComment('@config\nBad\n@endconfig'), /not supported/);
  assert.throws(() => renderComment(' '), /3/);
});

test('mod queue, public visibility, approval, verified replies, rejection and deletion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remy-comments-'));
  const note = { id: 'n1', slug: 'sample-note', title: 'Sample Note', status: 'published' };
  const oldEnv = {
    COMMENTS_DATA_PATH: process.env.COMMENTS_DATA_PATH,
    COMMENTS_TURNSTILE_SITE_KEY: process.env.COMMENTS_TURNSTILE_SITE_KEY,
    COMMENTS_TURNSTILE_SECRET: process.env.COMMENTS_TURNSTILE_SECRET,
    NOTES_SERVE_STATIC: process.env.NOTES_SERVE_STATIC,
    NOTES_HOST: process.env.NOTES_HOST,
  };
  const oldFetch = global.fetch;
  process.env.COMMENTS_DATA_PATH = path.join(dir, 'comments.json');
  process.env.COMMENTS_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  process.env.COMMENTS_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  process.env.NOTES_SERVE_STATIC = '1';
  process.env.NOTES_HOST = '127.0.0.1';
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, hostname: 'test.cloudflare.com' }) });
  try {
    let response;
    let authenticated = false;
    const comments = createComments({
      notesDataPath: path.join(dir, 'notes.json'),
      siteUrl: 'https://remyellis.au',
      readNotes: () => ({ notes: [note] }),
      readJsonBody: async req => req.input,
      clientIp: () => 'test-ip',
      requireAuth: () => true,
      getSession: () => authenticated ? { token: "admin-test" } : null,
      sameOrigin: () => true,
      sendJson: (_res, code, data) => { response = { code, data }; },
      sendNoContent: () => { response = { code: 204 }; },
    });
    async function call(url, method, input) {
      response = null;
      await comments.route({
        method,
        headers: { origin: 'https://remyellis.au' },
        input,
      }, {}, url);
      return response;
    }
    assert.equal((await call('/api/comments/config', 'GET')).data.owner, false);
    const submitted = await call('/api/comments/sample-note', 'POST', {
      name: 'Alex', body: '*Good* point!', turnstileToken: 'dummy', website: '',
    });
    assert.equal(submitted.code, 201);
    let publicList = await call('/api/comments/sample-note', 'GET');
    assert.equal(publicList.data.comments.length, 0);
    let moderation = await call('/api/admin/comments', 'GET');
    assert.equal(moderation.data.pendingCount, 1);
    const commentId = moderation.data.comments[0].id;
    await call('/api/admin/comments/' + commentId + '/approve', 'POST');
    publicList = await call('/api/comments/sample-note', 'GET');
    assert.equal(publicList.data.comments.length, 1);
    assert.equal(publicList.data.comments[0].author, false);
    assert.match(publicList.data.comments[0].html, /<strong>Good<\/strong>/);

    const reply = await call('/api/admin/comments/' + commentId + '/reply', 'POST', { body: 'Thank you!' });
    assert.equal(reply.code, 201);
    assert.equal(reply.data.comment.author, true);
    assert.equal(reply.data.comment.name, 'Remy Ellis');
    publicList = await call('/api/comments/sample-note', 'GET');
    assert.equal(publicList.data.comments.length, 2);

    await call('/api/admin/comments/' + commentId + '/edit', 'POST', { body: '*Edited* text' });
    publicList = await call('/api/comments/sample-note', 'GET');
    assert.match(publicList.data.comments[0].html, /<strong>Edited<\/strong>/);

    await call('/api/admin/comments/' + commentId + '/reject', 'POST');
    publicList = await call('/api/comments/sample-note', 'GET');
    assert.equal(publicList.data.comments.length, 0); // No orphaned author replies.
    await call('/api/admin/comments/' + commentId + '/approve', 'POST');
    assert.equal((await call('/api/comments/sample-note', 'GET')).data.comments.length, 2);

    authenticated = true;
    assert.equal((await call('/api/comments/config', 'GET')).data.owner, true);
    const own = await call('/api/comments/sample-note', 'POST', {
      body: 'Site author announcement', parentId: null,
    });
    assert.equal(own.code, 201);
    assert.equal(own.data.pending, false);
    publicList = await call('/api/comments/sample-note', 'GET');
    assert.equal(publicList.data.comments.length, 3);
    assert.equal(publicList.data.comments[2].author, true);
    assert.equal(publicList.data.comments[2].name, 'Remy Ellis');

    await call('/api/admin/comments/' + commentId, 'DELETE');
    publicList = await call('/api/comments/sample-note', 'GET');
    assert.equal(publicList.data.comments.length, 1); // Deleting the parent also deletes the reply.
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
