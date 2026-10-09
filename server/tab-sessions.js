'use strict';

const crypto = require('node:crypto');

const PROOF_PATTERN = /^[a-f0-9]{64}$/;

function createTabSessions({ ttlMs = 2 * 60 * 60 * 1000, cookieName = 'remy_notes_session', secure = true } = {}) {
  const sessions = new Map();

  function tokenFromCookie(req) {
    const cookies = String(req.headers?.cookie || '').split(';');
    for (const part of cookies) {
      const equal = part.indexOf('=');
      if (equal < 0 || part.slice(0, equal).trim() !== cookieName) continue;
      try { return decodeURIComponent(part.slice(equal + 1).trim()); }
      catch { return ''; }
    }
    return '';
  }

  function create() {
    const token = crypto.randomBytes(32).toString('base64url');
    const tabProof = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
      expiresAt: Date.now() + ttlMs,
      tabProofHash: crypto.createHash('sha256').update(tabProof).digest(),
    });
    return { token, tabProof };
  }

  function get(req) {
    const token = tokenFromCookie(req);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }

    // The HttpOnly cookie alone cannot authorise requests; the tab-held proof
    // must match as well. Closing this tab normally destroys that proof.
    const proof = req.headers?.['x-notes-tab-token'];
    if (typeof proof !== 'string' || !PROOF_PATTERN.test(proof)) return null;
    const actual = crypto.createHash('sha256').update(proof).digest();
    if (!crypto.timingSafeEqual(actual, session.tabProofHash)) return null;

    session.expiresAt = Date.now() + ttlMs;
    return { token, expiresAt: session.expiresAt };
  }

  function destroy(req) {
    const token = tokenFromCookie(req);
    if (token) sessions.delete(token);
  }

  function cookie(token) {
    // Intentionally omit Max-Age/Expires: this is a browser-session cookie.
    // The additional tab proof enforces a shorter, tab-scoped experience.
    return cookieName + '=' + encodeURIComponent(token) +
      '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
  }

  function expiredCookie() {
    return cookieName + '=; Path=/; HttpOnly; SameSite=Strict' +
      (secure ? '; Secure' : '') + '; Max-Age=0';
  }

  function prune() {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  return { create, get, destroy, cookie, expiredCookie, prune };
}

module.exports = { createTabSessions };
