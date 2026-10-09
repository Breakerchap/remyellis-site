(() => {
  'use strict';

  // Session storage persists across navigation in this tab, but normally
  // disappears when the tab closes. Never put the credential in a URL.
  const KEY = 'remy_notes_tab_proof';

  window.NotesTabAuth = Object.freeze({
    get() {
      try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; }
    },
    headers() {
      const token = this.get();
      return token ? { 'X-Notes-Tab-Token': token } : {};
    },
    save(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        throw new Error('Invalid login confirmation.');
      }
      try {
        sessionStorage.setItem(KEY, token);
      } catch {
        throw new Error('Tab storage is unavailable. Enable session storage to sign in.');
      }
    },
    clear() {
      try { sessionStorage.removeItem(KEY); } catch { /* Storage disabled. */ }
    },
  });
})();
