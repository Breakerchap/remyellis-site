(() => {
  'use strict';

  const list = document.querySelector('#notes-list');
  const empty = document.querySelector('#notes-empty');
  const errorBox = document.querySelector('#notes-error');

  if (!list) return;

  const dateFormatter = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  function formatDate(value) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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

  function renderBody(note, target) {
    target.innerHTML = sanitiseTrustedHtml(note.html || '');
    addStyle(target, note.compilerCss || '', 'wikimd');
    addStyle(target, note.customCss || '', note.slug || 'custom');
    renderMath(target);

    target.querySelectorAll('a').forEach(link => {
      if (link.hostname && link.hostname !== window.location.hostname) {
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      }
    });
  }

  function makeCard(note) {
    const article = document.createElement('article');
    article.className = 'note-card';
    article.dataset.slug = note.slug;

    const header = document.createElement('div');
    header.className = 'note-card-header';
    header.innerHTML = `
      <time datetime="${escapeHtml(note.date)}">${escapeHtml(formatDate(note.date))}</time>
      <h2>${escapeHtml(note.title)}</h2>
    `;

    const excerpt = document.createElement('div');
    excerpt.className = 'note-excerpt note-body';
    excerpt.innerHTML = sanitiseTrustedHtml(note.excerptHtml || escapeHtml(note.excerpt || ''));
    addStyle(excerpt, note.excerptCss || '', `${note.slug}-excerpt`);
    renderMath(excerpt);

    const body = document.createElement('div');
    body.className = 'note-body';
    body.hidden = true;

    const controls = document.createElement('div');
    controls.className = 'note-controls';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'note-toggle';
    toggle.textContent = 'Read note';
    toggle.setAttribute('aria-expanded', 'false');

    let loaded = false;
    let loading = false;

    toggle.addEventListener('click', async () => {
      if (!body.hidden) {
        body.hidden = true;
        excerpt.hidden = false;
        toggle.textContent = 'Read note';
        toggle.setAttribute('aria-expanded', 'false');
        history.replaceState(null, '', window.location.pathname);
        return;
      }

      if (!loaded && !loading) {
        loading = true;
        toggle.disabled = true;
        toggle.textContent = 'Loading…';
        try {
          const response = await fetch(`/api/notes/${encodeURIComponent(note.slug)}`);
          if (!response.ok) throw new Error('Could not load this note.');
          const data = await response.json();
          renderBody(data.note, body);
          loaded = true;
        } catch (error) {
          body.innerHTML = `<p class="notes-inline-error">${escapeHtml(error.message)}</p>`;
          loaded = true;
        } finally {
          loading = false;
          toggle.disabled = false;
        }
      }

      body.hidden = false;
      excerpt.hidden = true;
      toggle.textContent = 'Close note';
      toggle.setAttribute('aria-expanded', 'true');
      history.replaceState(null, '', `#${encodeURIComponent(note.slug)}`);
    });

    controls.append(toggle);
    article.append(header, excerpt, body, controls);
    return article;
  }

  async function loadNotes() {
    try {
      const response = await fetch('/api/notes', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not load notes.');
      const data = await response.json();
      list.innerHTML = '';

      if (!Array.isArray(data.notes) || data.notes.length === 0) {
        empty.hidden = false;
        return;
      }

      for (const note of data.notes) list.append(makeCard(note));

      const requestedSlug = decodeURIComponent(window.location.hash.slice(1));
      if (requestedSlug) {
        const card = [...list.querySelectorAll('.note-card')].find(item => item.dataset.slug === requestedSlug);
        if (card) {
          const button = card.querySelector('.note-toggle');
          button.click();
          card.scrollIntoView({ block: 'start' });
        }
      }
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  }

  loadNotes();
})();
