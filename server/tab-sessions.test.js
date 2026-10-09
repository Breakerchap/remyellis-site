'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTabSessions } = require('./tab-sessions');

function request(token, proof) {
  return {
    headers: {
      cookie: 'remy_notes_session=' + encodeURIComponent(token),
      ...(proof ? { 'x-notes-tab-token': proof } : {}),
    },
  };
}

test('tab proof and HttpOnly cookie are both required for author privileges', () => {
  const auth = createTabSessions({ secure: true });
  const { token, tabProof } = auth.create();
  assert.match(tabProof, /^[a-f0-9]{64}$/);
  assert.ok(auth.get(request(token, tabProof)));
  assert.equal(auth.get(request(token, '0'.repeat(64))), null);
  assert.equal(auth.get(request(token)), null);
  assert.equal(auth.get({ headers: { 'x-notes-tab-token': tabProof } }), null);
  assert.equal(auth.get(request('not-the-token', tabProof)), null);
  assert.ok(auth.get(request(token, tabProof)), 'invalid checks do not invalidate the correct tab');

  const cookie = auth.cookie(token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Max-Age|Expires/i, 'browser-session cookie is not persistent');
  auth.destroy(request(token));
  assert.equal(auth.get(request(token, tabProof)), null);
});

test('credentials are isolated between tabs, expire when idle, and use non-Secure cookies for local HTTP only', () => {
  const oldNow = Date.now;
  let now = 123000;
  Date.now = () => now;
  try {
    const auth = createTabSessions({ ttlMs: 5000, secure: false });
    const first = auth.create();
    const second = auth.create();
    assert.equal(auth.get(request(first.token, second.tabProof)), null);
    assert.ok(auth.get(request(first.token, first.tabProof)));
    const cookie = auth.cookie(first.token);
    assert.doesNotMatch(cookie, /Secure/);

    now += 4500;
    assert.ok(auth.get(request(first.token, first.tabProof)), 'activity renews idle expiry');
    now += 4501;
    assert.ok(auth.get(request(first.token, first.tabProof)));
    now += 5001;
    assert.equal(auth.get(request(first.token, first.tabProof)), null, 'expired session is invalid');
    auth.prune();
    assert.equal(auth.get(request(second.token, second.tabProof)), null);
  } finally {
    Date.now = oldNow;
  }
});
