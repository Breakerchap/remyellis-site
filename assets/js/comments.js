(() => {
  'use strict';

  const section = document.querySelector('#comments[data-note-slug]');
  if (!section) return;

  const slug = section.dataset.noteSlug;
  const endpoint = '/api/comments/' + encodeURIComponent(slug);
  const stamp = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  let config = { enabled: false, siteKey: '' };
  let replyTo = null;
  let token = '';
  let widgetId = null;
  let mode = 'write';

  section.innerHTML = [
    '<div class="comments-heading"><h2>Comments</h2><span id="comments-count" aria-live="polite"></span></div>',
    '<p id="comments-error" class="notes-message notes-error" hidden></p>',
    '<div id="comments-list" class="comments-list" aria-live="polite"></div>',
    '<div class="comment-composer">',
    ' <h3>Leave a comment</h3>',
    ' <p class="comment-hint">Your comment will appear after approval. No account or email required.</p>',
    ' <p id="comment-status" class="notes-message" role="status" hidden></p>',
    ' <div id="comment-reply-context" hidden><span id="comment-reply-label"></span> <button type="button" id="comment-cancel-reply">Cancel reply</button></div>',
    ' <form id="comment-form">',
    '  <label for="comment-name">Name</label>',
    '  <input id="comment-name" name="name" maxlength="60" minlength="2" autocomplete="name" required placeholder="Your name">',
    '  <div class="comment-tabs" role="group" aria-label="Comment editor view"><button type="button" class="is-active" id="comment-write">Write</button><button type="button" id="comment-preview-button">Preview</button></div>',
    '  <label class="sr-only" for="comment-body">Comment in WMD</label>',
    '  <textarea id="comment-body" name="body" maxlength="4000" minlength="3" rows="5" required placeholder="Write your comment using WMD…"></textarea>',
    '  <div id="comment-preview" class="comment-content note-body" hidden></div>',
    '  <p class="comment-hint">Basic WMD: *bold*, _italic_, headings, lists, quotes, links, code and maths. No HTML or custom styles.</p>',
    '  <div class="comment-honeypot" aria-hidden="true"><label for="comment-website">Leave this blank</label><input id="comment-website" name="website" autocomplete="off" tabindex="-1"></div>',
    '  <div id="comment-turnstile" aria-label="Spam protection"></div>',
    '  <button id="comment-submit" type="submit" class="button primary">Submit for approval</button>',
    ' </form>',
    '</div>',
  ].join('\n');

  const list = section.querySelector('#comments-list');
  const errorBox = section.querySelector('#comments-error');
  const count = section.querySelector('#comments-count');
  const form = section.querySelector('#comment-form');
  const nameField = section.querySelector('#comment-name');
  const bodyField = section.querySelector('#comment-body');
  const message = section.querySelector('#comment-status');
  const preview = section.querySelector('#comment-preview');
  const context = section.querySelector('#comment-reply-context');
  const contextLabel = section.querySelector('#comment-reply-label');
  const writeButton = section.querySelector('#comment-write');
  const previewButton = section.querySelector('#comment-preview-button');
  const submitButton = section.querySelector('#comment-submit');

  function status(text, error = false) {
    message.hidden = !text;
    message.textContent = text;
    message.classList.toggle('notes-error', error);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      credentials: 'same-origin',
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The request failed (' + response.status + ').');
    return data;
  }

  function renderMath(element) {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(element, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    });
  }

  function makeComment(comment, all) {
    const article = document.createElement('article');
    article.className = 'comment-item' + (comment.parentId ? ' is-reply' : '');
    article.id = 'comment-' + comment.id;

    const avatar = document.createElement('div');
    avatar.className = 'comment-avatar' + (comment.author ? ' is-author' : '');
    if (comment.author) {
      const img = document.createElement('img');
      img.src = '/assets/css/images/Signature.png';
      img.alt = '';
      img.width = 40;
      img.height = 40;
      avatar.append(img);
    } else {
      avatar.textContent = (comment.name.trim()[0] || '?').toUpperCase();
      avatar.setAttribute('aria-hidden', 'true');
    }

    const main = document.createElement('div');
    main.className = 'comment-main';
    const byline = document.createElement('div');
    byline.className = 'comment-byline';
    const name = document.createElement('strong');
    name.textContent = comment.name;
    byline.append(name);
    if (comment.author) {
      const verified = document.createElement('span');
      verified.className = 'comment-author-badge';
      verified.setAttribute('aria-label', 'Verified site author');
      verified.title = 'Verified site author';
      verified.textContent = '✓ Author';
      byline.append(verified);
    }
    const time = document.createElement('time');
    time.dateTime = comment.createdAt;
    const parsed = new Date(comment.createdAt);
    time.textContent = Number.isNaN(parsed.getTime()) ? '' : stamp.format(parsed);
    byline.append(time);

    const content = document.createElement('div');
    content.className = 'comment-content note-body';
    // This HTML comes only from the server's strict allowlisted renderer.
    content.innerHTML = comment.html;
    renderMath(content);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'comment-reply-button';
    action.textContent = 'Reply';
    action.addEventListener('click', () => {
      replyTo = comment.parentId || comment.id;
      contextLabel.textContent = 'Replying to ' + comment.name;
      context.hidden = false;
      status('');
      nameField.scrollIntoView({ block: 'center', behavior: 'smooth' });
      bodyField.focus({ preventScroll: true });
    });

    main.append(byline, content, action);
    article.append(avatar, main);
    if (!comment.parentId) {
      const children = all.filter(c => c.parentId === comment.id);
      if (children.length) {
        const replies = document.createElement('div');
        replies.className = 'comment-replies';
        for (const child of children) replies.append(makeComment(child, []));
        main.append(replies);
      }
    }
    return article;
  }

  async function refresh() {
    const data = await request(endpoint);
    list.replaceChildren();
    count.textContent = data.comments.length + (data.comments.length === 1 ? ' comment' : ' comments');
    if (!data.comments.length) {
      const p = document.createElement('p');
      p.className = 'notes-message';
      p.textContent = 'No comments yet. You can start the discussion.';
      list.append(p);
    } else {
      for (const comment of data.comments.filter(c => !c.parentId)) {
        list.append(makeComment(comment, data.comments));
      }
    }
    errorBox.hidden = true;
  }

  function setMode(next) {
    mode = next;
    const showingPreview = next === 'preview';
    bodyField.hidden = showingPreview;
    preview.hidden = !showingPreview;
    writeButton.classList.toggle('is-active', !showingPreview);
    previewButton.classList.toggle('is-active', showingPreview);
  }

  previewButton.addEventListener('click', async () => {
    if (!bodyField.value.trim()) {
      preview.textContent = 'Nothing to preview yet.';
      setMode('preview');
      return;
    }
    preview.textContent = 'Rendering preview…';
    setMode('preview');
    try {
      const data = await request('/api/comments/preview', {
        method: 'POST', body: JSON.stringify({ body: bodyField.value }),
      });
      if (mode !== 'preview') return;
      preview.innerHTML = data.html; // Safe subset renderer, no user HTML.
      renderMath(preview);
    } catch (error) {
      preview.textContent = error.message;
    }
  });
  writeButton.addEventListener('click', () => setMode('write'));
  section.querySelector('#comment-cancel-reply').addEventListener('click', () => {
    replyTo = null;
    context.hidden = true;
  });

  function resetChallenge() {
    token = '';
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
  }

  function initialiseTurnstile() {
    if (!config.enabled) {
      submitButton.disabled = true;
      status('Comment submissions are not configured yet. Existing comments can still be read.', true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (!window.turnstile) return;
      widgetId = window.turnstile.render('#comment-turnstile', {
        sitekey: config.siteKey,
        theme: 'auto',
        callback: value => { token = value; },
        'expired-callback': () => { token = ''; },
        'error-callback': () => { token = ''; },
      });
    };
    script.onerror = () => status('Spam protection could not load. Please refresh the page.', true);
    document.head.append(script);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setMode('write');
    if (!form.reportValidity()) return;
    if (!config.enabled) return status('Comments are temporarily unavailable.', true);
    if (!token) return status('Please complete the spam check first.', true);
    submitButton.disabled = true;
    status('Submitting…');
    try {
      await request(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          name: nameField.value.trim(),
          body: bodyField.value,
          parentId: replyTo,
          website: section.querySelector('#comment-website').value,
          turnstileToken: token,
        }),
      });
      bodyField.value = '';
      replyTo = null;
      context.hidden = true;
      preview.replaceChildren();
      resetChallenge();
      status('Your comment has been received and is awaiting approval.');
      await refresh();
    } catch (error) {
      resetChallenge();
      status(error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  });

  async function start() {
    try {
      const [settings] = await Promise.all([request('/api/comments/config'), refresh()]);
      config = settings;
      initialiseTurnstile();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  }
  start();
})();
