// The PRIMARY org-panel webview script (slice s2-org-panel-webview). It renders
// the host-assembled section model (Starred, Questions heuristic, the folder
// hierarchy with per-folder color, Unsorted) as an ARIA tree, supports tag filter
// chips, sort and density modes, double-click folder rename, drag-and-drop that
// posts a self-describing drop message the host maps to the unchanged pure
// reducer, full keyboard navigation, and a content-search mode.
//
// Accessibility is an ACCEPTANCE CRITERION, not polish: the list is role="tree"
// with role="treeitem" rows grouped under role="group" sections, a single roving
// tabindex (one focusable item at a time), arrow-key navigation, Enter/Space
// activation, and a visible focus ring (CSS). The DnD shell is fully in-process:
// the drag start records the dragged chat ids, and the drop posts them straight to
// the host, so no cross-controller transfer is involved.
(function () {
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById('list');
  const chipsEl = document.getElementById('chips');
  const filterEl = document.getElementById('filter');
  const refreshEl = document.getElementById('refresh');
  const sortEl = document.getElementById('sort');
  const densityEl = document.getElementById('density');
  const contentModeEl = document.getElementById('contentMode');

  // The latest host-posted section model.
  let sections = { starred: [], questions: [], folders: [], tags: [] };
  // The set of active tag-id filters (AND across selected chips: a row must carry
  // every selected tag to show).
  const activeTags = new Set();
  // The current text filter (title substring in non-content mode).
  let textFilter = '';
  // Content-search state.
  let searchRows = [];
  let searchQuery = '';
  let searchPending = false;
  let searchTimer = null;
  const SEARCH_DEBOUNCE_MS = 200;

  // Sort and density, hydrated from the host's persisted state on 'state'.
  let sortMode = 'newest';
  let densityMode = 'comfortable';

  // The dragged chat ids for an in-flight in-panel drag (fully in-process; the
  // drop posts these straight to the host). Cleared on dragend.
  let draggingChatIds = [];

  // The roving-tabindex focus target: the index into the flat list of rendered
  // focusable rows. Kept stable across re-renders by sessionId when possible.
  let focusedId = null;

  function contentMode() {
    return !!(contentModeEl && contentModeEl.checked);
  }

  // ---- chip filter ----

  function renderChips() {
    chipsEl.textContent = '';
    if (!sections.tags || sections.tags.length === 0) {
      chipsEl.style.display = 'none';
      return;
    }
    chipsEl.style.display = 'flex';
    for (const chip of sections.tags) {
      const el = document.createElement('button');
      el.className = 'nest-chip';
      el.type = 'button';
      const active = activeTags.has(chip.tagId);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active) {
        el.classList.add('nest-chip-active');
      }
      if (chip.color) {
        el.style.setProperty('--chip-color', chip.color);
      }
      el.textContent = chip.label + ' (' + chip.count + ')';
      el.addEventListener('click', () => {
        if (activeTags.has(chip.tagId)) {
          activeTags.delete(chip.tagId);
        } else {
          activeTags.add(chip.tagId);
        }
        renderChips();
        render();
      });
      // A chip is also a DROP TARGET: dropping chats on it tags them (the host
      // maps a 'tag' drop to the reducer's tag-add). Wired here so the chip's
      // drop handling lives with its creation.
      attachChipDropTarget(el, chip.tagId);
      chipsEl.appendChild(el);
    }
  }

  // ---- row matching (text + tag filters) ----

  function rowMatches(row) {
    if (activeTags.size > 0) {
      const ids = row.tagIds || [];
      for (const t of activeTags) {
        if (ids.indexOf(t) === -1) {
          return false;
        }
      }
    }
    if (textFilter.length > 0) {
      if (row.title.toLowerCase().indexOf(textFilter) === -1) {
        return false;
      }
    }
    return true;
  }

  function sortRows(rows) {
    const copy = rows.slice();
    if (sortMode === 'oldest') {
      copy.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    } else if (sortMode === 'name') {
      copy.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    } else {
      copy.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    return copy;
  }

  // ---- row + section rendering ----

  // Build one chat row (role="treeitem"). Draggable; double-click is reserved for
  // folder rename, so a row's activation is a single click / Enter / Space.
  function makeRow(row, depth) {
    const el = document.createElement('div');
    el.className = 'nest-row';
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-label', rowAriaLabel(row));
    el.setAttribute('tabindex', '-1');
    el.dataset.kind = 'chat';
    el.dataset.id = row.sessionId;
    el.style.paddingLeft = 10 + depth * 12 + 'px';
    el.draggable = true;

    const title = document.createElement('div');
    title.className = 'nest-row-title';
    if (row.starred) {
      const star = document.createElement('span');
      star.className = 'nest-star';
      star.setAttribute('aria-hidden', 'true');
      star.textContent = '★';
      title.appendChild(star);
    }
    const titleText = document.createElement('span');
    titleText.className = 'nest-row-title-text';
    titleText.textContent = row.title;
    title.appendChild(titleText);

    const meta = document.createElement('div');
    meta.className = 'nest-row-meta';
    const when = relative(row.timestamp);
    meta.textContent = row.tokens ? when + ' | ' + row.tokens : when;

    el.appendChild(title);
    el.appendChild(meta);

    if (densityMode === 'comfortable') {
      if (row.tags && row.tags.length > 0) {
        const tagRow = document.createElement('div');
        tagRow.className = 'nest-row-tags';
        for (const label of row.tags) {
          const t = document.createElement('span');
          t.className = 'nest-tag';
          t.textContent = label;
          tagRow.appendChild(t);
        }
        el.appendChild(tagRow);
      }
      if (row.snippet) {
        const snip = document.createElement('div');
        snip.className = 'nest-row-snippet';
        snip.textContent = row.snippet;
        el.appendChild(snip);
      }
    }

    el.addEventListener('click', () => activateRow(row.sessionId));
    el.addEventListener('dragstart', (e) => onRowDragStart(e, row.sessionId));
    el.addEventListener('dragend', onDragEnd);
    return el;
  }

  function rowAriaLabel(row) {
    let label = row.title;
    if (row.starred) {
      label = 'Starred. ' + label;
    }
    if (row.awaitingReply) {
      label = label + '. Awaiting your reply (heuristic).';
    }
    return label;
  }

  // Build a section header (role="presentation"; the group it labels carries the
  // accessible name via aria-label). count is the visible row count.
  function makeSectionHeader(text, count, opts) {
    const header = document.createElement('div');
    header.className = 'nest-section-header';
    if (opts && opts.color) {
      const dot = document.createElement('span');
      dot.className = 'nest-folder-dot';
      dot.style.background = opts.color;
      dot.setAttribute('aria-hidden', 'true');
      header.appendChild(dot);
    }
    const labelEl = document.createElement('span');
    labelEl.className = 'nest-section-label';
    labelEl.textContent = text;
    header.appendChild(labelEl);
    const countEl = document.createElement('span');
    countEl.className = 'nest-section-count';
    countEl.textContent = String(count);
    header.appendChild(countEl);
    if (opts && opts.heuristic) {
      const tag = document.createElement('span');
      tag.className = 'nest-heuristic-tag';
      tag.textContent = 'heuristic';
      tag.title = 'A scan-time guess from the last message role, not a live signal.';
      header.appendChild(tag);
    }
    return header;
  }

  // Render one section (a header plus a role="group" of rows). A folder section is
  // also a DROP TARGET: dropping chats onto it files them there (or unfiles on the
  // synthetic Unsorted bucket). The header of a real folder is double-click
  // renameable and right-click recolorable.
  function renderSection(opts) {
    const { key, label, rows, depth, folderId, color, synthetic, heuristic, droppable } = opts;
    const visible = sortRows(rows.filter(rowMatches));
    // Cross-cutting sections (Starred, Questions) hide entirely when empty
    // (UI-SPEC). Folder sections always render so the hierarchy and drop targets
    // stay visible, EXCEPT a non-Unsorted folder with no visible rows under an
    // active filter still shows (its drop target is useful); the synthetic
    // Unsorted bucket is always present.
    if (!droppable && visible.length === 0) {
      return;
    }

    const header = makeSectionHeader(label, visible.length, { color, heuristic });
    if (droppable) {
      header.style.paddingLeft = 8 + depth * 12 + 'px';
      header.dataset.dropFolderId = folderId;
      if (!synthetic) {
        // A real folder header is a navigable, actionable tree row: role="treeitem"
        // so it joins the roving-tabindex set, with aria-level for nesting depth and
        // an accessible name. Enter/Space opens an in-place rename; double-click
        // renames; right-click opens the folder actions menu.
        header.dataset.renameFolderId = folderId;
        header.setAttribute('role', 'treeitem');
        header.setAttribute('aria-level', String(depth + 1));
        header.setAttribute('aria-label', 'Folder ' + label);
        header.setAttribute('tabindex', '-1');
        header.dataset.kind = 'folder';
        header.dataset.id = 'folder:' + folderId;
        header.title = 'Enter to rename. Right-click for folder actions.';
        header.addEventListener('dblclick', () => beginRename(header, folderId, label));
        header.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openFolderMenu(e, header, folderId, label);
        });
      }
      attachDropTarget(header, folderId);
    }
    listEl.appendChild(header);

    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const row of visible) {
      group.appendChild(makeRow(row, depth));
    }
    if (droppable) {
      // The group is also a drop target so dropping anywhere in the folder's body
      // files into it; empty space within the group still resolves to the folder.
      attachDropTarget(group, folderId);
    }
    listEl.appendChild(group);
  }

  function renderEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'nest-empty';
    empty.textContent = message;
    listEl.appendChild(empty);
  }

  // The default render: cross-cutting sections then the folder hierarchy.
  function renderTree() {
    listEl.textContent = '';
    listEl.dataset.mode = 'tree';

    const total =
      sections.starred.length +
      sections.questions.length +
      sections.folders.reduce((n, f) => n + f.rows.length, 0);
    if (total === 0) {
      renderEmpty('No Claude Code chats found for this workspace yet.');
      return;
    }

    renderSection({
      key: 'starred',
      label: 'Starred',
      rows: sections.starred,
      depth: 0,
      droppable: false,
    });
    renderSection({
      key: 'questions',
      label: 'Questions',
      rows: sections.questions,
      depth: 0,
      droppable: false,
      heuristic: true,
    });
    for (const folder of sections.folders) {
      renderSection({
        key: 'folder:' + folder.folderId,
        label: folder.name,
        rows: folder.rows,
        depth: folder.depth,
        folderId: folder.folderId,
        color: folder.color,
        synthetic: folder.synthetic,
        droppable: true,
      });
    }
    restoreFocus();
  }

  // Content-search render: ranked rows in score order, no grouping.
  function renderSearch() {
    listEl.textContent = '';
    listEl.dataset.mode = 'search';
    if (searchPending) {
      renderEmpty('Searching...');
      return;
    }
    if (searchRows.length === 0) {
      renderEmpty('No chats match "' + searchQuery + '".');
      return;
    }
    const header = makeSectionHeader('Results', searchRows.length, {});
    listEl.appendChild(header);
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Search results');
    for (const r of searchRows) {
      group.appendChild(makeRow({ ...r, tags: [], tagIds: [], starred: false, awaitingReply: false }, 0));
    }
    listEl.appendChild(group);
    restoreFocus();
  }

  function render() {
    if (contentMode() && filterEl.value.trim().length > 0) {
      renderSearch();
    } else {
      renderTree();
    }
  }

  // ---- folder rename (in-place editor) ----

  function beginRename(headerEl, folderId, currentName) {
    if (headerEl.querySelector('.nest-rename-input')) {
      return;
    }
    const input = document.createElement('input');
    input.className = 'nest-rename-input';
    input.type = 'text';
    input.value = currentName;
    input.setAttribute('aria-label', 'Rename folder');
    const labelEl = headerEl.querySelector('.nest-section-label');
    if (labelEl) {
      labelEl.style.display = 'none';
      labelEl.parentNode.insertBefore(input, labelEl);
    } else {
      headerEl.appendChild(input);
    }
    input.focus();
    input.select();
    const commit = () => {
      const name = input.value.trim();
      cleanup();
      if (name.length > 0 && name !== currentName) {
        vscode.postMessage({ type: 'renameFolder', folderId, name });
      }
    };
    const cleanup = () => {
      input.remove();
      if (labelEl) {
        labelEl.style.display = '';
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        commit();
      } else if (e.key === 'Escape') {
        cleanup();
      }
    });
    input.addEventListener('blur', commit);
  }

  // Right-click a folder header to open the folder actions menu: Rename, Set
  // color, Clear color, Delete folder. A lightweight in-DOM menu (no native
  // context menu) positioned at the pointer; dismissed on outside click or Escape.
  let openMenuEl = null;
  function closeFolderMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
  }
  function openFolderMenu(e, headerEl, folderId, label) {
    closeFolderMenu();
    const menu = document.createElement('div');
    menu.className = 'nest-menu';
    menu.setAttribute('role', 'menu');
    const item = (text, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nest-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = text;
      b.addEventListener('click', () => {
        closeFolderMenu();
        fn();
      });
      menu.appendChild(b);
    };
    item('Rename', () => beginRename(headerEl, folderId, label));
    item('Set color', () => beginColor(folderId));
    item('Clear color', () => vscode.postMessage({ type: 'setFolderColor', folderId, color: null }));
    item('Delete folder', () => {
      // The host (deleteFolder command) shows the real modal confirmation; the
      // webview just requests it. Deleting a folder unfiles its chats (the store's
      // deleteFolder cascade), never deletes a chat.
      vscode.postMessage({ type: 'deleteFolder', folderId });
    });
    menu.style.left = (e.clientX || 0) + 'px';
    menu.style.top = (e.clientY || 0) + 'px';
    document.body.appendChild(menu);
    openMenuEl = menu;
  }
  document.addEventListener('click', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target)) {
      closeFolderMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFolderMenu();
    }
  });

  // Set a folder color via a hidden native color input so the panel needs no
  // custom color UI.
  function beginColor(folderId) {
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'nest-color-picker';
    document.body.appendChild(picker);
    picker.addEventListener('change', () => {
      vscode.postMessage({ type: 'setFolderColor', folderId, color: picker.value });
      picker.remove();
    });
    picker.addEventListener('blur', () => picker.remove());
    picker.click();
  }

  // ---- drag and drop (in-process) ----

  function onRowDragStart(e, sessionId) {
    // A drag of an unfocused row drags just that row; a drag of the focused row
    // drags it too. (Multi-select via keyboard is out of scope for this surface;
    // the drop message still carries an array so the reducer batches uniformly.)
    draggingChatIds = [sessionId];
    if (e.dataTransfer) {
      // Set a benign payload so the browser permits the drag; the real payload is
      // the in-process draggingChatIds. No cross-controller transfer is involved.
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', sessionId);
      } catch (err) {
        // Some hosts disallow setData; the in-process array still carries the drag.
      }
    }
  }

  function onDragEnd() {
    draggingChatIds = [];
    for (const el of listEl.querySelectorAll('.nest-drop-over')) {
      el.classList.remove('nest-drop-over');
    }
  }

  function attachDropTarget(el, folderId) {
    el.addEventListener('dragover', (e) => {
      if (draggingChatIds.length === 0) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      el.classList.add('nest-drop-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('nest-drop-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('nest-drop-over');
      if (draggingChatIds.length === 0) {
        return;
      }
      vscode.postMessage({
        type: 'drop',
        sourceChatIds: draggingChatIds.slice(),
        targetKind: 'folder',
        targetId: folderId,
      });
      draggingChatIds = [];
    });
  }

  // A tag chip is a drop target too: dropping chats on a chip tags them. Wired in
  // renderChips' loop indirectly; attach here to keep the DnD logic together.
  function attachChipDropTarget(el, tagId) {
    el.addEventListener('dragover', (e) => {
      if (draggingChatIds.length === 0) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      el.classList.add('nest-drop-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('nest-drop-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('nest-drop-over');
      if (draggingChatIds.length === 0) {
        return;
      }
      vscode.postMessage({
        type: 'drop',
        sourceChatIds: draggingChatIds.slice(),
        targetKind: 'tag',
        targetId: tagId,
      });
      draggingChatIds = [];
    });
  }

  // ---- keyboard navigation (roving tabindex over treeitems) ----

  function focusableRows() {
    return Array.prototype.slice.call(listEl.querySelectorAll('[role="treeitem"]'));
  }

  function activateRow(sessionId) {
    vscode.postMessage({ type: 'open', sessionId });
  }

  function moveFocus(delta) {
    const rows = focusableRows();
    if (rows.length === 0) {
      return;
    }
    let idx = rows.findIndex((r) => r === document.activeElement);
    if (idx === -1) {
      idx = rows.findIndex((r) => r.dataset.id === focusedId);
    }
    let next = idx === -1 ? 0 : idx + delta;
    if (next < 0) {
      next = 0;
    }
    if (next >= rows.length) {
      next = rows.length - 1;
    }
    setFocus(rows[next]);
  }

  function setFocus(el) {
    if (!el) {
      return;
    }
    for (const r of focusableRows()) {
      r.setAttribute('tabindex', '-1');
    }
    el.setAttribute('tabindex', '0');
    el.focus();
    focusedId = el.dataset.id || null;
  }

  function restoreFocus() {
    const rows = focusableRows();
    if (rows.length === 0) {
      return;
    }
    let target = null;
    if (focusedId) {
      target = rows.find((r) => r.dataset.id === focusedId) || null;
    }
    // Make exactly one row focusable (roving tabindex); do not steal focus on a
    // passive re-render, only mark the entry point.
    for (const r of rows) {
      r.setAttribute('tabindex', '-1');
    }
    (target || rows[0]).setAttribute('tabindex', '0');
  }

  listEl.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isRow = active && active.getAttribute && active.getAttribute('role') === 'treeitem';
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const rows = focusableRows();
      if (rows.length) {
        setFocus(rows[0]);
      }
    } else if (e.key === 'End') {
      e.preventDefault();
      const rows = focusableRows();
      if (rows.length) {
        setFocus(rows[rows.length - 1]);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && isRow) {
      e.preventDefault();
      if (active.dataset.kind === 'chat') {
        activateRow(active.dataset.id);
      } else if (active.dataset.kind === 'folder' && active.dataset.renameFolderId) {
        const labelEl = active.querySelector('.nest-section-label');
        beginRename(active, active.dataset.renameFolderId, labelEl ? labelEl.textContent : '');
      }
    }
  });

  // When the tree container itself gets focus (e.g. via Tab), forward focus to the
  // current roving entry point so arrow keys work immediately.
  listEl.addEventListener('focus', () => {
    const rows = focusableRows();
    const entry = rows.find((r) => r.getAttribute('tabindex') === '0') || rows[0];
    if (entry) {
      entry.focus();
    }
  });

  // ---- search input + controls ----

  function onFilterInput() {
    if (!contentMode()) {
      textFilter = filterEl.value.trim().toLowerCase();
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
      vscode.postMessage({ type: 'search', query });
    }, SEARCH_DEBOUNCE_MS);
  }

  function onModeChange() {
    // Switching modes clears the text filter context and re-runs the box.
    if (!contentMode()) {
      textFilter = filterEl.value.trim().toLowerCase();
    }
    onFilterInput();
  }

  // ---- inbound host messages ----

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    if (msg.type === 'sections' && msg.sections) {
      sections = msg.sections;
      // Drop any active tag filter whose tag no longer exists.
      const live = new Set((sections.tags || []).map((t) => t.tagId));
      for (const t of Array.from(activeTags)) {
        if (!live.has(t)) {
          activeTags.delete(t);
        }
      }
      renderChips();
      render();
    } else if (msg.type === 'searchResults' && Array.isArray(msg.rows)) {
      const current = filterEl.value.trim();
      if (!contentMode() || msg.query !== current) {
        return;
      }
      searchPending = false;
      searchRows = msg.rows;
      searchQuery = msg.query;
      render();
    } else if (msg.type === 'state') {
      sortMode = msg.sort || 'newest';
      densityMode = msg.density || 'comfortable';
      if (sortEl) {
        sortEl.value = sortMode;
      }
      if (densityEl) {
        densityEl.value = densityMode;
      }
      document.body.dataset.density = densityMode;
      render();
    }
  });

  // ---- relative time (mirrors src/views/relativeTime.ts buckets, webview-local) ----

  function relative(ts) {
    if (ts === null || ts === undefined) {
      return 'no timestamp';
    }
    const diff = Date.now() - ts;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) {
      return 'just now';
    }
    if (diff < hour) {
      return Math.floor(diff / min) + 'm ago';
    }
    if (diff < day) {
      return Math.floor(diff / hour) + 'h ago';
    }
    if (diff < 30 * day) {
      return Math.floor(diff / day) + 'd ago';
    }
    return new Date(ts).toLocaleDateString();
  }

  filterEl.addEventListener('input', onFilterInput);
  if (contentModeEl) {
    contentModeEl.addEventListener('change', onModeChange);
  }
  refreshEl.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      sortMode = sortEl.value;
      vscode.postMessage({ type: 'setState', sort: sortMode });
      render();
    });
  }
  if (densityEl) {
    densityEl.addEventListener('change', () => {
      densityMode = densityEl.value;
      document.body.dataset.density = densityMode;
      vscode.postMessage({ type: 'setState', density: densityMode });
      render();
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
