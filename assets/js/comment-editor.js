(() => {
  'use strict';

  // One editor for both public comments and the moderation inbox.
  // Uses the same WikiMD CodeMirror mode as the full Notes editor.
  window.CommentWmdEditor = {
    create(textarea) {
      if (!window.CodeMirror || !window.CodeMirror.modes.wikimd) {
        return {
          getValue: () => textarea.value,
          setValue: value => { textarea.value = value; },
          focus: () => textarea.focus(),
          show: value => { textarea.hidden = !value; },
          destroy: () => {},
        };
      }
      const cm = window.CodeMirror.fromTextArea(textarea, {
        mode: 'wikimd',
        inputStyle: 'contenteditable',
        spellcheck: true,
        autocorrect: true,
        autocapitalize: true,
        lineWrapping: true,
        indentUnit: 2,
        tabSize: 2,
        viewportMargin: 15,
        extraKeys: {
          Insert(editor) { editor.toggleOverwrite(false); },
          Tab(editor) {
            if (editor.somethingSelected()) editor.indentSelection('add');
            else editor.replaceSelection('  ', 'end');
          },
          'Shift-Tab'(editor) { editor.indentSelection('subtract'); },
        },
      });
      const wrapper = cm.getWrapperElement();
      wrapper.classList.add('comment-code-editor');
      cm.setSize('100%', 152);
      cm.toggleOverwrite(false);
      cm.on('focus', editor => editor.toggleOverwrite(false));
      const input = cm.getInputField();
      if (input) {
        input.setAttribute('spellcheck', 'true');
        input.setAttribute('autocorrect', 'on');
        input.setAttribute('autocapitalize', 'sentences');
      }
      return {
        getValue: () => cm.getValue(),
        setValue(value) { cm.setValue(String(value ?? '')); },
        focus: () => cm.focus(),
        show(value) {
          wrapper.hidden = !value;
          if (value) requestAnimationFrame(() => cm.refresh());
        },
        destroy: () => cm.toTextArea(),
      };
    },
  };
})();
