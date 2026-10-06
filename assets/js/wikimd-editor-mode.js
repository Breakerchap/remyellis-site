(() => {
  'use strict';

  if (!window.CodeMirror || window.CodeMirror.modes.wikimd) return;

  window.CodeMirror.defineMode('wikimd', () => ({
    startState: () => ({ fencedCode: false, config: false, proseBlock: null }),

    token(stream, state) {
      if (state.fencedCode) {
        if (stream.sol() && stream.match(/^\s*\`\`\`/)) {
          state.fencedCode = false;
          stream.skipToEnd();
          return 'wmd-code-fence';
        }
        stream.skipToEnd();
        return 'wmd-code';
      }

      if (stream.sol()) {
        if (state.proseBlock && stream.match(/^\s*\]\]\]\s*$/)) {
          state.proseBlock = null;
          return 'wmd-prose-fence';
        }

        if (!state.proseBlock && stream.match(/^\s*\[\[\[\s*$/)) {
          state.proseBlock = 'brackets';
          return 'wmd-prose-fence';
        }

        if (stream.match(/^\s*\`\`\`(?:[A-Za-z0-9_-]+)?\s*$/)) {
          state.fencedCode = true;
          return 'wmd-code-fence';
        }

        if (stream.match(/^\s*@config\s*$/)) {
          state.config = true;
          return 'wmd-directive';
        }

        if (stream.match(/^\s*@endconfig\s*$/)) {
          state.config = false;
          return 'wmd-directive';
        }

        if (state.config) {
          stream.skipToEnd();
          return 'wmd-variable';
        }

        if (stream.match(/^\s*\/\/.*$/)) return 'wmd-comment';
        if (stream.match(/^\s*#{1,6}\s+.*$/)) return 'wmd-heading';
        if (stream.match(/^\s*>\s?.*$/)) return 'wmd-quote';
        if (stream.match(/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/)) return 'wmd-list';

        if (stream.match(/^\s*@(?:hidden|tab|title|include|embed|toc|var|style|endstyle|end|collapse|endcollapse)\b.*$/)) {
          return 'wmd-directive';
        }

        if (stream.match(/^\s*!(?:note|tip|info|warning|danger|rule|example|end)\b.*$/)) {
          return 'wmd-directive';
        }

        if (stream.match(/^\s*(?:[-+*]|\d+\.)\s+/)) return 'wmd-list';
      }

      const previous = stream.pos > 0 ? stream.string[stream.pos - 1] : '';

      if (stream.match(/^<<<(?!<)[^<>\n]+>>>(?!>)/)) return 'wmd-inline-prose';
      if (stream.match(/^<<(?!<)[^>\n]+>>(?!>)/)) return 'wmd-mention';
      if (stream.match(/^\[\[[^\]\n]+\]\]/)) return 'wmd-wikilink';
      if (stream.match(/^\[[^\]\n]+\]\([^\)\n]+\)/)) return 'wmd-link';
      if (stream.match(/^\{\{[A-Za-z][\w-]*\}\}/)) return 'wmd-variable';
      if (stream.match(/^\`[^\`\n]+\`/)) return 'wmd-code';

      if (stream.match(/^===[^=\n]+===/)) return 'wmd-highlight-red';
      if (stream.match(/^==[^=\n]+==/)) return 'wmd-highlight-orange';
      if (stream.match(/^=[^=\n]+=/)) return 'wmd-highlight-yellow';

      if (previous !== '\\' && previous !== '*' && stream.match(/^\*(?!\*)[^*\n]+\*(?!\*)/)) {
        return 'wmd-bold';
      }

      if (previous !== '\\' && previous !== '_' && stream.match(/^_(?!_)[^_\n]+_(?!_)/)) {
        return 'wmd-italic';
      }

      if (stream.match(/^\$\$[^$\n]+\$\$/)) return 'wmd-math';
      if (stream.match(/^\$[^$\n]+\$/)) return 'wmd-math';
      if (stream.match(/^\\\([^\n]+?\\\)/)) return 'wmd-math';
      if (stream.match(/^\\\[[^\n]+?\\\]/)) return 'wmd-math';

      stream.next();
      return state.proseBlock ? 'wmd-prose' : null;
    },
  }));
})();
