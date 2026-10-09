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
  const cssInput = document.querySelector('#note-css');
  const saveButton = document.querySelector('#save-note');
  const publishButton = document.querySelector('#publish-note');
  const notifySubscribersInput = document.querySelector('#notify-subscribers');
  const notifySubscribersOption = document.querySelector('#notify-subscribers-option');
  const notifySubscribersLabel = document.querySelector('#notify-subscribers-label');
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
  let previouslyPublished = false;
  let savedSnapshot = null;
  let slugWasEdited = false;
  let busy = false;
  let bodyEditor = null;
  let reordering = false;

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

  function getBodyValue() {
    return bodyEditor ? bodyEditor.getValue() : bodyInput.value;
  }

  function setBodyValue(value) {
    const nextValue = String(value ?? '');
    bodyInput.value = nextValue;

    if (bodyEditor && bodyEditor.getValue() !== nextValue) {
      bodyEditor.setValue(nextValue);
      bodyEditor.clearHistory();
    }
  }

  function refreshBodyEditor() {
    if (!bodyEditor) return;
    requestAnimationFrame(() => bodyEditor.refresh());
  }

  function ensureBodyEditor() {
    if (bodyEditor || !window.CodeMirror) return bodyEditor;

    bodyEditor = window.CodeMirror.fromTextArea(bodyInput, {
      mode: 'wikimd',
      inputStyle: 'contenteditable',
      spellcheck: true,
      autocorrect: true,
      autocapitalize: true,
      lineNumbers: false,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      viewportMargin: 20,
      cursorBlinkRate: 530,
      extraKeys: {
        // CodeMirror's default Insert binding enables overtype, replacing
        // the characters after the caret. Keep this a normal writing editor.
        Insert(cm) {
          cm.toggleOverwrite(false);
        },
        Tab(cm) {
          if (cm.somethingSelected()) {
            cm.indentSelection('add');
          } else {
            cm.replaceSelection('  ', 'end');
          }
        },
        'Shift-Tab'(cm) {
          cm.indentSelection('subtract');
        },
        'Ctrl-S'() {
          saveCurrent();
        },
        'Cmd-S'() {
          saveCurrent();
        },
      },
    });

    bodyEditor.getWrapperElement().classList.add('note-body-editor');
    bodyEditor.toggleOverwrite(false);
    bodyEditor.on('focus', cm => cm.toggleOverwrite(false));

    // Keep browser-native spelling behaviour enabled on CodeMirror's actual
    // editable surface. The original textarea already has spellcheck enabled,
    // but CodeMirror otherwise edits through a hidden textarea where Chrome
    // cannot draw its normal spelling underlines.
    const editorInput = bodyEditor.getInputField();
    if (editorInput) {
      editorInput.setAttribute('spellcheck', 'true');
      editorInput.setAttribute('autocorrect', 'on');
      editorInput.setAttribute('autocapitalize', 'sentences');
    }

    bodyEditor.on('change', cm => {
      bodyInput.value = cm.getValue();
      updateSaveState();
    });

    return bodyEditor;
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
        const line = value.slice(lineStart);
        const match = line.match(/^(  | |\t)/);
        if (match) {
          const remove = match[0].length;
          bodyInput.setRangeText('', lineStart, lineStart + remove, 'end');
          const caret = Math.max(lineStart, start - remove);
          bodyInput.setSelectionRange(caret, caret);
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
    const transformed = block.split('\n').map(line => {
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
    const { headers: extraHeaders = {}, ...requestOptions } = options;
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(window.NotesTabAuth?.headers() || {}),
        ...extraHeaders,
      },
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
    window.NotesTabAuth?.clear();
    loginView.hidden = false;
    appView.hidden = true;
    logoutButton.hidden = true;
    document.dispatchEvent(new Event('notes-admin:signed-out'));
    setTimeout(() => passwordInput.focus(), 0);
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    logoutButton.hidden = false;
    document.dispatchEvent(new Event('notes-admin:authenticated'));
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
      body: getBodyValue(),
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
    notifySubscribersOption.hidden = currentStatus === 'published' || previouslyPublished;
    if (notifySubscribersOption.hidden) notifySubscribersInput.checked = false;
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
    previouslyPublished = false;
    notifySubscribersInput.checked = false;
    slugWasEdited = false;
    titleInput.value = '';
    dateInput.value = localToday();
    slugInput.value = '';
    setBodyValue('');
    cssInput.value = '';
    savedSnapshot = null;
    editorEmpty.hidden = true;
    editor.hidden = false;
    ensureBodyEditor();
    refreshBodyEditor();
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
      previouslyPublished = Boolean(note.publishedAt);
      notifySubscribersInput.checked = false;
      slugWasEdited = true;
      titleInput.value = note.title;
      dateInput.value = note.date;
      slugInput.value = note.slug;
      setBodyValue(note.body);
      cssInput.value = note.customCss || '';
      savedSnapshot = snapshot();
      editorEmpty.hidden = true;
      editor.hidden = false;
      ensureBodyEditor();
      refreshBodyEditor();
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
    noteList.querySelectorAll('[data-note-id]').forEach(item => {
      item.classList.toggle('is-current', item.dataset.noteId === currentId);
    });
  }

  async function movePublishedNote(id, direction) {
    if (reordering || busy) return;

    const published = notes.filter(note => note.status === 'published');
    const index = published.findIndex(note => note.id === id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= published.length) return;

    const reordered = [...published];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];

    reordering = true;
    showError('');
    try {
      await api('/api/admin/notes/order', {
        method: 'PATCH',
        body: JSON.stringify({ ids: reordered.map(note => note.id) }),
      });
      await refreshList();
    } catch (error) {
      showError(error.message);
    } finally {
      reordering = false;
    }
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

      items.forEach((note, index) => {
        const row = document.createElement('div');
        row.className = 'admin-note-item';
        row.dataset.noteId = note.id;

        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'admin-note-open';
        openButton.innerHTML = `
          <span>${escapeHtml(note.title)}</span>
          <small>${escapeHtml(note.date)} · ${note.status === 'published' ? 'Published' : 'Draft'}</small>
        `;
        openButton.addEventListener('click', () => openNote(note.id));
        row.append(openButton);

        if (note.status === 'published') {
          const controls = document.createElement('div');
          controls.className = 'admin-order-controls';
          controls.setAttribute('aria-label', `Change order of ${note.title}`);

          const up = document.createElement('button');
          up.type = 'button';
          up.className = 'admin-order-button';
          up.textContent = '↑';
          up.title = 'Move up';
          up.setAttribute('aria-label', `Move ${note.title} up`);
          up.disabled = index === 0;
          up.addEventListener('click', () => movePublishedNote(note.id, -1));

          const down = document.createElement('button');
          down.type = 'button';
          down.className = 'admin-order-button';
          down.textContent = '↓';
          down.title = 'Move down';
          down.setAttribute('aria-label', `Move ${note.title} down`);
          down.disabled = index === items.length - 1;
          down.addEventListener('click', () => movePublishedNote(note.id, 1));

          controls.append(up, down);
          row.append(controls);
        }

        noteList.append(row);
      });
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
        body: JSON.stringify({ body: getBodyValue() }),
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
      previouslyPublished = Boolean(data.note.publishedAt);
      notifySubscribersInput.checked = false;
      if (data.emailError) showError(data.emailError);
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

  async function loadSubscriberStatus() {
    try {
      const status = await api('/api/admin/notes-subscriptions/status');
      notifySubscribersInput.disabled = !status.configured || !status.active;
      notifySubscribersLabel.textContent = status.configured
        ? 'Email subscribers (' + status.active + ' confirmed)'
        : 'Email subscribers (mail not configured)';
    } catch {
      notifySubscribersInput.disabled = true;
      notifySubscribersLabel.textContent = 'Email subscribers (unavailable)';
    }
  }

  async function publishCurrent() {
    if (busy) return;
    let note = null;
    if (!currentId || isDirty()) note = await saveCurrent();
    if ((!currentId && !note) || isDirty()) return;

    busy = true;
    try {
      const data = await api(`/api/admin/notes/${encodeURIComponent(currentId)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ notifySubscribers: !previouslyPublished && notifySubscribersInput.checked }),
      });
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
    ensureBodyEditor();
    refreshBodyEditor();
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
      const session = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: passwordInput.value }),
      });
      window.NotesTabAuth.save(session.tabProof);
      passwordInput.value = '';
      showApp();
      await refreshList();
      await loadSubscriberStatus();
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
    try {
      await api('/api/admin/session');
      showApp();
      await refreshList();
      await loadSubscriberStatus();
    } catch {
      showLogin();
    }
  }

  initialise();
})();
