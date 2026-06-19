// PROOF-OF-CONCEPT webview script for Chats (Preview). Receives the row snapshot
// from the host, groups it by recency, renders custom cards, supports an inline
// text filter, and posts an 'open' message on click. Inline filtering and recency
// group headers are the two things the native TreeView cannot do; they live here.
(function () {
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById('list');
  const filterEl = document.getElementById('filter');
  const refreshEl = document.getElementById('refresh');

  let rows = [];

  const DAY = 24 * 60 * 60 * 1000;

  function bucket(ts) {
    if (ts === null || ts === undefined) {
      return 'No date';
    }
    const age = Date.now() - ts;
    if (age < DAY) {
      return 'Today';
    }
    if (age < 7 * DAY) {
      return 'This week';
    }
    if (age < 30 * DAY) {
      return 'This month';
    }
    return 'Older';
  }

  const ORDER = ['Today', 'This week', 'This month', 'Older', 'No date'];

  function render() {
    const needle = filterEl.value.trim().toLowerCase();
    const visible = needle
      ? rows.filter((r) => r.title.toLowerCase().includes(needle))
      : rows;

    listEl.textContent = '';

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'nest-empty';
      empty.textContent = rows.length === 0 ? 'No chats found.' : 'No chats match the filter.';
      listEl.appendChild(empty);
      return;
    }

    const groups = new Map();
    for (const r of visible) {
      const key = bucket(r.timestamp);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(r);
    }

    for (const key of ORDER) {
      const items = groups.get(key);
      if (!items) {
        continue;
      }
      const header = document.createElement('div');
      header.className = 'nest-group';
      header.textContent = key + ' (' + items.length + ')';
      listEl.appendChild(header);

      for (const r of items) {
        const card = document.createElement('div');
        card.className = 'nest-card';
        card.title = r.title;

        const title = document.createElement('div');
        title.className = 'nest-card-title';
        title.textContent = r.title;

        const meta = document.createElement('div');
        meta.className = 'nest-card-meta';
        meta.textContent = r.description || 'no timestamp';

        card.appendChild(title);
        card.appendChild(meta);
        card.addEventListener('click', () => {
          vscode.postMessage({ type: 'open', sessionId: r.sessionId });
        });
        listEl.appendChild(card);
      }
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'rows' && Array.isArray(msg.rows)) {
      rows = msg.rows;
      render();
    }
  });

  filterEl.addEventListener('input', render);
  refreshEl.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  vscode.postMessage({ type: 'ready' });
})();
