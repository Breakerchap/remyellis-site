(() => {
  'use strict';

  const target = document.querySelector('#note-content');
  if (!target || !window.renderMathInElement) return;

  window.renderMathInElement(target, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
  });
})();
