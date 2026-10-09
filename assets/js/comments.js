(() => {
  'use strict';
  const section = document.querySelector('#comments[data-note-slug]');
  if (!section) return;
  const url = '/api/comments/' + encodeURIComponent(section.dataset.noteSlug);
  const dateFormat = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  let config = { enabled: false, owner: false, siteKey: '' };
  let replyTo = null, turnstileToken = '', widgetId = null, challengeStarted = false, mode = 'write';

  section.innerHTML = [
    '<div class="comments-heading"><h2>Discussion</h2><span id="comments-count" aria-live="polite"></span></div>',
    '<p id="comments-error" class="comments-ui-message is-error" hidden></p>',
    '<div id="comments-list" class="comments-list" aria-live="polite"></div>',
    '<details id="comment-compose-details" class="comment-compose-details">',
    ' <summary>Write a comment <span aria-hidden="true">＋</span></summary>',
    ' <div class="comment-composer">',
    '   <p id="comment-compose-intro" class="comment-hint">Comments appear once approved. No account or email needed.</p>',
    '   <p id="comment-status" class="comments-ui-message" role="status" hidden></p>',
    '   <div id="comment-reply-context" class="comment-reply-context" hidden><strong id="comment-reply-label"></strong><button type="button" id="comment-cancel-reply">Cancel reply</button></div>',
    '   <form id="comment-form">',
    '     <div id="comment-name-row"><label for="comment-name">Name</label><input id="comment-name" name="name" minlength="2" maxlength="60" autocomplete="name" placeholder="Your name" required></div>',
    '     <div id="comment-owner-row" class="comment-owner-row" hidden><img src="/assets/css/images/Signature.png" width="28" height="28" alt=""><strong>Remy Ellis</strong><span>✓ Author</span></div>',
    '     <div class="comment-editor-top"><span>Comment <small>(WMD)</small></span><div class="comment-tabs"><button type="button" id="comment-write" class="is-active">Write</button><button type="button" id="comment-preview-button">Preview</button></div></div>',
    '     <textarea id="comment-body" name="body" minlength="3" maxlength="4000" rows="5" spellcheck="true" placeholder="Write your comment…"></textarea>',
    '     <div id="comment-preview" class="comment-content note-body" hidden></div>',
    '     <p class="comment-format-help">WMD: <code>*bold*</code> <code>_italic_</code> <code>&#96;code&#96;</code> <code># heading</code> <code>[link](https://example.com)</code>. No HTML or custom styles.</p>',
    '     <div class="comment-honeypot" aria-hidden="true"><label for="comment-website">Leave blank</label><input id="comment-website" autocomplete="off" tabindex="-1"></div>',
    '     <div id="comment-turnstile" aria-label="Spam protection"></div>',
    '     <button type="submit" id="comment-submit" class="comment-ui-button comment-ui-primary">Submit for approval</button>',
    '   </form>',
    ' </div>',
    '</details>',
  ].join('');

  const byId = id => section.querySelector('#' + id);
  const list = byId('comments-list'), count = byId('comments-count');
  const errorBox = byId('comments-error'), details = byId('comment-compose-details');
  const form = byId('comment-form'), bodyField = byId('comment-body');
  const editor = window.CommentWmdEditor?.create(bodyField) || {
    getValue: () => bodyField.value, setValue: value => { bodyField.value = value; },
    focus: () => bodyField.focus(), show: value => { bodyField.hidden = !value; },
  };
  const preview = byId('comment-preview'), nameField = byId('comment-name');
  const submitButton = byId('comment-submit');

  async function api(path, method = 'GET', input) {
    const response = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ').');
    return data;
  }
  function showStatus(value, error = false) {
    const el = byId('comment-status');
    el.hidden = !value; el.textContent = value; el.classList.toggle('is-error', error);
  }
  function renderMath(el) {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    });
  }
  function elem(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = value;
    return el;
  }
  function commentNode(comment, comments) {
    const outer = elem('article', 'comment-item');
    outer.id = 'comment-' + comment.id;
    const avatar = elem('div', 'comment-avatar' + (comment.author ? ' is-author' : ''));
    if (comment.author) {
      const pic = document.createElement('img');
      pic.src = '/assets/css/images/Signature.png'; pic.alt = '';
      pic.width = 36; pic.height = 36; avatar.append(pic);
    } else avatar.textContent = (comment.name.trim().charAt(0) || '?').toUpperCase();
    const main = elem('div', 'comment-main');
    const meta = elem('div', 'comment-byline');
    meta.append(elem('strong', '', comment.name));
    if (comment.author) meta.append(elem('span', 'comment-author-badge', '✓ Author'));
    const time = elem('time');
    const date = new Date(comment.createdAt);
    time.dateTime = comment.createdAt;
    time.textContent = Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
    meta.append(time);
    const content = elem('div', 'comment-content note-body');
    content.innerHTML = comment.html;
    renderMath(content);
    const reply = elem('button', 'comment-reply-button', '↳ Reply');
    reply.type = 'button';
    reply.addEventListener('click', () => {
      replyTo = comment.parentId || comment.id;
      byId('comment-reply-label').textContent = 'Replying to ' + comment.name;
      byId('comment-reply-context').hidden = false;
      details.open = true; showStatus('');
      details.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => editor.focus(), 120);
    });
    main.append(meta, content, reply); outer.append(avatar, main);
    if (!comment.parentId) {
      const children = comments.filter(item => item.parentId === comment.id);
      if (children.length) {
        const replies = elem('div', 'comment-replies');
        for (const child of children) replies.append(commentNode(child, []));
        main.append(replies);
      }
    }
    return outer;
  }
  async function refresh() {
    const data = await api(url);
    list.replaceChildren();
    count.textContent = data.comments.length + (data.comments.length === 1 ? ' comment' : ' comments');
    if (!data.comments.length) list.append(elem('p', 'comment-empty', 'No comments yet.'));
    else for (const comment of data.comments.filter(item => !item.parentId)) {
      list.append(commentNode(comment, data.comments));
    }
    errorBox.hidden = true;
  }
  function setMode(value) {
    mode = value;
    editor.show(value === 'write');
    preview.hidden = value !== 'preview';
    byId('comment-write').classList.toggle('is-active', value === 'write');
    byId('comment-preview-button').classList.toggle('is-active', value === 'preview');
  }
  byId('comment-write').addEventListener('click', () => setMode('write'));
  byId('comment-preview-button').addEventListener('click', async () => {
    const body = editor.getValue();
    if (!body.trim()) {
      preview.textContent = 'Nothing to preview yet.'; setMode('preview'); return;
    }
    setMode('preview'); preview.textContent = 'Rendering…';
    try {
      const result = await api('/api/comments/preview', 'POST', { body });
      if (mode === 'preview') { preview.innerHTML = result.html; renderMath(preview); }
    } catch (error) { preview.textContent = error.message; }
  });
  byId('comment-cancel-reply').addEventListener('click', () => {
    replyTo = null; byId('comment-reply-context').hidden = true;
  });

  function startChallenge() {
    if (challengeStarted || config.owner || !config.enabled) return;
    challengeStarted = true;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      if (!window.turnstile) return;
      widgetId = window.turnstile.render('#comment-turnstile', {
        sitekey: config.siteKey, theme: 'light',
        callback: value => { turnstileToken = value; },
        'expired-callback': () => { turnstileToken = ''; },
        'error-callback': () => { turnstileToken = ''; },
      });
    };
    script.onerror = () => showStatus('Spam check could not load. Please refresh the page.', true);
    document.head.append(script);
  }
  details.addEventListener('toggle', () => { if (details.open) startChallenge(); });

  form.addEventListener('submit', async event => {
    event.preventDefault(); setMode('write');
    const body = editor.getValue();
    if (!config.owner && !nameField.value.trim()) return showStatus('Please enter your name.', true);
    if (body.trim().length < 3) return showStatus('Please write at least three characters.', true);
    if (!config.owner && !config.enabled) return showStatus('Comment submissions are not configured.', true);
    if (!config.owner && !turnstileToken) return showStatus('Complete the spam check first.', true);
    submitButton.disabled = true; showStatus('Submitting…');
    try {
      const result = await api(url, 'POST', {
        name: nameField.value.trim(), body, parentId: replyTo,
        website: byId('comment-website').value, turnstileToken,
      });
      editor.setValue(''); replyTo = null;
      byId('comment-reply-context').hidden = true;
      if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
      turnstileToken = ''; preview.replaceChildren();
      showStatus(result.message || (result.pending ? 'Awaiting approval.' : 'Published.'));
      await refresh();
    } catch (error) {
      if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
      turnstileToken = ''; showStatus(error.message, true);
    } finally { submitButton.disabled = false; }
  });

  async function initialise() {
    try {
      config = await api('/api/comments/config');
      if (config.owner) {
        byId('comment-name-row').hidden = true;
        nameField.required = false;
        byId('comment-owner-row').hidden = false;
        byId('comment-compose-intro').textContent = 'Signed in as the site author. Your comments publish immediately.';
        submitButton.textContent = 'Post as Remy Ellis';
      } else if (!config.enabled) {
        showStatus('Comments are temporarily unavailable.', true);
        submitButton.disabled = true;
      }
    } catch (error) { showStatus(error.message, true); }
    try { await refresh(); } catch (error) {
      errorBox.hidden = false; errorBox.textContent = error.message;
    }
  }
  initialise();
})();
