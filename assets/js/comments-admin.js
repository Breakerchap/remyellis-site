(() => {
  'use strict';
  const toggle = document.querySelector('#admin-comments-toggle');
  const badge = document.querySelector('#admin-pending-badge');
  const panel = document.querySelector('#admin-comments-panel');
  if (!toggle || !panel) return;
  const list = panel.querySelector('#admin-comments-list');
  const message = panel.querySelector('#admin-comments-message');
  const filterButtons = [...panel.querySelectorAll('[data-filter]')];
  let loggedIn = false, items = [], activeFilter = 'all', busy = false;

  const $ = selector => panel.querySelector(selector);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function button(text, callback, style = '') {
    const n = el('button', 'comment-ui-button ' + style, text);
    n.type = 'button'; n.addEventListener('click', callback); return n;
  }
  function notice(text, error = false) {
    message.hidden = !text;
    message.textContent = text;
    message.classList.toggle('is-error', error);
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return {};
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Request failed (' + res.status + ').');
    return result;
  }

  function setFilter(value) {
    activeFilter = value;
    for (const b of filterButtons) {
      const chosen = b.dataset.filter === value;
      b.classList.toggle('is-current', chosen);
      b.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    }
    render();
  }

  function updateCounts() {
    const totals = {
      all: items.length,
      pending: items.filter(c => c.status === 'pending').length,
      approved: items.filter(c => c.status === 'approved').length,
      rejected: items.filter(c => c.status === 'rejected').length,
    };
    badge.hidden = !totals.pending;
    badge.textContent = totals.pending > 99 ? '99+' : String(totals.pending);
    toggle.setAttribute('aria-label', 'Comments' + (totals.pending ? ', ' + totals.pending + ' awaiting approval' : ''));
    for (const name of Object.keys(totals)) {
      const number = $('#comments-' + name + '-count');
      if (number) number.textContent = totals[name];
    }
  }

  async function reload(silent = false) {
    if (!loggedIn || busy) return;
    busy = true;
    try {
      const data = await api('/api/admin/comments');
      items = data.comments || [];
      updateCounts();
      render();
      if (!silent) notice('');
    } catch (error) { notice(error.message, true); }
    finally { busy = false; }
  }

  async function perform(item, name) {
    if (name === 'delete' && !window.confirm('Permanently delete this comment and any replies? This cannot be undone.')) return;
    try {
      await api('/api/admin/comments/' + encodeURIComponent(item.id) +
        (name === 'delete' ? '' : '/' + name), name === 'delete' ? 'DELETE' : 'POST');
      await reload();
      notice(name === 'delete' ? 'Comment deleted permanently.' :
        name === 'reject' ? 'Comment hidden. It can be restored from the Hidden tab.' :
        'Comment published.');
    } catch (error) { notice(error.message, true); }
  }

  function compose(card, item, type) {
    if (card.querySelector('.comments-admin-compose')) {
      card.querySelector('.comments-admin-compose').remove();
    }
    const form = el('form', 'comments-admin-compose');
    const heading = el('div', 'comments-admin-compose-heading',
      type === 'reply' ? 'Reply as Remy Ellis' : 'Edit comment');
    const textArea = el('textarea', 'comments-admin-textarea');
    textArea.rows = 5;
    textArea.maxLength = 4000;
    textArea.setAttribute('aria-label', type === 'reply' ? 'Your reply in WMD' : 'Edit comment WMD');
    textArea.spellcheck = true;
    textArea.value = type === 'edit' ? item.body : '';
    const tabs = el('div', 'comments-admin-compose-tabs');
    const write = button('Write', () => setMode('write'), 'is-current');
    const previewButton = button('Preview', () => showPreview());
    const preview = el('div', 'comment-content note-body comments-admin-preview');
    preview.hidden = true;
    tabs.append(write, previewButton);
    const actions = el('div', 'comments-admin-actions');
    const submit = button(type === 'reply' ? 'Publish reply' : 'Save changes', () => submitForm(), 'is-primary');
    const cancel = button('Cancel', () => {
      editor.destroy();
      form.remove();
    }, 'is-quiet');
    actions.append(submit, cancel);
    form.append(heading, tabs, textArea, preview, actions);
    card.append(form);

    const editor = window.CommentWmdEditor?.create(textArea) || {
      getValue: () => textArea.value, focus: () => textArea.focus(),
      show: value => { textArea.hidden = !value; }, destroy: () => {},
    };
    let mode = 'write';
    function setMode(next) {
      mode = next;
      editor.show(next === 'write');
      preview.hidden = next !== 'preview';
      write.classList.toggle('is-current', next === 'write');
      previewButton.classList.toggle('is-current', next === 'preview');
    }
    async function showPreview() {
      setMode('preview');
      preview.textContent = 'Rendering…';
      try {
        const result = await api('/api/comments/preview', 'POST', { body: editor.getValue() });
        if (mode === 'preview') {
          preview.innerHTML = result.html; // Restricted server-side renderer.
          if (window.renderMathInElement) window.renderMathInElement(preview, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '\\[', right: '\\]', display: true },
              { left: '$', right: '$', display: false },
              { left: '\\(', right: '\\)', display: false },
            ], throwOnError: false,
          });
        }
      } catch (error) { preview.textContent = error.message; }
    }
    async function submitForm() {
      const body = editor.getValue();
      if (body.trim().length < 3) return notice('Enter at least three characters.', true);
      submit.disabled = true;
      try {
        await api('/api/admin/comments/' + encodeURIComponent(item.id) + '/' + type, 'POST', { body });
        editor.destroy();
        await reload();
        notice(type === 'reply' ? 'Author reply published.' : 'Comment updated.');
      } catch (error) { submit.disabled = false; notice(error.message, true); }
    }
    form.addEventListener('submit', event => { event.preventDefault(); submitForm(); });
    requestAnimationFrame(() => editor.focus());
  }

  function render() {
    if (!panel || panel.hidden) return;
    list.replaceChildren();
    const subset = items.filter(item => activeFilter === 'all' || item.status === activeFilter)
      .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
        String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!subset.length) {
      list.append(el('p', 'comments-admin-empty',
        activeFilter === 'pending' ? 'Nothing awaiting approval.' : 'No comments in this view.'));
      return;
    }
    for (const item of subset) {
      const card = el('article', 'comments-admin-item');
      const top = el('div', 'comments-admin-item-head');
      const name = el('strong', '', item.author ? 'Remy Ellis · Author' : item.name);
      const state = el('span', 'comments-admin-state is-' + item.status,
        { pending: 'Pending', approved: 'Published', rejected: 'Hidden' }[item.status] || item.status);
      const date = new Date(item.createdAt);
      const time = el('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-AU'));
      time.dateTime = item.createdAt;
      top.append(name, state, time);

      const where = item.noteUrl ? document.createElement('a') : el('span');
      where.className = 'comments-admin-note-link';
      where.textContent = item.noteTitle + (item.parentId ? ' · Reply' : '');
      if (item.noteUrl) {
        where.href = item.noteUrl;
        where.target = '_blank';
        where.rel = 'noopener';
      }

      const content = el('div', 'comment-content note-body');
      // Server-generated HTML from strict, non-HTML WMD subset.
      content.innerHTML = item.html;
      const actions = el('div', 'comments-admin-actions');
      if (item.status !== 'approved') actions.append(button('Approve', () => perform(item, 'approve'), 'is-primary'));
      if (item.status === 'approved') {
        actions.append(button('Reply as Remy', () => compose(card, item, 'reply')));
        actions.append(button('Edit', () => compose(card, item, 'edit')));
        actions.append(button('Hide', () => perform(item, 'reject'), 'is-quiet'));
      }
      if (item.status === 'pending') {
        actions.append(button('Hide', () => perform(item, 'reject'), 'is-quiet'));
      }
      if (item.status === 'rejected') {
        actions.append(button('Edit', () => compose(card, item, 'edit')));
      }
      actions.append(button('Delete', () => perform(item, 'delete'), 'is-danger'));
      card.append(top, where, content, actions);
      list.append(card);
    }
  }

  function open() {
    panel.hidden = false;
    document.body.classList.add('comments-admin-open');
    setFilter('all');
    reload();
    $('#admin-comments-close').focus();
  }
  function close() {
    panel.hidden = true;
    document.body.classList.remove('comments-admin-open');
    toggle.focus();
  }
  toggle.addEventListener('click', open);
  $('#admin-comments-close').addEventListener('click', close);
  $('#admin-comments-refresh').addEventListener('click', () => reload());
  filterButtons.forEach(b => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  panel.addEventListener('click', event => { if (event.target === panel) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });
  document.addEventListener('notes-admin:authenticated', () => {
    loggedIn = true;
    toggle.hidden = false;
    reload();
    if (location.hash === '#comments') open();
  });
  document.addEventListener('notes-admin:signed-out', () => {
    loggedIn = false; toggle.hidden = true; badge.hidden = true; panel.hidden = true;
    document.body.classList.remove('comments-admin-open');
    items = [];
  });
  setInterval(() => {
    if (loggedIn && !document.hidden && panel.hidden) reload(true);
  }, 60000);
})();
