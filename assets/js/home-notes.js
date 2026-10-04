(() => {
  'use strict';

  const card = document.querySelector('#home-latest-note');
  if (!card) return;

  const dateEl = document.querySelector('#home-latest-note-date');
  const titleEl = document.querySelector('#home-latest-note-title');
  const excerptEl = document.querySelector('#home-latest-note-excerpt');
  const linkEl = document.querySelector('#home-latest-note-link');

  const dateFormatter = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  function formatDate(value) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
  }

  async function loadLatestNote() {
    try {
      const response = await fetch('/api/notes', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;

      const data = await response.json();
      const available = Array.isArray(data.notes) ? data.notes : [];
      const latest = [...available].sort((a, b) => {
        const byDate = String(b.date || '').localeCompare(String(a.date || ''));
        if (byDate !== 0) return byDate;
        return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
      })[0] || null;
      if (!latest) return;

      dateEl.textContent = formatDate(latest.date);
      dateEl.dateTime = latest.date;
      titleEl.textContent = latest.title;
      excerptEl.textContent = latest.excerpt || '';
      linkEl.href = `/notes.html#${encodeURIComponent(latest.slug)}`;
      card.hidden = false;
    } catch {
      // The Notes link remains useful even if the API is temporarily unavailable.
    }
  }

  loadLatestNote();
})();
