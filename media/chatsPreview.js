// PROOF-OF-CONCEPT webview script for Chats (Preview). Receives the row snapshot
// from the host, groups it by recency, renders custom cards, supports an inline
// text filter, and posts an 'open' message on click. Inline filtering and recency
// group headers are the two things the native TreeView cannot do; they live here.
//
// Slice s2-fulltext-search adds a CONTENT-SEARCH mode (the "Search chat content"
// checkbox). When OFF, the filter box does the original client-side title filter
// over the loaded rows. When ON, the filter box debounces a 'search' message to
// the host, which runs the MiniSearch body index and posts back ranked
// 'searchResults' rows with matched snippets; those render in score order (no
// recency grouping). Clearing the box restores the full list. The durable search
// logic is host-side (src/search/*); this file only wires the mode and renders.
(function () {
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById('list');
  const filterEl = document.getElementById('filter');
  const refreshEl = document.getElementById('refresh');
  const contentModeEl = document.getElementById('contentMode');

  let rows = [];
  // The most recent content-search result set and the query it answered, so a
  // late-arriving response for a stale query can be ignored.
  let searchRows = [];
  let searchQuery = '';
  let searchPending = false;

  const DAY = 24 * 60 * 60 * 1000;
  const SEARCH_DEBOUNCE_MS = 200;
  let searchTimer = null;

  function contentMode() {
    return !!(contentModeEl && contentModeEl.checked);
  }

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

  // Build one card element for a row. Shared by both render paths so a search
  // result and a normal row look identical apart from the snippet source.
  function makeCard(r) {
    const card = document.createElement('div');
    card.className = 'nest-card';
    card.title = r.title;

    const title = document.createElement('div');
    title.className = 'nest-card-title';
    title.textContent = r.title;

    const meta = document.createElement('div');
    meta.className = 'nest-card-meta';
    const when = r.description || 'no timestamp';
    meta.textContent = r.tokens ? when + ' | ' + r.tokens : when;

    card.appendChild(title);
    card.appendChild(meta);

    if (r.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'nest-card-snippet';
      snippet.textContent = r.snippet;
      card.appendChild(snippet);
    }
    card.addEventListener('click', () => {
      vscode.postMessage({ type: 'open', sessionId: r.sessionId });
    });
    return card;
  }

  function renderEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'nest-empty';
    empty.textContent = message;
    listEl.appendChild(empty);
  }

  // Content-search render: ranked rows in score order (the host already sorted
  // them), no recency grouping, with a result-count header.
  function renderSearch() {
    listEl.textContent = '';
    if (searchPending) {
      renderEmpty('Searching...');
      return;
    }
    if (searchRows.length === 0) {
      renderEmpty('No chats match "' + searchQuery + '".');
      return;
    }
    const header = document.createElement('div');
    header.className = 'nest-group';
    header.textContent = 'Results (' + searchRows.length + ')';
    listEl.appendChild(header);
    for (const r of searchRows) {
      listEl.appendChild(makeCard(r));
    }
  }

  // The default render: client-side title filter, grouped by recency.
  function renderList() {
    const needle = filterEl.value.trim().toLowerCase();
    const visible = needle
      ? rows.filter((r) => r.title.toLowerCase().includes(needle))
      : rows;

    listEl.textContent = '';

    if (visible.length === 0) {
      renderEmpty(rows.length === 0 ? 'No chats found.' : 'No chats match the filter.');
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
        listEl.appendChild(makeCard(r));
      }
    }
  }

  // The single render entry point: dispatch by mode and (in content mode)
  // whether a query is active.
  function render() {
    if (contentMode() && filterEl.value.trim().length > 0) {
      renderSearch();
    } else {
      renderList();
    }
  }

  // In content mode, debounce a search request to the host. An empty query
  // restores the full list immediately (no host round-trip).
  function onFilterInput() {
    if (!contentMode()) {
      render();
      return;
    }
    const query = filterEl.value.trim();
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    if (query.length === 0) {
      searchPending = false;
      searchRows = [];
      searchQuery = '';
      render();
      return;
    }
    searchPending = true;
    render();
    searchTimer = setTimeout(() => {
      searchTimer = null;
      vscode.postMessage({ type: 'search', query: query });
    }, SEARCH_DEBOUNCE_MS);
  }

  function onModeChange() {
    // Switching modes re-runs the current box content under the new mode.
    onFilterInput();
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    if (msg.type === 'rows' && Array.isArray(msg.rows)) {
      rows = msg.rows;
      render();
    } else if (msg.type === 'searchResults' && Array.isArray(msg.rows)) {
      // Ignore a stale response whose query no longer matches the box (and only
      // accept it when still in content mode).
      const current = filterEl.value.trim();
      if (!contentMode() || msg.query !== current) {
        return;
      }
      searchPending = false;
      searchRows = msg.rows;
      searchQuery = msg.query;
      render();
    }
  });

  filterEl.addEventListener('input', onFilterInput);
  if (contentModeEl) {
    contentModeEl.addEventListener('change', onModeChange);
  }
  refreshEl.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  vscode.postMessage({ type: 'ready' });
})();
