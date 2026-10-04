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

  function noteUrl(note) {
    return note.url || `/notes/${encodeURIComponent(note.slug)}`;
  }

  function makeCard(note) {
    const article = document.createElement('article');
    article.className = 'note-card';
    article.dataset.slug = note.slug;

    const url = noteUrl(note);
    const header = document.createElement('div');
    header.className = 'note-card-header';
    header.innerHTML = `
      <time datetime="${escapeHtml(note.date)}">${escapeHtml(formatDate(note.date))}</time>
      <h2><a class="note-title-link" href="${escapeHtml(url)}">${escapeHtml(note.title)}</a></h2>
    `;

    const excerpt = document.createElement('div');
    excerpt.className = 'note-excerpt note-body';
    excerpt.innerHTML = sanitiseTrustedHtml(note.excerptHtml || escapeHtml(note.excerpt || ''));
    addStyle(excerpt, note.excerptCss || '', `${note.slug}-excerpt`);
    renderMath(excerpt);

    const controls = document.createElement('div');
    controls.className = 'note-controls';

    const link = document.createElement('a');
    link.className = 'note-toggle';
    link.href = url;
    link.textContent = 'Read note';

    controls.append(link);
    article.append(header, excerpt, controls);
    return article;
  }

  async function loadNotes() {
    try {
      const response = await fetch('/api/notes', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not load notes.');
      const data = await response.json();

      if (!Array.isArray(data.notes) || data.notes.length === 0) {
        list.innerHTML = '';
        empty.hidden = false;
        return;
      }

      const requestedSlug = decodeURIComponent(window.location.hash.slice(1));
      if (requestedSlug) {
        const requested = data.notes.find(note => note.slug === requestedSlug);
        if (requested) {
          window.location.replace(noteUrl(requested));
          return;
        }
      }

      list.innerHTML = '';
      for (const note of data.notes) list.append(makeCard(note));
    } catch (error) {
      list.innerHTML = '';
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  }

  loadNotes();
})();
