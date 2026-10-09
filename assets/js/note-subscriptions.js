(() => {
  'use strict';

  const blocks = document.querySelectorAll('.notes-subscribe');
  if (!blocks.length) return;

  async function initialise() {
    let enabled = false;
    try {
      const response = await fetch('/api/notes-subscriptions/config', {
        headers: { Accept: 'application/json' }, credentials: 'same-origin',
      });
      if (response.ok) {
        const data = await response.json();
        enabled = Boolean(data.enabled);
      }
    } catch { /* Backend temporarily unavailable. */ }

    for (const block of blocks) {
      const form = block.querySelector('.notes-subscribe-form');
      const email = form.elements.email;
      const button = form.querySelector('button[type="submit"]');
      const status = block.querySelector('.notes-subscribe-status');

      if (!enabled) {
        block.hidden = true;
        continue;
      }

      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        button.disabled = true;
        status.hidden = false;
        status.classList.remove('is-error');
        status.textContent = 'Sending confirmation…';
        try {
          const response = await fetch('/api/notes-subscriptions', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              email: email.value.trim(),
              website: form.elements.website.value,
            }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || 'Could not subscribe right now.');
          form.reset();
          status.textContent = result.message || 'Check your email to confirm.';
        } catch (error) {
          status.textContent = error.message;
          status.classList.add('is-error');
        } finally { button.disabled = false; }
      });
    }
  }
  initialise();
})();
