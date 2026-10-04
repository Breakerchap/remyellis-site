(() => {
  'use strict';

  const loginView = document.querySelector('#admin-login');
  const appView = document.querySelector('#admin-app');
  const loginForm = document.querySelector('#login-form');
  const loginError = document.querySelector('#login-error');
  const passwordInput = document.querySelector('#admin-password');
  const logoutButton = document.querySelector('#logout-button');
  const newButton = document.querySelector('#new-note');
  const noteList = document.querySelector('#admin-note-list');
  const editorEmpty = document.querySelector('#editor-empty');
  const editor = document.querySelector('#note-editor');
  const form = document.querySelector('#note-form');
  const titleInput = document.querySelector('#note-title');
  const dateInput = document.querySelector('#note-date');
  const slugInput = document.querySelector('#note-slug');
  const bodyInput = document.querySelector('#note-body');
  const syntaxHighlight = document.querySelector('#note-highlight');
  const cssInput = document.querySelector('#note-css');
  const saveButton = document.querySelector('#save-note');
  const publishButton = document.querySelector('#publish-note');
  const unpublishButton = document.querySelector('#unpublish-note');
  const deleteButton = document.querySelector('#delete-note');
  const statusChip = document.querySelector('#note-status');
  const saveState = document.querySelector('#save-state');
  const preview = document.querySelector('#note-preview');
  const previewButton = document.querySelector('#preview-button');
  const writeButton = document.querySelector('#write-button');
  const editorPane = document.querySelector('#editor-pane');
  const previewPane = document.querySelector('#preview-pane');
  const globalError = document.querySelector('#admin-error');

  let notes = [];
  let currentId = null;
  let currentStatus = 'draft';
  let savedSnapshot = null;
  let slugWasEdited = false;
  let busy = false;

  function slugify(value) {
    return String(value || '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'untitled-note';
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function syntaxSpan(className, value) {
    return `<span class="${className}">${escapeHtml(value)}</span>`;
  }

  const inlineSyntaxPatterns = [
    { className: 'wmd-syntax-code', regex: /`[^`\n]*`/g },
    { className: 'wmd-syntax-math', regex: /\$\$[^$\n]*\$\$/g },
    { className: 'wmd-syntax-math', regex: /\\\([^\n]*?\\\)/g },
    { className: 'wmd-syntax-math', regex: /\\\[[^\n]*?\\\]/g },
    { className: 'wmd-syntax-math', regex: /\$[^$\n]+\$/g },
    { className: 'wmd-syntax-html', regex: /<\/?[A-Za-z][^>\n]*>/g },
    { className: 'wmd-syntax-link', regex: /\[\[[^\]\n]+\]\]/g },
    { className: 'wmd-syntax-link', regex: /\[[^\]\n]+\]\([^\n)]*\)/g },
    { className: 'wmd-syntax-bold', regex: /\*[^*\n]+\*/g },
    { className: 'wmd-syntax-italic', regex: /_[^_\n]+_/g },
  ];

  function highlightInlineWmd(text) {
    let output = '';
    let position = 0;

    while (position < text.length) {
      let chosen = null;

      for (const pattern of inlineSyntaxPatterns) {
        pattern.regex.lastIndex = position;
        const match = pattern.regex.exec(text);
        if (!match) continue;
        if (!chosen || match.index < chosen.index) {
          chosen = { index: match.index, value: match[0], className: pattern.className };
        }
      }

      if (!chosen) {
        output += escapeHtml(text.slice(position));
        break;
      }

      output += escapeHtml(text.slice(position, chosen.index));
      output += syntaxSpan(chosen.className, chosen.value);
      position = chosen.index + chosen.value.length;
    }

    return output;
  }

  function highlightWmd(source) {
    const lines = String(source || '').split('\n');
    let inFence = false;

    return lines.map(line => {
      const fence = line.match(/^(\s*)(```)(.*)$/);
      if (fence) {
        inFence = !inFence;
        return escapeHtml(fence[1]) + syntaxSpan('wmd-syntax-code-fence', fence[2] + fence[3]);
      }

      if (inFence) return syntaxSpan('wmd-syntax-code-block', line);

      const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
      if (heading) {
        return escapeHtml(heading[1])
          + syntaxSpan('wmd-syntax-heading-marker', heading[2])
          + escapeHtml(heading[3])
          + syntaxSpan('wmd-syntax-heading', heading[4]);
      }

      const directive = line.match(/^(\s*)((?:@[A-Za-z][\w-]*)|(?:!(?:note|tip|info|warning|danger|rule|example|end)\b))(.*)$/i);
      if (directive) {
        return escapeHtml(directive[1])
          + syntaxSpan('wmd-syntax-directive', directive[2])
          + `<span class="wmd-syntax-directive-value">${highlightInlineWmd(directive[3])}</span>`;
      }

      const quote = line.match(/^(\s*>\s?)(.*)$/);
      if (quote) return `<span class="wmd-syntax-quote">${escapeHtml(quote[1])}${highlightInlineWmd(quote[2])}</span>`;

      const list = line.match(/^(\s*)([-+*]|\d+\.)(\s+)(.*)$/);
      if (list) {
        return escapeHtml(list[1])
          + syntaxSpan('wmd-syntax-list', list[2])
          + escapeHtml(list[3])
          + highlightInlineWmd(list[4]);
      }

      return highlightInlineWmd(line);
    }).join('\n') + '\n';
  }

  function updateSyntaxHighlight() {
    if (!syntaxHighlight) return;
    syntaxHighlight.innerHTML = highlightWmd(bodyInput.value);
    syntaxHighlight.scrollTop = bodyInput.scrollTop;
    syntaxHighlight.scrollLeft = bodyInput.scrollLeft;
  }

  function handleTabIndent(event) {
    if (event.key !== 'Tab') return;
    event.preventDefault();

    const indent = '  ';
    const value = bodyInput.value;
    const start = bodyInput.selectionStart;
    const end = bodyInput.selectionEnd;
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;

    if (start === end) {
      if (event.shiftKey) {
        const prefix = value.slice(lineStart, start);
        const remove = prefix.endsWith(indent) ? indent.length : (prefix.endsWith(' ') ? 1 : 0);
        if (remove) {
          bodyInput.setRangeText('', start - remove, start, 'end');
        }
      } else {
        bodyInput.setRangeText(indent, start, end, 'end');
      }
      bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    let effectiveEnd = end;
    if (effectiveEnd > start && value[effectiveEnd - 1] === '\n') effectiveEnd -= 1;
    let blockEnd = value.indexOf('\n', effectiveEnd);
    if (blockEnd === -1) blockEnd = value.length;

    const block = value.slice(lineStart, blockEnd);
    const lines = block.split('\n');
    const transformed = lines.map(line => {
      if (!event.shiftKey) return indent + line;
      if (line.startsWith(indent)) return line.slice(indent.length);
      if (line.startsWith(' ')) return line.slice(1);
      if (line.startsWith('\t')) return line.slice(1);
      return line;
    }).join('\n');

    bodyInput.setRangeText(transformed, lineStart, blockEnd, 'select');
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function sanitiseTrustedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script, object, embed, base, meta').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith('on')) node.removeAttribute(attribute.name);
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:')) {
          node.removeAttribute(attribute.name);
        }
      }
    });
    return template.innerHTML;
  }

  function addStyle(target, css, name) {
    if (!css || !css.trim()) return;
    const style = document.createElement('style');
    style.dataset.noteStyle = name;
    style.textContent = css;
    target.prepend(style);
  }

  function renderMath(target) {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(target, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    });
  }

  function renderCompiled(target, rendered, customCss) {
    target.innerHTML = sanitiseTrustedHtml(rendered.html || '');
    addStyle(target, rendered.compilerCss || '', 'wikimd');
    addStyle(target, customCss || '', 'custom');
    renderMath(target);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });

    if (response.status === 401 && path !== '/api/admin/login') {
      showLogin();
      throw new Error('Your session has expired. Sign in again.');
    }

    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      try {
        const data = await response.json();
        if (data.error) message = data.error;
      } catch {}
      throw new Error(message);
    }

    if (response.status === 204) return null;
    return await response.json();
  }

  function showError(message) {
    globalError.textContent = message;
    globalError.hidden = !message;
  }

  function showLogin() {
    loginView.hidden = false;
    appView.hidden = true;
    logoutButton.hidden = true;
    setTimeout(() => passwordInput.focus(), 0);
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    logoutButton.hidden = false;
  }

  function localToday() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
    return local.toISOString().slice(0, 10);
  }

  function formData() {
    return {
      title: titleInput.value.trim(),
      date: dateInput.value,
      slug: slugInput.value.trim(),
      format: 'wikimd',
      body: bodyInput.value,
      customCss: cssInput.value,
    };
  }

  function snapshot() {
    return JSON.stringify(formData());
  }

  function isDirty() {
    return editor.hidden ? false : snapshot() !== savedSnapshot;
  }

  function updateSaveState() {
    if (editor.hidden) return;
    if (isDirty()) {
      saveState.textContent = 'Unsaved changes';
      saveState.classList.add('is-dirty');
    } else {
      saveState.textContent = currentId ? 'Saved' : 'Not saved';
      saveState.classList.remove('is-dirty');
    }
  }

  function updateStatus() {
    statusChip.textContent = currentStatus === 'published' ? 'Published' : 'Draft';
    statusChip.className = `note-status ${currentStatus === 'published' ? 'is-published' : 'is-draft'}`;
    publishButton.hidden = currentStatus === 'published';
    unpublishButton.hidden = currentStatus !== 'published';
    saveButton.textContent = currentStatus === 'published' ? 'Save changes' : 'Save draft';
    deleteButton.hidden = !currentId;
  }

  function confirmDiscardIfNeeded() {
    if (!isDirty()) return true;
    return window.confirm('You have unsaved changes. Discard them?');
  }

  function openBlankNote() {
    if (!confirmDiscardIfNeeded()) return;
    currentId = null;
    currentStatus = 'draft';
    slugWasEdited = false;
    titleInput.value = '';
    dateInput.value = localToday();
    slugInput.value = '';
    bodyInput.value = '';
    cssInput.value = '';
    updateSyntaxHighlight();
    savedSnapshot = null;
    editorEmpty.hidden = true;
    editor.hidden = false;
    updateStatus();
    updateSaveState();
    preview.innerHTML = '';
    showWritePane();
    titleInput.focus();
    highlightCurrent();
  }

  async function openNote(id) {
    if (id === currentId) return;
    if (!confirmDiscardIfNeeded()) return;
    showError('');
    try {
      const data = await api(`/api/admin/notes/${encodeURIComponent(id)}`);
      const note = data.note;
      currentId = note.id;
      currentStatus = note.status;
      slugWasEdited = true;
      titleInput.value = note.title;
      dateInput.value = note.date;
      slugInput.value = note.slug;
      bodyInput.value = note.body;
      cssInput.value = note.customCss || '';
      updateSyntaxHighlight();
      savedSnapshot = snapshot();
      editorEmpty.hidden = true;
      editor.hidden = false;
      updateStatus();
      updateSaveState();
      preview.innerHTML = '';
      showWritePane();
      highlightCurrent();
    } catch (error) {
      showError(error.message);
    }
  }

  function highlightCurrent() {
    noteList.querySelectorAll('[data-note-id]').forEach(button => {
      button.classList.toggle('is-current', button.dataset.noteId === currentId);
    });
  }

  function renderNoteList() {
    noteList.innerHTML = '';
    if (!notes.length) {
      noteList.innerHTML = '<p class="admin-list-empty">No saved notes yet.</p>';
      return;
    }

    const groups = [
      ['Drafts', notes.filter(note => note.status === 'draft')],
      ['Published', notes.filter(note => note.status === 'published')],
    ];

    for (const [label, items] of groups) {
      if (!items.length) continue;
      const heading = document.createElement('h3');
      heading.className = 'admin-list-heading';
      heading.textContent = label;
      noteList.append(heading);

      for (const note of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'admin-note-item';
        button.dataset.noteId = note.id;
        button.innerHTML = `
          <span>${escapeHtml(note.title)}</span>
          <small>${escapeHtml(note.date)} · ${note.status === 'published' ? 'Published' : 'Draft'}</small>
        `;
        button.addEventListener('click', () => openNote(note.id));
        noteList.append(button);
      }
    }

    highlightCurrent();
  }

  async function refreshList() {
    const data = await api('/api/admin/notes');
    notes = data.notes || [];
    renderNoteList();
  }

  async function renderPreview() {
    showError('');
    preview.innerHTML = '<p class="notes-message">Rendering WikiMD…</p>';

    try {
      const data = await api('/api/admin/render', {
        method: 'POST',
        body: JSON.stringify({ body: bodyInput.value }),
      });
      renderCompiled(preview, data.rendered || {}, cssInput.value);
    } catch (error) {
      preview.innerHTML = '';
      showError(error.message);
    }
  }

  async function saveCurrent() {
    if (busy) return null;
    showError('');
    const payload = formData();
    if (!payload.title) {
      titleInput.focus();
      showError('Give the note a title before saving it.');
      return null;
    }

    busy = true;
    saveButton.disabled = true;
    saveState.textContent = 'Saving…';
    try {
      const data = currentId
        ? await api(`/api/admin/notes/${encodeURIComponent(currentId)}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          })
        : await api('/api/admin/notes', {
            method: 'POST',
            body: JSON.stringify(payload),
          });

      currentId = data.note.id;
      currentStatus = data.note.status;
      savedSnapshot = snapshot();
      slugWasEdited = true;
      updateStatus();
      updateSaveState();
      await refreshList();
      return data.note;
    } catch (error) {
      showError(error.message);
      updateSaveState();
      return null;
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  }

  async function publishCurrent() {
    if (busy) return;
    let note = null;
    if (!currentId || isDirty()) note = await saveCurrent();
    if ((!currentId && !note) || isDirty()) return;

    busy = true;
    try {
      const data = await api(`/api/admin/notes/${encodeURIComponent(currentId)}/publish`, { method: 'POST' });
      currentStatus = data.note.status;
      savedSnapshot = snapshot();
      updateStatus();
      updateSaveState();
      await refreshList();
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
    }
  }

  async function unpublishCurrent() {
    if (!currentId || busy) return;
    if (!window.confirm('Unpublish this note and move it back to drafts?')) return;
    busy = true;
    try {
      const data = await api(`/api/admin/notes/${encodeURIComponent(currentId)}/unpublish`, { method: 'POST' });
      currentStatus = data.note.status;
      updateStatus();
      await refreshList();
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
    }
  }

  async function deleteCurrent() {
    if (!currentId || busy) return;
    if (!window.confirm(`Delete “${titleInput.value.trim()}”? This cannot be undone.`)) return;
    busy = true;
    try {
      await api(`/api/admin/notes/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
      currentId = null;
      editor.hidden = true;
      editorEmpty.hidden = false;
      await refreshList();
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
    }
  }

  function showWritePane() {
    editorPane.hidden = false;
    previewPane.hidden = true;
    writeButton.classList.add('is-active');
    previewButton.classList.remove('is-active');
  }

  async function showPreviewPane() {
    editorPane.hidden = true;
    previewPane.hidden = false;
    previewButton.classList.add('is-active');
    writeButton.classList.remove('is-active');
    await renderPreview();
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginError.hidden = true;
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: passwordInput.value }),
      });
      passwordInput.value = '';
      showApp();
      await refreshList();
    } catch (error) {
      loginError.textContent = error.message;
      loginError.hidden = false;
    }
  });

  logoutButton.addEventListener('click', async () => {
    if (!confirmDiscardIfNeeded()) return;
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } catch {}
    showLogin();
  });

  newButton.addEventListener('click', openBlankNote);
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveCurrent();
  });
  publishButton.addEventListener('click', publishCurrent);
  unpublishButton.addEventListener('click', unpublishCurrent);
  deleteButton.addEventListener('click', deleteCurrent);
  writeButton.addEventListener('click', showWritePane);
  previewButton.addEventListener('click', showPreviewPane);

  titleInput.addEventListener('input', () => {
    if (!slugWasEdited) slugInput.value = slugify(titleInput.value);
    updateSaveState();
  });
  slugInput.addEventListener('input', () => {
    slugWasEdited = true;
    updateSaveState();
  });
  [dateInput, bodyInput, cssInput].forEach(input => {
    input.addEventListener('input', updateSaveState);
    input.addEventListener('change', updateSaveState);
  });

  bodyInput.addEventListener('input', updateSyntaxHighlight);
  bodyInput.addEventListener('scroll', () => {
    if (!syntaxHighlight) return;
    syntaxHighlight.scrollTop = bodyInput.scrollTop;
    syntaxHighlight.scrollLeft = bodyInput.scrollLeft;
  });
  bodyInput.addEventListener('keydown', handleTabIndent);

  window.addEventListener('beforeunload', event => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !appView.hidden) {
      event.preventDefault();
      saveCurrent();
    }
  });

  async function initialise() {
    updateSyntaxHighlight();
    try {
      await api('/api/admin/session');
      showApp();
      await refreshList();
    } catch {
      showLogin();
    }
  }

  initialise();
})();
