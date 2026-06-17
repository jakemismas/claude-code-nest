// Settings webview client script. Loaded under a per-load nonce with a CSP that
// forbids inline script. It exchanges JSON messages with the extension host:
// posts {type:'ready'} on load and {type:'save', value} on Save, and renders the
// host's {type:'state'|'saved'|'error'} replies. No DOM-injected HTML from
// host-supplied strings (textContent only), so the CSP-locked panel stays safe.
(function () {
  const vscode = acquireVsCodeApi();

  const input = document.getElementById('cleanupPeriodDays');
  const saveButton = document.getElementById('save');
  const effective = document.getElementById('effective');
  const status = document.getElementById('status');

  let defaultValue = 30;

  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle('is-error', Boolean(isError));
  }

  function renderState(msg) {
    defaultValue = typeof msg.defaultValue === 'number' ? msg.defaultValue : defaultValue;
    if (msg.usingDefault || msg.value === null) {
      input.value = '';
      input.placeholder = String(defaultValue);
      effective.textContent =
        'Not set. Claude Code uses its default of ' + defaultValue + ' days.';
    } else {
      input.value = String(msg.value);
      input.placeholder = String(defaultValue);
      effective.textContent = 'Currently set to ' + msg.value + ' days.';
    }
  }

  function save() {
    setStatus('', false);
    vscode.postMessage({ type: 'save', value: input.value });
  }

  saveButton.addEventListener('click', save);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      save();
    }
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'state') {
      renderState(msg);
    } else if (msg.type === 'saved') {
      setStatus('Saved.', false);
    } else if (msg.type === 'error') {
      setStatus(String(msg.error || 'Could not save.'), true);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
