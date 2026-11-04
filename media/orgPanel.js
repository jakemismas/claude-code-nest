// Sidebar webview script: renders the host-built section model as an ARIA tree with tag chips,
// sort, search, folder tools, drag and drop, Settings and Archive overlays, the fleet layout and
// the robin header. Keyboard use runs through a roving tabindex and every control has an aria-label.
(function () {
  const vscode = acquireVsCodeApi();

  // The 8-color palette for tags and folders. Chosen values are re-validated at the host boundary
  // (isValidColor) before they reach a style sink.
  const HANDOFF_PALETTE = [
    '#d97757',
    '#c6613f',
    '#B14F36',
    '#9A6B1E',
    '#5E7148',
    '#3F7572',
    '#4F6582',
    '#7B5C82',
  ];

  const listEl = document.getElementById('list');
  const chipsEl = document.getElementById('chips');
  const filterEl = document.getElementById('filter');
  const searchClearEl = document.getElementById('searchClear');
  const newSessionEl = document.getElementById('newSession');
  const settingsEl = document.getElementById('settings');
  const sortBtnEl = document.getElementById('sortBtn');
  const sortPopoverEl = document.getElementById('sortPopover');

  // Latest host-posted section model. allTags is the full tag list (zero-chat tags included),
  // unlike the filter chips, so the chat menu can toggle any tag.
  let sections = { starred: [], questions: [], folders: [], tags: [], allTags: [], archivedCount: 0 };
  // The set of active tag-id filters (AND across selected chips: a row must carry
  // every selected tag to show).
  const activeTags = new Set();
  // Normalized text filter (trimmed, lowercased). Matching happens on the host; the client posts
  // the query and renders the reply.
  let textFilter = '';

  // Host search hits for the current query (snippets by sessionId, ranked ids). Hits count only when
  // searchResultsQuery equals textFilter, because the host replies twice and keystrokes interleave.
  let searchHitSnippets = new Map();
  let searchHitOrder = [];
  let searchResultsQuery = null;

  // The debounce timer for the outbound { type:'search' } post. Cleared and re-armed on
  // each keystroke.
  let searchDebounceTimer = null;
  const SEARCH_DEBOUNCE_MS = 140;

  // Sort, hydrated from the host's persisted state on 'state'.
  let sortMode = 'newest';

  // Collapsed folder ids, seeded from persisted state and posted back on change. Collapsed subtrees
  // stay out of the DOM so hidden rows cannot take the roving tabindex.
  const collapsedFolders = new Set();

  // The dragged chat ids for an in-flight in-panel drag (fully in-process; the drop
  // posts these straight to the host). Cleared on dragend.
  let draggingChatIds = [];

  // SessionId of the open chat (best-effort tab-label match from the host). Only its row is tinted.
  let activeId = null;

  // The roving-tabindex focus target: the dataset.id of the row that holds the
  // single tabindex="0". Kept stable across re-renders by id when possible.
  let focusedId = null;

  // ---- Settings overlay ----

  // Auto-archive window in days (0 = Never), hydrated from the host 'settings' message.
  let autoArchiveWindowDays = 30;
  // The per-workspace "Group chats by" choice ('auto' when no override) and the robin
  // animations setting, both hydrated from the host 'settings' message.
  let groupByOverride = 'auto';
  let robinAnimationsOn = true;
  // The Organize section: the last report the host posted for the layout file's rules.
  // moves is the Preview list; Apply and Undo are enabled from it.
  let organizeState = {
    kind: 'idle',
    message: '',
    moves: [],
    moreMoves: 0,
    matched: 0,
    skippedHandFiled: 0,
    rulesActive: 0,
    problems: [],
    canUndo: false,
    undoCount: 0,
    skippedOnUndo: 0,
  };
  let organizeBusy = false;
  const GROUP_BY_OPTIONS = [
    { mode: 'auto', label: 'Auto' },
    { mode: 'tickets', label: 'Tickets' },
    { mode: 'folders', label: 'Folders' },
    { mode: 'date', label: 'Date' },
  ];
  const AUTO_ARCHIVE_OPTIONS = [
    { days: 7, label: '7 days' },
    { days: 14, label: '14 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: '1 year' },
    { days: 0, label: 'Never archive' },
  ];

  // Section toggles (all on by default). They gate rendering only; search and chips still reach every chat.
  const sectionsVisible = { starred: true, questions: true, folders: true, unsorted: true };

  // Settings overlay element, or null when closed. It stays open until the back chevron or Escape,
  // so it sits outside closeAllTransientOverlays.
  let settingsOverlayEl = null;
  let settingsReturnFocusEl = null;

  // ---- Archive overlay ----

  // Archived rows posted by the host while the overlay is open. The archive search filters them by
  // title on the client; the host search index excludes archived chats.
  let archivedRows = [];
  // Archive overlay element, or null when closed. Persistent like Settings, so closeAllTransientOverlays
  // skips it.
  let archiveOverlayEl = null;
  let archiveReturnFocusEl = null;
  // The current archive-search text (normalized: trimmed + lowercased), client-side only.
  let archiveSearchText = '';

  // Converts #rrggbb to rgba at the given alpha. CSS color-mix needs Chromium 111 and the minimum
  // VS Code ships Chromium 98. Returns null for a non-matching value.
  function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string') {
      return null;
    }
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) {
      return null;
    }
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
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
        if (active) {
          // Active chip: color @15% background, color @45% border, computed as rgba so no
          // CSS color-mix is needed.
          const bg = hexToRgba(chip.color, 0.15);
          const border = hexToRgba(chip.color, 0.45);
          if (bg) {
            el.style.background = bg;
          }
          if (border) {
            el.style.borderColor = border;
          }
        }
      }
      const dot = document.createElement('span');
      dot.className = 'nest-chip-dot';
      dot.setAttribute('aria-hidden', 'true');
      el.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = chip.label;
      el.appendChild(label);
      el.setAttribute('aria-label', 'Filter by tag ' + chip.label + ' (' + chip.count + ')');
      el.addEventListener('click', () => {
        if (activeTags.has(chip.tagId)) {
          activeTags.delete(chip.tagId);
        } else {
          activeTags.add(chip.tagId);
        }
        renderChips();
        render();
      });
      // A chip is also a DROP TARGET: dropping chats on it tags them (the host maps
      // a 'tag' drop to the reducer's tag-add).
      attachChipDropTarget(el, chip.tagId);
      chipsEl.appendChild(el);
    }
  }

  // ---- row matching (tag filter, client-side) ----

  // Tag AND-filter only: a row must carry every selected tag. Text matching is host-side (searchHit*).
  function rowMatches(row) {
    if (activeTags.size > 0) {
      const ids = row.tagIds || [];
      for (const t of activeTags) {
        if (ids.indexOf(t) === -1) {
          return false;
        }
      }
    }
    return true;
  }

  // Whether any tag chip or text filter is active. When filtering, the sectioned list is
  // replaced by a flat "N RESULTS" list.
  function isFiltering() {
    return activeTags.size > 0 || textFilter.length > 0;
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

  // Builds one chat row. A row activates on single click, Enter or Space (double-click is for folder rename).
  // opts.showSnippet and opts.showBreadcrumb add the search snippet and the folder path.
  function makeRow(row, depth, opts) {
    const el = document.createElement('div');
    el.className = 'nest-row';
    // Only the open chat's row is tinted; starred rows are not.
    if (activeId && row.sessionId === activeId) {
      el.classList.add('nest-active');
    }
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-label', rowAriaLabel(row));
    el.setAttribute('tabindex', '-1');
    el.dataset.kind = 'chat';
    el.dataset.id = row.sessionId;
    // Depth indents: top-level 11px, subfolder child 29px, deeper 47px. Base 11 keeps the
    // row's status glyph aligned across rows.
    el.style.paddingLeft = 11 + depth * 18 + 'px';
    el.draggable = true;

    const main = document.createElement('div');
    main.className = 'nest-row-main';

    // The status slot is always present, even when empty, so titles align. The aria-label carries the meaning.
    const status = document.createElement('span');
    status.className = 'nest-status';
    status.setAttribute('aria-hidden', 'true');
    if (row.status === 'question') {
      const q = document.createElement('span');
      q.className = 'nest-status-question';
      q.textContent = '?';
      status.appendChild(q);
    } else if (row.status === 'done') {
      const d = document.createElement('span');
      d.className = 'nest-status-dot';
      status.appendChild(d);
    }
    main.appendChild(status);

    const titleText = document.createElement('span');
    titleText.className = 'nest-row-title-text';
    titleText.textContent = row.title;
    main.appendChild(titleText);

    // Folder breadcrumb right of the title, for filed chats in Questions and search results.
    if (opts && opts.showBreadcrumb && row.breadcrumb) {
      const crumb = document.createElement('span');
      crumb.className = 'nest-row-breadcrumb';
      crumb.textContent = row.breadcrumb;
      main.appendChild(crumb);
    }

    if (row.tags && row.tags.length > 0) {
      // A clip box holds a strip of pills so extra tags clip on one line instead of squeezing the title.
      // The separate strip node lets the marquee animate without touching the pills.
      const tagRow = document.createElement('span');
      tagRow.className = 'nest-row-tags';
      const tagStrip = document.createElement('span');
      tagStrip.className = 'nest-row-tags-strip';
      for (let i = 0; i < row.tags.length; i++) {
        const t = document.createElement('span');
        t.className = 'nest-tag';
        const tagColor = row.tagColors && row.tagColors[i];
        if (tagColor) {
          t.style.setProperty('--tag-color', tagColor);
          // 15% rgba tag background (no color-mix).
          const bg = hexToRgba(tagColor, 0.15);
          if (bg) {
            t.style.background = bg;
          }
        }
        t.textContent = row.tags[i];
        tagStrip.appendChild(t);
      }
      tagRow.appendChild(tagStrip);
      main.appendChild(tagRow);
    }

    // Add-tag control, shown on hover or focus. It opens the chat menu under the control. It is a button
    // so it is focusable and its click does not bubble to the row.
    const addTag = document.createElement('button');
    addTag.type = 'button';
    addTag.className = 'nest-tag-add';
    addTag.setAttribute('aria-label', 'Add tag to ' + row.title);
    addTag.setAttribute('aria-haspopup', 'menu');
    addTag.title = 'Add tag';
    addTag.textContent = '+';
    addTag.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = addTag.getBoundingClientRect();
      openChatMenu({ clientX: r.left, clientY: r.bottom + 4 }, row.sessionId);
    });
    main.appendChild(addTag);

    const time = document.createElement('span');
    time.className = 'nest-row-time';
    time.textContent = relative(row.timestamp);
    main.appendChild(time);

    // Star toggle, persisted through the store. A button so it is focusable and labelled; its click
    // does not bubble to the row.
    const star = document.createElement('button');
    star.type = 'button';
    star.className = row.starred ? 'nest-star' : 'nest-star nest-star-empty';
    star.setAttribute('aria-label', row.starred ? 'Unstar chat' : 'Star chat');
    star.setAttribute('aria-pressed', row.starred ? 'true' : 'false');
    star.textContent = row.starred ? '★' : '☆';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'toggleStar', sessionId: row.sessionId, starred: !row.starred });
    });
    main.appendChild(star);

    el.appendChild(main);

    if (opts && opts.showSnippet && row.snippet) {
      const snip = document.createElement('div');
      snip.className = 'nest-row-snippet';
      snip.textContent = row.snippet;
      el.appendChild(snip);
    }

    el.addEventListener('click', () => activateRow(row.sessionId));
    // Right-click opens the chat menu. The menu resolves the live row by sessionId on open, since a
    // refresh may replace this row object.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatMenu(e, row.sessionId);
    });
    el.addEventListener('dragstart', (e) => onRowDragStart(e, row.sessionId));
    el.addEventListener('dragend', onDragEnd);
    return el;
  }

  function rowAriaLabel(row) {
    let label = row.title;
    if (row.starred) {
      label = 'Starred. ' + label;
    }
    if (row.status === 'question') {
      label = label + '. Has a question awaiting you.';
    } else if (row.status === 'done') {
      label = label + '. Unread reply.';
    }
    if (row.awaitingReply) {
      label = label + '. Awaiting your reply (heuristic).';
    }
    return label;
  }

  // Header for Starred or Questions: a bare muted label with no count or badge, like FOLDERS and UNSORTED.
  function makeSectionHeader(text) {
    const header = document.createElement('div');
    header.className = 'nest-section-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'nest-section-label';
    labelEl.textContent = text;
    header.appendChild(labelEl);
    return header;
  }

  // Renders a flat section (Starred or Questions); hidden when it has no visible rows.
  function renderCrossCuttingSection(label, rows, opts) {
    const visible = sortRows(rows.filter(rowMatches));
    if (visible.length === 0) {
      return;
    }
    listEl.appendChild(makeSectionHeader(label));
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const row of visible) {
      group.appendChild(makeRow(row, 0, opts));
    }
    listEl.appendChild(group);
  }

  // Renders one folder section: a header plus a role=group of rows, and a drop target (Unsorted unfiles).
  // Real folders rename on double-click, recolor on right-click and collapse; Unsorted is a plain label.
  function renderFolderSection(folder) {
    const { folderId, name, depth, synthetic } = folder;
    const visible = sortRows((folder.rows || []).filter(rowMatches));
    const collapsed = !synthetic && collapsedFolders.has(folderId);

    if (synthetic) {
      // UNSORTED: a plain uppercase section label that is also a drop target.
      const header = document.createElement('div');
      header.className = 'nest-unsorted-header';
      header.textContent = name;
      if (!folder.auto) {
        header.dataset.dropFolderId = folderId;
        attachDropTarget(header, folderId);
      }
      listEl.appendChild(header);
    } else {
      // The header count is the model's rolled-up count (folder plus subfolders), because headers show only in
      // the unfiltered tree. Falls back to the visible count when the host omits it.
      const count =
        typeof folder.rolledUpCount === 'number' ? folder.rolledUpCount : visible.length;
      const header = makeFolderHeader(folder, collapsed, count);
      listEl.appendChild(header);
      if (collapsed) {
        return;
      }
    }

    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    // Real folders nest chats one level under the header. The Unsorted bucket has no header, so its rows
    // render at depth 0 to align with Starred and Questions.
    const rowDepth = synthetic ? depth : depth + 1;
    for (const row of visible) {
      const rowEl = makeRow(row, rowDepth);
      rowEl.dataset.parentFolderId = folderId;
      group.appendChild(rowEl);
    }
    if (!folder.auto) {
      attachDropTarget(group, folderId);
    }
    listEl.appendChild(group);
  }

  // A real folder header: chevron, folder glyph, name, count. Enter or Space opens rename, double-click
  // renames, right-click opens the menu and the chevron collapses.
  function makeFolderHeader(folder, collapsed, count) {
    const { folderId, name, color, depth } = folder;
    const header = document.createElement('div');
    header.className = 'nest-folder-row';
    // Depth indents match the chat rows: top-level 11px, subfolder 29px.
    header.style.paddingLeft = 11 + depth * 18 + 'px';
    header.dataset.dropFolderId = folderId;
    header.dataset.renameFolderId = folderId;
    header.dataset.kind = 'folder';
    header.dataset.id = 'folder:' + folderId;
    header.dataset.folderDepth = String(depth);
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-level', String(depth + 1));
    header.setAttribute('aria-label', 'Folder ' + name);
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    header.setAttribute('tabindex', '-1');
    header.title = 'Enter to rename. Right-click for folder actions.';

    const chevron = document.createElement('span');
    chevron.className = 'nest-folder-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.classList.toggle('is-open', !collapsed);
    chevron.appendChild(svgEl(12, 12, 'nest-fleet-chev', ['M4 2.5 7.5 6 4 9.5']));
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      // The chevron toggles at once; cancel any armed row toggle so it does not fire a second time.
      cancelPendingFolderToggle();
      toggleCollapse(folderId);
    });
    header.appendChild(chevron);

    header.appendChild(folderGlyph(color || '#C2A56E'));

    const nameEl = document.createElement('span');
    nameEl.className = 'nest-folder-name';
    nameEl.textContent = name;
    header.appendChild(nameEl);

    const countEl = document.createElement('span');
    countEl.className = 'nest-folder-count';
    countEl.textContent = String(count);
    header.appendChild(countEl);

    // A plain header click also collapses, deferred by a double-click window (onFolderRowClick). Toggling at
    // once would re-render and detach this header before dblclick could open rename.
    header.addEventListener('click', () => onFolderRowClick(folderId));
    header.addEventListener('dblclick', () => {
      cancelPendingFolderToggle();
      beginRename(header, folderId, name);
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openFolderMenu(e, header, folderId, name, color || null);
    });
    attachDropTarget(header, folderId);
    return header;
  }

  // Colored folder glyph (fill = folder color).
  function folderGlyph(color) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', color);
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('nest-folder-glyph');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute(
      'd',
      'M1.4 4.1c0-.66.54-1.2 1.2-1.2h3.05c.4 0 .77.19 1 .52l.5.7c.23.33.6.52 1 .52h4.45c.66 0 1.2.54 1.2 1.2v6.35c0 .66-.54 1.2-1.2 1.2H2.6c-.66 0-1.2-.54-1.2-1.2z',
    );
    svg.appendChild(path);
    return svg;
  }

  // The archive-box SVG glyph for the bottom Archived row.
  function archiveGlyph() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('aria-hidden', 'true');
    const parts = [
      ['rect', { x: '2', y: '3', width: '12', height: '3', rx: '0.6' }],
      ['path', { d: 'M3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6' }],
      ['line', { x1: '6.5', y1: '9', x2: '9.5', y2: '9', 'stroke-linecap': 'round' }],
    ];
    for (const [tag, attrs] of parts) {
      const node = document.createElementNS(NS, tag);
      for (const k of Object.keys(attrs)) {
        node.setAttribute(k, attrs[k]);
      }
      svg.appendChild(node);
    }
    return svg;
  }

  // The FOLDERS section header with the + (new folder) and ^ (collapse one level)
  // buttons.
  function renderFoldersHeader() {
    const header = document.createElement('div');
    header.className = 'nest-folders-header';
    const label = document.createElement('span');
    label.className = 'nest-section-label';
    label.textContent = 'FOLDERS';
    header.appendChild(label);

    const addBtn = document.createElement('button');
    addBtn.className = 'nest-mini-btn';
    addBtn.type = 'button';
    addBtn.title = 'New folder';
    addBtn.setAttribute('aria-label', 'New folder');
    addBtn.setAttribute('aria-haspopup', 'dialog');
    addBtn.textContent = '＋';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNewFolderPopover(addBtn);
    });
    header.appendChild(addBtn);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'nest-mini-btn nest-mini-caret';
    collapseBtn.type = 'button';
    collapseBtn.title = 'Collapse one level';
    collapseBtn.setAttribute('aria-label', 'Collapse one folder level');
    collapseBtn.textContent = '⌃';
    collapseBtn.addEventListener('click', collapseDeepestOpenLevel);
    header.appendChild(collapseBtn);

    listEl.appendChild(header);
  }

  // Bottom Archived (N) row, shown only when a chat is archived. Opens the Archive overlay.
  function renderArchivedRow() {
    if (!sections.archivedCount || sections.archivedCount <= 0) {
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'nest-archived-row';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Archived, ' + sections.archivedCount + ' chats');
    const icon = document.createElement('span');
    icon.className = 'nest-archived-icon';
    icon.appendChild(archiveGlyph());
    btn.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'nest-archived-label';
    label.textContent = 'Archived';
    btn.appendChild(label);
    const count = document.createElement('span');
    count.className = 'nest-archived-count';
    count.textContent = String(sections.archivedCount);
    btn.appendChild(count);
    btn.addEventListener('click', () => {
      // Remember the trigger so closing restores focus here; the row is re-created per render, so close
      // resolves it by class. The host answers with an 'archivedRows' post.
      archiveReturnFocusEl = btn;
      vscode.postMessage({ type: 'openArchive' });
    });
    listEl.appendChild(btn);
  }

  function renderEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'nest-empty';
    empty.textContent = message;
    listEl.appendChild(empty);
  }

  // The default render: cross-cutting sections then the folder hierarchy, plus the
  // Archived row. When a filter is active, a flat "N RESULTS" list replaces the sectioned
  // view.
  function render() {
    // render() is the only place that clears listEl, so teardown lives here: commit an in-progress rename
    // (a removed focused input fires no blur), drop an armed folder toggle, then close the transient
    // overlays. Committing first keeps a rename begun from the folder menu.
    commitPendingRename();
    cancelPendingFolderToggle();
    closeAllTransientOverlays();
    listEl.textContent = '';
    listEl.dataset.mode = 'tree';

    if (isFiltering()) {
      renderFiltered();
      restoreFocus();
      armTagMarquee();
      return;
    }

    const total =
      sections.starred.length +
      sections.questions.length +
      sections.folders.reduce((n, f) => n + f.rows.length, 0);
    if (total === 0 && (!sections.archivedCount || sections.archivedCount <= 0) && !fleetHasContent()) {
      renderEmpty('No Claude Code chats found for this workspace yet.');
      return;
    }

    // The Active projection shows only the fleet groups with live work.
    if (fleet && fleet.active) {
      renderFleetLayout();
      restoreFocus();
      return;
    }

    // Toggles hide only rendering; the model, search and chips still reach every chat, so Unsorted off
    // never strands an unfiled chat. Starred and Questions also hide when empty.
    if (sectionsVisible.starred) {
      renderCrossCuttingSection('Starred', sections.starred);
    }
    if (sectionsVisible.questions) {
      renderCrossCuttingSection('Questions', sections.questions, { showBreadcrumb: true });
    }

    if (fleet) {
      renderFleetLayout();
    }
    renderFolderTree();

    renderArchivedRow();
    restoreFocus();
    armTagMarquee();
  }

  // Arms the slow marquee on tag strips that overflow their clip box. Runs after a render commits (layout
  // must exist to measure) and on resize; hover pause and reduced motion are handled in CSS.
  let tagMarqueePending = false;
  function armTagMarquee() {
    if (tagMarqueePending) {
      return;
    }
    tagMarqueePending = true;
    requestAnimationFrame(function () {
      tagMarqueePending = false;
      var boxes = listEl.querySelectorAll('.nest-row-tags');
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        var strip = box.firstElementChild;
        if (!strip) {
          continue;
        }
        var overflow = strip.scrollWidth - box.clientWidth;
        // A few px of slack: sub-pixel rounding must not start a marquee that
        // travels nowhere.
        if (overflow > 4) {
          box.classList.add('nest-tags-overflow');
          box.style.setProperty('--tag-scroll', -overflow + 'px');
          // Slow travel (~25px/s each way) with an 8s floor so even a small
          // overflow reads as a gentle drift, not a ticker.
          var secs = Math.max(8, Math.round((overflow / 25) * 2) + 4);
          box.style.setProperty('--tag-scroll-duration', secs + 's');
        } else {
          box.classList.remove('nest-tags-overflow');
          box.style.removeProperty('--tag-scroll');
          box.style.removeProperty('--tag-scroll-duration');
        }
      }
    });
  }

  // The sidebar is user-resizable: a wider panel can absorb an overflow (stop the
  // marquee) and a narrower one can create it, so re-measure on resize.
  window.addEventListener('resize', armTagMarquee);

  // Renders the FOLDERS header and the folder tree, honoring the Folders and Unsorted toggles.
  function renderFolderTree() {
    const showFolders = sectionsVisible.folders;
    const showUnsorted = sectionsVisible.unsorted;
    // The FOLDERS header follows the Folders toggle; with only Unsorted on, the bucket still renders below it.
    if (showFolders) {
      renderFoldersHeader();
    }
    // The folders array is a pre-order flattening. A collapsed folder skips following entries deeper than its
    // treeDepth, the true depth (two legacy folders can share a clamped render depth). Falls back to the
    // clamped depth for an older host.
    const depthOf = (f) => (typeof f.treeDepth === 'number' ? f.treeDepth : f.depth);
    let hideDeeperThan = Infinity;
    for (const folder of sections.folders) {
      // The Unsorted toggle gates the synthetic bucket and the Folders toggle gates real folders; a skipped
      // folder adds nothing to the collapse bookkeeping.
      if (folder.synthetic) {
        // The fleet layout draws computed groups and Unsorted itself.
        if (fleet) {
          continue;
        }
        // Computed groups (auto) are not the Unsorted bucket and stay visible.
        if (folder.auto || showUnsorted) {
          renderFolderSection(folder);
        }
        continue;
      }
      if (!showFolders) {
        continue;
      }
      const d = depthOf(folder);
      if (d <= hideDeeperThan) {
        hideDeeperThan = Infinity;
      }
      if (d > hideDeeperThan) {
        continue;
      }
      renderFolderSection(folder);
      if (collapsedFolders.has(folder.folderId)) {
        hideDeeperThan = d;
      }
    }
  }

  // Builds a sessionId -> row lookup across all sections (first seen wins). A chat can sit in several
  // sections; one row carries its tags, status, breadcrumb and star for resolving a host hit.
  function rowsBySessionId() {
    const map = new Map();
    const add = (rows) => {
      for (const row of rows || []) {
        if (!map.has(row.sessionId)) {
          map.set(row.sessionId, row);
        }
      }
    };
    add(sections.starred);
    add(sections.questions);
    for (const folder of sections.folders) {
      add(folder.rows);
    }
    return map;
  }

  // Mirrors normalizeQuery in src/views/orgPanelInteractions.ts (trim, lowercase) so an echoed host reply
  // compares equal to textFilter. The parity test pins the name.
  function normalizeQuery(raw) {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  }

  // Mirrors isFreshSearchReply: a reply counts only when it matches the current non-empty textFilter.
  function isFreshSearchReply(replyQuery, currentTextFilter) {
    if (currentTextFilter.length === 0) {
      return false;
    }
    return normalizeQuery(replyQuery) === currentTextFilter;
  }

  // Whether the host results match the current text query; a late reply for an earlier keystroke is not trusted.
  function haveFreshTextResults() {
    return isFreshSearchReply(searchResultsQuery, textFilter);
  }

  // Mirrors joinTextHits: intersect host-ranked ids with the tag filter, dedupe, collect snippets, then
  // apply the panel sort. Returns { rows, snippets }.
  function joinTextHits(order, snippetOf, rowOf, matches, sort) {
    const seen = new Set();
    const rows = [];
    const snippets = new Map();
    for (const sessionId of order) {
      if (seen.has(sessionId)) {
        continue;
      }
      const row = rowOf(sessionId);
      if (!row || !matches(row)) {
        continue;
      }
      seen.add(sessionId);
      rows.push(row);
      const snip = snippetOf(sessionId);
      if (typeof snip === 'string' && snip.length > 0) {
        snippets.set(sessionId, snip);
      }
    }
    return { rows: sort(rows), snippets };
  }

  // Flat filtered view: an "N RESULTS" label, then matching rows with snippet and breadcrumb. With text, the
  // result is the host hit ids intersected with the tag AND-filter (the snippet is null on a title match).
  // Tag-only filtering stays on the client. The Archived (N) row renders here too.
  function renderFiltered() {
    const withText = textFilter.length > 0;
    let visible = [];
    // rowSnippets carries the per-row snippet to show (host snippet on a text
    // match). Keyed by sessionId; absent -> no snippet row.
    const rowSnippets = new Map();

    if (withText) {
      // Host rank decides membership and the sort control decides order (joinTextHits). Only a fresh host
      // reply is joined; a stale or absent one gives an empty set.
      if (haveFreshTextResults()) {
        const byId = rowsBySessionId();
        const joined = joinTextHits(
          searchHitOrder,
          (id) => searchHitSnippets.get(id),
          (id) => byId.get(id),
          rowMatches,
          sortRows,
        );
        visible = joined.rows;
        joined.snippets.forEach((snip, id) => rowSnippets.set(id, snip));
      }
    } else {
      // Tag-only flat view: client-side, no host round-trip.
      const seen = new Set();
      const collect = (rows) => {
        for (const row of rows || []) {
          if (seen.has(row.sessionId)) {
            continue;
          }
          if (rowMatches(row)) {
            seen.add(row.sessionId);
            visible.push(row);
          }
        }
      };
      collect(sections.starred);
      collect(sections.questions);
      for (const folder of sections.folders) {
        collect(folder.rows);
      }
      visible = sortRows(visible);
    }

    const header = document.createElement('div');
    header.className = 'nest-section-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'nest-section-label';
    labelEl.textContent = visible.length + (visible.length === 1 ? ' RESULT' : ' RESULTS');
    header.appendChild(labelEl);
    listEl.appendChild(header);

    if (visible.length === 0) {
      renderEmpty('No chats match your search.');
    } else {
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Filter results');
      for (const row of visible) {
        const snip = rowSnippets.get(row.sessionId);
        // A body-match snippet overrides the row summary. A shallow copy keeps the section row unmutated.
        const rowForRender = snip ? Object.assign({}, row, { snippet: snip }) : row;
        group.appendChild(
          makeRow(rowForRender, 0, { showSnippet: !!snip, showBreadcrumb: true }),
        );
      }
      listEl.appendChild(group);
    }

    // The Archived (N) row is present in the filtered view too.
    renderArchivedRow();
  }



  // ---- collapse / expand ----

  function persistCollapsed() {
    vscode.postMessage({ type: 'setState', collapsedFolders: Array.from(collapsedFolders).sort() });
  }

  function toggleCollapse(folderId) {
    setCollapsed(folderId, !collapsedFolders.has(folderId));
  }

  function setCollapsed(folderId, collapsed) {
    const had = collapsedFolders.has(folderId);
    if (collapsed === had) {
      return;
    }
    if (collapsed) {
      collapsedFolders.add(folderId);
    } else {
      collapsedFolders.delete(folderId);
    }
    focusedId = 'folder:' + folderId;
    persistCollapsed();
    render();
    refocusById('folder:' + folderId);
  }

  // True structural depth (treeDepth, or the clamped depth for an older host). Collapse bookkeeping needs
  // it because legacy folders can share a clamped depth.
  function treeDepthOf(folder) {
    return typeof folder.treeDepth === 'number' ? folder.treeDepth : folder.depth;
  }

  // Whether the folder at index i has a descendant folder: pre-order puts its first descendant next.
  function folderHasChild(i) {
    const here = sections.folders[i];
    const next = sections.folders[i + 1];
    return !!(next && treeDepthOf(next) > treeDepthOf(here));
  }

  // The ^ button: collapse the deepest open visible tier; once all are folded, the next click re-expands
  // all. Mirrors foldOneLevel.
  function collapseDeepestOpenLevel() {
    if (isFiltering()) {
      return;
    }
    const hidden = computeHiddenFolders();
    let hasRealFolder = false;
    let deepest = -1;
    for (let i = 0; i < sections.folders.length; i++) {
      const f = sections.folders[i];
      if (f.synthetic) {
        continue;
      }
      hasRealFolder = true;
      const d = treeDepthOf(f);
      if (!hidden[i] && !collapsedFolders.has(f.folderId) && folderHasChild(i) && d > deepest) {
        deepest = d;
      }
    }
    if (deepest < 0) {
      // Nothing collapsible: all folders are folded, so re-expand by clearing the set (only when it holds ids).
      if (hasRealFolder && collapsedFolders.size > 0) {
        collapsedFolders.clear();
        persistCollapsed();
        render();
      }
      return;
    }
    let changed = false;
    for (let i = 0; i < sections.folders.length; i++) {
      const f = sections.folders[i];
      if (f.synthetic) {
        continue;
      }
      if (
        !hidden[i] &&
        !collapsedFolders.has(f.folderId) &&
        folderHasChild(i) &&
        treeDepthOf(f) === deepest
      ) {
        collapsedFolders.add(f.folderId);
        changed = true;
      }
    }
    if (changed) {
      persistCollapsed();
      render();
    }
  }

  function computeHiddenFolders() {
    const hidden = new Array(sections.folders.length).fill(false);
    let hideDeeperThan = Infinity;
    for (let i = 0; i < sections.folders.length; i++) {
      const f = sections.folders[i];
      const d = treeDepthOf(f);
      if (d <= hideDeeperThan) {
        hideDeeperThan = Infinity;
      }
      if (d > hideDeeperThan) {
        hidden[i] = true;
        continue;
      }
      if (!f.synthetic && collapsedFolders.has(f.folderId)) {
        hideDeeperThan = d;
      }
    }
    return hidden;
  }

  // ---- keyboard tree helpers (ArrowLeft/Right parent/child resolution) ----

  function parentFolderHeaderOf(el) {
    const rows = focusableRows();
    const idx = rows.indexOf(el);
    if (idx <= 0) {
      return null;
    }
    const level = rowLevel(el);
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = rows[i];
      if (candidate.dataset.kind === 'folder' && rowLevel(candidate) < level) {
        return candidate;
      }
    }
    return null;
  }

  function parentFolderHeaderById(folderId) {
    if (!folderId) {
      return null;
    }
    const rows = focusableRows();
    return rows.find((r) => r.dataset.kind === 'folder' && r.dataset.id === 'folder:' + folderId) || null;
  }

  function rowLevel(el) {
    const attr = el.getAttribute && el.getAttribute('aria-level');
    if (attr) {
      return parseInt(attr, 10);
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function folderIdOf(el) {
    if (el && el.dataset && el.dataset.kind === 'folder' && el.dataset.renameFolderId) {
      return el.dataset.renameFolderId;
    }
    return null;
  }

  function moveToFirstChild(folderHeader) {
    const rows = focusableRows();
    const idx = rows.indexOf(folderHeader);
    if (idx === -1 || idx + 1 >= rows.length) {
      return;
    }
    const next = rows[idx + 1];
    if (rowLevel(next) > rowLevel(folderHeader)) {
      setFocus(next);
    }
  }

  function refocusById(id) {
    const rows = focusableRows();
    const target = rows.find((r) => r.dataset.id === id);
    if (target) {
      setFocus(target);
    }
  }

  // ---- folder rename (in-place editor) ----

  // The in-flight rename ({ commit }, or null). render() commits it first because removing a focused input
  // does not reliably fire blur.
  let pendingRename = null;

  function commitPendingRename() {
    if (pendingRename) {
      const p = pendingRename;
      pendingRename = null;
      p.commit();
    }
  }

  // Single versus double click on a folder row. A toggle re-renders and detaches the node dblclick needs,
  // so it is deferred by a double-click window and cancelled by a second click. Mirrors orgPanelInteractions.ts
  // (DOUBLE_CLICK_MS): lastFolderClickAt stamps the arm, folderToggleTimer holds it, folderToggleArmedId is
  // its target, so a click on another folder cancels the stale arm.
  const DOUBLE_CLICK_MS = 250;
  let lastFolderClickAt = null;
  let folderToggleTimer = null;
  let folderToggleArmedId = null;

  function cancelPendingFolderToggle() {
    if (folderToggleTimer !== null) {
      clearTimeout(folderToggleTimer);
      folderToggleTimer = null;
    }
    folderToggleArmedId = null;
    lastFolderClickAt = null;
  }

  // A folder-row click: arm a deferred collapse toggle, or cancel it when it is the
  // second click of a fast pair (the imminent dblclick owns the interaction) or when
  // it targets a different folder than a currently-armed toggle.
  function onFolderRowClick(folderId) {
    const now = Date.now();
    const pairWindowOpen = lastFolderClickAt !== null && now - lastFolderClickAt < DOUBLE_CLICK_MS;
    // A fast second click on the SAME folder is a double-click in progress: cancel
    // the armed toggle and let dblclick handle it. A click on a different folder
    // just cancels the stale arm and arms afresh below.
    if (pairWindowOpen && folderToggleArmedId === folderId) {
      cancelPendingFolderToggle();
      return;
    }
    cancelPendingFolderToggle();
    lastFolderClickAt = now;
    folderToggleArmedId = folderId;
    folderToggleTimer = setTimeout(() => {
      folderToggleTimer = null;
      folderToggleArmedId = null;
      lastFolderClickAt = null;
      toggleCollapse(folderId);
    }, DOUBLE_CLICK_MS);
  }

  function beginRename(headerEl, folderId, currentName) {
    // Starting a rename aborts any armed collapse toggle so the row cannot re-render
    // and destroy the rename input a beat later.
    cancelPendingFolderToggle();
    if (headerEl.querySelector('.nest-rename-input')) {
      return;
    }
    const input = document.createElement('input');
    input.className = 'nest-rename-input';
    input.type = 'text';
    input.value = currentName;
    input.setAttribute('aria-label', 'Rename folder');
    const nameEl = headerEl.querySelector('.nest-folder-name');
    const countEl = headerEl.querySelector('.nest-folder-count');
    if (nameEl) {
      nameEl.style.display = 'none';
      nameEl.parentNode.insertBefore(input, nameEl);
    } else {
      headerEl.appendChild(input);
    }
    if (countEl) {
      countEl.style.display = 'none';
    }
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) {
        return;
      }
      done = true;
      if (pendingRename && pendingRename.commit === commit) {
        pendingRename = null;
      }
      const name = input.value.trim();
      cleanup();
      if (name.length > 0 && name !== currentName) {
        vscode.postMessage({ type: 'renameFolder', folderId, name });
      }
    };
    const cancel = () => {
      if (done) {
        return;
      }
      done = true;
      if (pendingRename && pendingRename.commit === commit) {
        pendingRename = null;
      }
      cleanup();
    };
    const cleanup = () => {
      input.remove();
      if (nameEl) {
        nameEl.style.display = '';
      }
      if (countEl) {
        countEl.style.display = '';
      }
    };
    pendingRename = { commit };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        commit();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
    input.addEventListener('blur', commit);
  }

  // Wires ArrowUp/ArrowDown cyclic focus and Enter/Space across the .nest-menu-item buttons of a role=menu
  // overlay, like the sort popover. Call after the items are appended and before focusing the first.
  function wireMenuRoving(menu) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('.nest-menu-item'));
    items.forEach(function (item, i) {
      item.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          items[(i + 1) % items.length].focus();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          items[(i - 1 + items.length) % items.length].focus();
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          item.click();
        }
      });
    });
  }

  let openMenuEl = null;
  function closeFolderMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
  }
  function openFolderMenu(e, headerEl, folderId, label, currentColor) {
    // Opening a conflicting surface aborts an armed folder-row collapse, so its timer cannot render() and
    // orphan this menu.
    cancelPendingFolderToggle();
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
    // Set color opens the 8-swatch picker under the folder header, seeded with the folder's color.
    item('Set color', () => beginColor(folderId, headerEl, currentColor || null));
    item('Clear color', () => vscode.postMessage({ type: 'setFolderColor', folderId, color: null }));
    item('Delete folder', () => vscode.postMessage({ type: 'deleteFolder', folderId }));
    menu.style.left = (e.clientX || 0) + 'px';
    menu.style.top = (e.clientY || 0) + 'px';
    document.body.appendChild(menu);
    openMenuEl = menu;
    wireMenuRoving(menu);
    const first = menu.querySelector('.nest-menu-item');
    if (first) {
      first.focus();
    }
  }
  // ---- chat context menu ----

  // Right-click menu on a chat row, a body-level fixed overlay closed with the other transient overlays on
  // re-render or Escape. LIST mode shows tags, export and archive; NEW-TAG mode shows a name input and
  // swatches. chatMenuSessionId is the target chat, re-resolved to its live row on each render.
  let openChatMenuEl = null;
  let chatMenuSessionId = null;
  let chatMenuReturnFocusEl = null;
  let chatMenuNewTagMode = false;
  let chatMenuNewTagColor = HANDOFF_PALETTE[0];
  let chatMenuNewTagName = '';

  function closeChatMenu() {
    if (openChatMenuEl) {
      openChatMenuEl.remove();
      openChatMenuEl = null;
    }
    chatMenuSessionId = null;
    chatMenuNewTagMode = false;
    chatMenuNewTagName = '';
    chatMenuNewTagColor = HANDOFF_PALETTE[0];
    if (chatMenuReturnFocusEl) {
      const el = chatMenuReturnFocusEl;
      chatMenuReturnFocusEl = null;
      if (typeof el.focus === 'function') {
        el.focus();
      }
    }
  }

  // The live row for the open menu's chat, or null if a refresh removed it, so a toggle reads current tags.
  function chatMenuRow() {
    if (!chatMenuSessionId) {
      return null;
    }
    return rowsBySessionId().get(chatMenuSessionId) || null;
  }

  function openChatMenu(e, sessionId) {
    // Opening the menu aborts an armed folder-row toggle so a re-render cannot orphan it.
    cancelPendingFolderToggle();
    closeAllTransientOverlays();
    if (!sessionId) {
      return;
    }
    chatMenuSessionId = sessionId;
    chatMenuNewTagMode = false;
    chatMenuNewTagName = '';
    chatMenuNewTagColor = HANDOFF_PALETTE[0];
    // Return focus to the row on close when it survives.
    var rows = focusableRows();
    chatMenuReturnFocusEl =
      rows.find(function (r) {
        return r.dataset.kind === 'chat' && r.dataset.id === sessionId;
      }) || null;
    var menu = document.createElement('div');
    menu.className = 'nest-menu nest-chat-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Chat actions');
    menu.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    menu.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
    });
    // Clamp near the click point so the menu never overflows.
    var left = Math.max(6, Math.min((e && e.clientX) || 0, window.innerWidth - 214));
    var top = Math.max(6, Math.min((e && e.clientY) || 0, window.innerHeight - 320));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    document.body.appendChild(menu);
    openChatMenuEl = menu;
    renderChatMenu();
  }

  // (Re)render the open chat menu's body for the current mode. Rebuilt in place so the
  // list <-> new-tag switch reuses the one positioned container.
  function renderChatMenu() {
    if (!openChatMenuEl) {
      return;
    }
    openChatMenuEl.textContent = '';
    if (chatMenuNewTagMode) {
      renderChatMenuNewTag(openChatMenuEl);
    } else {
      renderChatMenuList(openChatMenuEl);
    }
  }

  // A muted uppercase section caption inside the menu (TAGS / NEW TAG).
  function chatMenuCaption(text) {
    var cap = document.createElement('div');
    cap.className = 'nest-menu-caption';
    cap.textContent = text;
    return cap;
  }

  function chatMenuDivider() {
    var d = document.createElement('div');
    d.className = 'nest-menu-divider';
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  // The LIST mode: TAGS (all project tags with a checkmark on the chat's current tags),
  // Create new tag, Export as Markdown / JSON, and Archive-or-starred-note.
  function renderChatMenuList(menu) {
    var row = chatMenuRow();
    if (!row) {
      closeChatMenu();
      return;
    }
    var sessionId = row.sessionId;
    var currentTagIds = row.tagIds || [];

    if (isAttachableChat(sessionId)) {
      var termBtn = document.createElement('button');
      termBtn.type = 'button';
      termBtn.className = 'nest-menu-item';
      termBtn.setAttribute('role', 'menuitem');
      termBtn.textContent = 'Open in terminal';
      termBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        vscode.postMessage({ type: 'openInTerminal', sessionId: sessionId, explicit: true });
        closeChatMenu();
      });
      menu.appendChild(termBtn);
      menu.appendChild(chatMenuDivider());
    }

    menu.appendChild(chatMenuCaption('TAGS'));
    var allTags = sections.allTags || [];
    for (var i = 0; i < allTags.length; i++) {
      (function (tag) {
        var on = currentTagIds.indexOf(tag.tagId) !== -1;
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'nest-menu-item nest-menu-tag';
        item.setAttribute('role', 'menuitemcheckbox');
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        var dot = document.createElement('span');
        dot.className = 'nest-menu-tag-dot';
        dot.setAttribute('aria-hidden', 'true');
        if (tag.color) {
          dot.style.background = tag.color;
        }
        item.appendChild(dot);
        var labelEl = document.createElement('span');
        labelEl.className = 'nest-menu-tag-label';
        labelEl.textContent = tag.label;
        item.appendChild(labelEl);
        var check = document.createElement('span');
        check.className = 'nest-menu-tag-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = on ? '✓' : '';
        item.appendChild(check);
        item.setAttribute(
          'aria-label',
          (on ? 'Remove tag ' : 'Add tag ') + tag.label,
        );
        item.addEventListener('click', function (ev) {
          ev.stopPropagation();
          // Toggle against the LIVE tag set (re-resolved), so a stale captured `on` cannot
          // send the wrong direction. The store no-ops a redundant add/remove.
          var live = chatMenuRow();
          var isOn = !!live && (live.tagIds || []).indexOf(tag.tagId) !== -1;
          vscode.postMessage({
            type: 'toggleTag',
            sessionId: sessionId,
            tagId: tag.tagId,
            on: !isOn,
          });
          // Close now: the refresh after the store write re-renders and closes the menu anyway; the checkmark
          // shows on reopen.
          closeChatMenu();
        });
        menu.appendChild(item);
      })(allTags[i]);
    }

    menu.appendChild(chatMenuDivider());

    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'nest-menu-item nest-menu-create';
    createBtn.setAttribute('role', 'menuitem');
    createBtn.textContent = '＋ Create new tag';
    createBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      chatMenuNewTagMode = true;
      chatMenuNewTagName = '';
      chatMenuNewTagColor = HANDOFF_PALETTE[0];
      renderChatMenu();
    });
    menu.appendChild(createBtn);

    menu.appendChild(chatMenuDivider());

    var exportMd = document.createElement('button');
    exportMd.type = 'button';
    exportMd.className = 'nest-menu-item';
    exportMd.setAttribute('role', 'menuitem');
    exportMd.textContent = '⤓ Export as Markdown';
    exportMd.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'exportChat', sessionId: sessionId, format: 'markdown' });
      closeChatMenu();
    });
    menu.appendChild(exportMd);

    var exportJson = document.createElement('button');
    exportJson.type = 'button';
    exportJson.className = 'nest-menu-item';
    exportJson.setAttribute('role', 'menuitem');
    exportJson.textContent = '⤓ Export as JSON';
    exportJson.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'exportChat', sessionId: sessionId, format: 'json' });
      closeChatMenu();
    });
    menu.appendChild(exportJson);

    // Archive is shown ONLY when the chat is neither starred nor archived. A starred chat
    // shows the "kept and never archived" note in its place.
    if (row.starred) {
      menu.appendChild(chatMenuDivider());
      var note = document.createElement('div');
      note.className = 'nest-menu-note';
      note.textContent = '★ Starred chats are kept and never archived.';
      menu.appendChild(note);
    } else {
      menu.appendChild(chatMenuDivider());
      var archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.className = 'nest-menu-item';
      archiveBtn.setAttribute('role', 'menuitem');
      archiveBtn.textContent = '🗄 Archive chat';
      archiveBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        vscode.postMessage({ type: 'archiveChat', sessionId: sessionId });
        closeChatMenu();
      });
      menu.appendChild(archiveBtn);
    }

    wireMenuRoving(menu);
    var first = menu.querySelector('.nest-menu-item');
    if (first) {
      first.focus();
    }
  }

  // NEW-TAG mode: name input, swatches, Add tag and Cancel. Add posts createTagWithColor with a palette
  // literal (or the default), the trimmed name and the sessionId.
  function renderChatMenuNewTag(menu) {
    var row = chatMenuRow();
    if (!row) {
      closeChatMenu();
      return;
    }
    var sessionId = row.sessionId;

    menu.appendChild(chatMenuCaption('NEW TAG'));

    var body = document.createElement('div');
    body.className = 'nest-menu-newtag';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'nest-menu-newtag-input';
    input.placeholder = 'Tag name';
    input.value = chatMenuNewTagName;
    input.setAttribute('aria-label', 'New tag name');
    input.addEventListener('input', function () {
      chatMenuNewTagName = input.value;
    });
    body.appendChild(input);

    var grid = document.createElement('div');
    grid.className = 'nest-menu-newtag-swatches';
    var swatches = [];
    for (var i = 0; i < HANDOFF_PALETTE.length; i++) {
      (function (color) {
        var sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'nest-swatch nest-menu-newtag-swatch';
        sw.setAttribute('role', 'menuitemradio');
        var selected = color.toLowerCase() === chatMenuNewTagColor.toLowerCase();
        sw.setAttribute('aria-checked', selected ? 'true' : 'false');
        if (selected) {
          sw.classList.add('nest-swatch-selected');
        }
        sw.style.setProperty('--swatch-color', color);
        sw.setAttribute('aria-label', 'Tag color ' + color);
        sw.title = color;
        sw.addEventListener('click', function (ev) {
          ev.stopPropagation();
          chatMenuNewTagColor = color;
          for (var j = 0; j < swatches.length; j++) {
            var isSel = swatches[j] === sw;
            swatches[j].setAttribute('aria-checked', isSel ? 'true' : 'false');
            if (isSel) {
              swatches[j].classList.add('nest-swatch-selected');
            } else {
              swatches[j].classList.remove('nest-swatch-selected');
            }
          }
        });
        grid.appendChild(sw);
        swatches.push(sw);
      })(HANDOFF_PALETTE[i]);
    }
    // Arrow-key movement across swatches (mirrors the folder color picker).
    swatches.forEach(function (sw, i) {
      sw.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          swatches[(i + 1) % swatches.length].focus();
        } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          swatches[(i - 1 + swatches.length) % swatches.length].focus();
        }
      });
    });
    body.appendChild(grid);

    var actions = document.createElement('div');
    actions.className = 'nest-menu-newtag-actions';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'nest-menu-newtag-add';
    addBtn.textContent = 'Add tag';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'nest-menu-newtag-cancel';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(addBtn);
    actions.appendChild(cancelBtn);
    body.appendChild(actions);
    menu.appendChild(body);

    var commit = function () {
      var name = input.value.trim();
      if (name.length === 0) {
        input.focus();
        return;
      }
      vscode.postMessage({
        type: 'createTagWithColor',
        sessionId: sessionId,
        label: name,
        color: chatMenuNewTagColor,
      });
      // The refresh after the mint re-renders and closes the menu; close now so it does
      // not linger. The new tag is already applied to the chat by the host.
      closeChatMenu();
    };
    addBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      commit();
    });
    cancelBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      // Cancel returns to the tag list instead of closing the menu.
      chatMenuNewTagMode = false;
      chatMenuNewTagName = '';
      renderChatMenu();
    });
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        chatMenuNewTagMode = false;
        chatMenuNewTagName = '';
        renderChatMenu();
      }
    });
    input.focus();
  }

  document.addEventListener('click', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target)) {
      closeFolderMenu();
    }
    if (openColorEl && !openColorEl.contains(e.target)) {
      closeColorPicker();
    }
    if (openNewFolderEl && !openNewFolderEl.contains(e.target)) {
      closeNewFolderPopover();
    }
    if (openChatMenuEl && !openChatMenuEl.contains(e.target)) {
      closeChatMenu();
    }
  });

  // In-panel 8-swatch folder color picker. It posts setFolderColor with a palette literal or null (the
  // Default chip); the host re-validates.
  let openColorEl = null;
  let colorReturnFocusEl = null;
  function closeColorPicker() {
    if (openColorEl) {
      openColorEl.remove();
      openColorEl = null;
    }
    // Restore focus to the folder header so it is not dropped to body.
    if (colorReturnFocusEl) {
      const el = colorReturnFocusEl;
      colorReturnFocusEl = null;
      if (typeof el.focus === 'function') {
        el.focus();
      }
    }
  }
  // anchorEl positions the picker and receives focus on close; currentColor (#rrggbb or null) marks the
  // active swatch.
  function beginColor(folderId, anchorEl, currentColor) {
    cancelPendingFolderToggle();
    closeFolderMenu();
    closeColorPicker();
    colorReturnFocusEl = anchorEl && typeof anchorEl.focus === 'function' ? anchorEl : null;
    const pop = document.createElement('div');
    pop.className = 'nest-color-popover';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', 'Folder color');

    const grid = document.createElement('div');
    grid.className = 'nest-swatch-grid';
    const norm = typeof currentColor === 'string' ? currentColor.toLowerCase() : null;
    const swatches = [];
    for (const color of HANDOFF_PALETTE) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'nest-swatch';
      sw.setAttribute('role', 'menuitemradio');
      const selected = norm !== null && norm === color.toLowerCase();
      sw.setAttribute('aria-checked', selected ? 'true' : 'false');
      if (selected) {
        sw.classList.add('nest-swatch-selected');
      }
      sw.style.setProperty('--swatch-color', color);
      sw.setAttribute('aria-label', 'Set folder color ' + color);
      sw.title = color;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        // A committed pick re-renders and re-seats the roving tabindex; do not refocus the stale header.
        colorReturnFocusEl = null;
        closeColorPicker();
        vscode.postMessage({ type: 'setFolderColor', folderId, color });
      });
      grid.appendChild(sw);
      swatches.push(sw);
    }
    pop.appendChild(grid);

    // The Default chip clears the color (posts null), like the folder menu's Clear color.
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'nest-swatch-clear';
    clear.setAttribute('role', 'menuitem');
    clear.textContent = 'Default';
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      // A committed clear re-renders like a pick; do not refocus the stale header.
      colorReturnFocusEl = null;
      closeColorPicker();
      vscode.postMessage({ type: 'setFolderColor', folderId, color: null });
    });
    pop.appendChild(clear);

    // Position under the anchor, clamped into the viewport so it never overflows.
    const rect =
      anchorEl && typeof anchorEl.getBoundingClientRect === 'function'
        ? anchorEl.getBoundingClientRect()
        : { left: 12, bottom: 40 };
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - 190));
    const top = Math.min(rect.bottom + 4, window.innerHeight - 90);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    // Keyboard: Arrow keys move across swatches, Escape closes and restores focus to
    // the folder header, Enter/Space activates (native button behavior).
    swatches.forEach((sw, i) => {
      sw.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          swatches[(i + 1) % swatches.length].focus();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          swatches[(i - 1 + swatches.length) % swatches.length].focus();
        }
      });
    });
    pop.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(pop);
    openColorEl = pop;
    const active = pop.querySelector('.nest-swatch-selected') || swatches[0];
    if (active) {
      active.focus();
    }
  }

  // ---- new-folder popover ----

  // New folder popover from the FOLDERS + button. Create posts { type:'createFolder', name }; the host runs
  // createFolder with presetName, so slash paths and the depth cap still apply. Enter commits, Escape
  // cancels and an outside click dismisses it.
  let openNewFolderEl = null;
  let newFolderReturnFocusEl = null;
  function closeNewFolderPopover() {
    if (openNewFolderEl) {
      openNewFolderEl.remove();
      openNewFolderEl = null;
    }
    // Restore focus to the + button on close. A committed Create nulls this first, since a re-render follows.
    if (newFolderReturnFocusEl) {
      const el = newFolderReturnFocusEl;
      newFolderReturnFocusEl = null;
      if (typeof el.focus === 'function') {
        el.focus();
      }
    }
  }

  // Closes all body-level transient overlays together. They are position:fixed outside listEl, so a re-render
  // leaves them behind and their buttons could post mutations for a changed folder. Escape and every tree
  // re-render call this one function; the keys mirror TRANSIENT_OVERLAY_KEYS in orgPanelInteractions.ts.
  function closeAllTransientOverlays() {
    closeColorPicker();
    closeNewFolderPopover();
    closeFolderMenu();
    // The chat menu is also a body-level overlay and closes with the rest.
    closeChatMenu();
  }
  function openNewFolderPopover(anchorEl) {
    cancelPendingFolderToggle();
    closeFolderMenu();
    closeColorPicker();
    if (openNewFolderEl) {
      closeNewFolderPopover();
      return;
    }
    newFolderReturnFocusEl = anchorEl && typeof anchorEl.focus === 'function' ? anchorEl : null;
    const pop = document.createElement('div');
    pop.className = 'nest-newfolder-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-label', 'New folder');

    const title = document.createElement('div');
    title.className = 'nest-newfolder-title';
    title.textContent = 'NEW FOLDER';
    pop.appendChild(title);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nest-newfolder-input';
    input.placeholder = 'Folder name';
    input.setAttribute('aria-label', 'New folder name');
    pop.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'nest-newfolder-actions';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'nest-newfolder-create';
    createBtn.textContent = 'Create';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'nest-newfolder-cancel';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(createBtn);
    actions.appendChild(cancelBtn);
    pop.appendChild(actions);

    const commit = () => {
      const name = input.value.trim();
      if (name.length > 0) {
        // A successful create re-renders and re-seats focus; do not refocus the + button.
        newFolderReturnFocusEl = null;
        closeNewFolderPopover();
        vscode.postMessage({ type: 'createFolder', name });
      } else {
        // Empty name: nothing created; restore focus to the + button on close.
        closeNewFolderPopover();
      }
    };
    createBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      commit();
    });
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNewFolderPopover();
    });
    input.addEventListener('keydown', (e) => {
      // Let Tab/Shift+Tab pass to the dialog focus trap; swallowing it here would let focus
      // escape the modal into the tree behind the popover.
      if (e.key === 'Tab') {
        return;
      }
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeNewFolderPopover();
      }
    });
    pop.addEventListener('click', (e) => e.stopPropagation());

    // Position under the + button, clamped into the viewport.
    const rect = anchorEl ? anchorEl.getBoundingClientRect() : { left: 12, bottom: 40 };
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - 210));
    const top = Math.min(rect.bottom + 4, window.innerHeight - 130);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    document.body.appendChild(pop);
    openNewFolderEl = pop;
    wireDialogFocusTrap(pop);
    input.focus();
  }

  // ---- Settings overlay ----

  // The four section toggles, with their sub-labels. Each drives sectionsVisible[key] and
  // posts { type:'setSectionsVisible', [key]:next }.
  const SECTION_TOGGLES = [
    { key: 'starred', label: 'Starred', sub: 'Show starred chats at the top' },
    { key: 'questions', label: 'Questions', sub: 'Surface chats awaiting your reply' },
    { key: 'folders', label: 'Folders', sub: 'Show the folder tree' },
    { key: 'unsorted', label: 'Unsorted', sub: 'Show chats not in a folder' },
  ];

  // Focus trap for every role=dialog aria-modal surface (Settings, Archive, New folder). Tab wraps within the
  // dialog, and a Tab from outside or a removed node snaps to the first focusable. Escape is handled
  // elsewhere. Call once at build time; the listener dies with the node.
  function dialogFocusables(overlay) {
    var sel =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),' +
      ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(overlay.querySelectorAll(sel), function (el) {
      // Skip hidden nodes (offsetParent null) so the trap lands on a real, visible control.
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function wireDialogFocusTrap(overlay) {
    // Capture phase so the trap sees Tab before a child's handler: some children (the New-folder input) stop
    // propagation, which would defeat a bubbling listener.
    overlay.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') {
        return;
      }
      // Mirrors dialogFocusTrapAction in orgPanelInteractions.ts: the DOM work is here, the edge and wrap
      // decision lives in the tested kernel.
      var items = dialogFocusables(overlay);
      var active = document.activeElement;
      var activeIndex = overlay.contains(active)
        ? Array.prototype.indexOf.call(items, active)
        : -1;
      var count = items.length;
      var action;
      if (count <= 0) {
        action = { preventDefault: true, focusIndex: null };
      } else if (activeIndex < 0) {
        action = { preventDefault: true, focusIndex: 0 };
      } else if (e.shiftKey && activeIndex === 0) {
        action = { preventDefault: true, focusIndex: count - 1 };
      } else if (!e.shiftKey && activeIndex === count - 1) {
        action = { preventDefault: true, focusIndex: 0 };
      } else {
        action = { preventDefault: false, focusIndex: null };
      }
      if (action.preventDefault) {
        e.preventDefault();
      }
      if (action.focusIndex !== null && items[action.focusIndex]) {
        items[action.focusIndex].focus();
      }
    }, true);
  }

  function closeSettingsOverlay(restoreFocusToGear) {
    if (settingsOverlayEl) {
      settingsOverlayEl.remove();
      settingsOverlayEl = null;
    }
    if (restoreFocusToGear && settingsReturnFocusEl && typeof settingsReturnFocusEl.focus === 'function') {
      settingsReturnFocusEl.focus();
    }
    settingsReturnFocusEl = null;
  }

  function isSettingsOpen() {
    return settingsOverlayEl !== null;
  }

  // Builds the full-panel Settings overlay (inset:0 over the panel), open until the back chevron or Escape.
  // Opening while open re-renders in place so a fresh 'settings' state re-seeds the controls.
  function openSettingsOverlay() {
    // Close the click-dismiss popovers; this persistent sub-page is outside that close-set.
    closeAllTransientOverlays();
    closeSort(false);
    // Two persistent sub-pages never stack: opening Settings closes the Archive overlay.
    if (isArchiveOpen()) {
      closeArchiveOverlay(false);
    }
    if (settingsOverlayEl) {
      closeSettingsOverlay(false);
    }
    settingsReturnFocusEl = settingsEl || null;

    const overlay = document.createElement('div');
    overlay.className = 'nest-overlay nest-settings-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Settings');

    // Header: back chevron + heading.
    const header = document.createElement('div');
    header.className = 'nest-overlay-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'nest-overlay-back';
    back.title = 'Back';
    back.setAttribute('aria-label', 'Back');
    back.textContent = '‹'; // single left angle quote
    back.addEventListener('click', () => closeSettingsOverlay(true));
    header.appendChild(back);
    const heading = document.createElement('span');
    heading.className = 'nest-overlay-title';
    heading.textContent = 'Settings';
    header.appendChild(heading);
    overlay.appendChild(header);

    // Scrolling body.
    const body = document.createElement('div');
    body.className = 'nest-overlay-body';

    // GROUP CHATS BY: a four-option segmented control.
    const groupLabel = document.createElement('div');
    groupLabel.className = 'nest-settings-group-label';
    groupLabel.textContent = 'GROUP CHATS BY';
    body.appendChild(groupLabel);

    const seg = document.createElement('div');
    seg.className = 'nest-seg';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Group chats by');
    GROUP_BY_OPTIONS.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nest-seg-opt';
      b.setAttribute('role', 'radio');
      b.dataset.mode = opt.mode;
      b.textContent = opt.label;
      b.addEventListener('click', () => {
        groupByOverride = opt.mode;
        reconcileOpenSettingsControls();
        vscode.postMessage({ type: 'setGroupBy', mode: opt.mode });
      });
      seg.appendChild(b);
    });
    body.appendChild(seg);

    const groupNote = document.createElement('div');
    groupNote.className = 'nest-settings-note';
    groupNote.textContent = 'Auto: tickets when an orchestrator records them, otherwise folders, then date.';
    body.appendChild(groupNote);

    // LAYOUT FILE: the path and an Open button.
    const layoutLabel = document.createElement('div');
    layoutLabel.className = 'nest-settings-group-label nest-settings-group-label-spaced';
    layoutLabel.textContent = 'LAYOUT FILE';
    body.appendChild(layoutLabel);

    const layoutRow = document.createElement('div');
    layoutRow.className = 'nest-settings-card-row';
    const layoutPath = document.createElement('span');
    layoutPath.className = 'nest-settings-path';
    layoutPath.textContent = '.nest/config.json';
    layoutRow.appendChild(layoutPath);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'nest-settings-open-btn';
    openBtn.textContent = 'Open';
    openBtn.setAttribute('aria-label', 'Open layout file');
    openBtn.addEventListener('click', () => vscode.postMessage({ type: 'openLayoutFile' }));
    layoutRow.appendChild(openBtn);
    body.appendChild(layoutRow);

    // ORGANIZE: Preview, Apply and Undo for the layout file's rules.
    const organizeLabel = document.createElement('div');
    organizeLabel.className = 'nest-settings-group-label nest-settings-group-label-spaced';
    organizeLabel.textContent = 'ORGANIZE';
    body.appendChild(organizeLabel);

    const organizeNote = document.createElement('div');
    organizeNote.className = 'nest-settings-note nest-organize-note';
    organizeNote.textContent = 'The rules in your layout file sort chats into folders and tags. Preview lists every move first; nothing changes until you apply.';
    body.appendChild(organizeNote);

    const organizeActions = document.createElement('div');
    organizeActions.className = 'nest-organize-actions';
    [
      { act: 'preview', label: 'Preview', type: 'organizePreview', aria: 'Preview organize rules' },
      { act: 'apply', label: 'Apply', type: 'organizeApply', aria: 'Apply organize rules' },
      { act: 'undo', label: 'Undo', type: 'organizeUndo', aria: 'Undo the last organize apply' },
    ].forEach(function (def) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nest-settings-open-btn nest-organize-btn';
      btn.dataset.organize = def.act;
      btn.textContent = def.label;
      btn.setAttribute('aria-label', def.aria);
      btn.addEventListener('click', function () {
        if (btn.disabled) {
          return;
        }
        organizeBusy = true;
        renderOrganize();
        vscode.postMessage({ type: def.type });
      });
      organizeActions.appendChild(btn);
    });
    body.appendChild(organizeActions);

    const organizeStatus = document.createElement('div');
    organizeStatus.className = 'nest-organize-status';
    organizeStatus.setAttribute('role', 'status');
    organizeStatus.setAttribute('aria-live', 'polite');
    body.appendChild(organizeStatus);

    const organizeProblems = document.createElement('ul');
    organizeProblems.className = 'nest-organize-problems';
    organizeProblems.setAttribute('aria-label', 'Rule problems');
    body.appendChild(organizeProblems);

    const organizeList = document.createElement('ul');
    organizeList.className = 'nest-organize-list';
    organizeList.setAttribute('aria-label', 'Planned moves');
    body.appendChild(organizeList);

    // ROBIN: the animations switch.
    const robinLabel = document.createElement('div');
    robinLabel.className = 'nest-settings-group-label nest-settings-group-label-spaced';
    robinLabel.textContent = 'ROBIN';
    body.appendChild(robinLabel);

    const robinRow = document.createElement('div');
    robinRow.className = 'nest-settings-card-row nest-settings-robin-row';
    const robinName = document.createElement('span');
    robinName.className = 'nest-settings-toggle-name';
    robinName.textContent = 'Animations';
    robinRow.appendChild(robinName);
    const robinSw = document.createElement('button');
    robinSw.type = 'button';
    robinSw.className = 'nest-switch nest-switch-robin';
    robinSw.setAttribute('role', 'switch');
    robinSw.setAttribute('aria-label', 'Robin animations');
    const robinThumb = document.createElement('span');
    robinThumb.className = 'nest-switch-thumb';
    robinThumb.setAttribute('aria-hidden', 'true');
    robinSw.appendChild(robinThumb);
    robinSw.addEventListener('click', () => {
      robinAnimationsOn = !robinAnimationsOn;
      reconcileOpenSettingsControls();
      vscode.postMessage({ type: 'setRobinAnimations', on: robinAnimationsOn });
    });
    robinRow.appendChild(robinSw);
    body.appendChild(robinRow);

    const topDivider = document.createElement('div');
    topDivider.className = 'nest-settings-divider';
    topDivider.setAttribute('aria-hidden', 'true');
    body.appendChild(topDivider);

    // ARCHIVING group.
    const archLabel = document.createElement('div');
    archLabel.className = 'nest-settings-group-label';
    archLabel.textContent = 'ARCHIVING';
    body.appendChild(archLabel);

    const keepLabel = document.createElement('div');
    keepLabel.className = 'nest-settings-field-label';
    keepLabel.textContent = 'Keep chats for';
    body.appendChild(keepLabel);

    const select = document.createElement('select');
    select.className = 'nest-settings-select';
    select.setAttribute('aria-label', 'Keep chats for');
    for (const opt of AUTO_ARCHIVE_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(opt.days);
      o.textContent = opt.label;
      if (opt.days === autoArchiveWindowDays) {
        o.selected = true;
      }
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      const days = Number(select.value);
      autoArchiveWindowDays = days;
      vscode.postMessage({ type: 'setAutoArchiveWindow', days });
    });
    body.appendChild(select);

    const archNote = document.createElement('div');
    archNote.className = 'nest-settings-note';
    archNote.textContent = 'Chats older than this are moved to Archive automatically. Starred chats are kept.';
    body.appendChild(archNote);

    const divider = document.createElement('div');
    divider.className = 'nest-settings-divider';
    divider.setAttribute('aria-hidden', 'true');
    body.appendChild(divider);

    // SIDEBAR SECTIONS group.
    const secLabel = document.createElement('div');
    secLabel.className = 'nest-settings-group-label';
    secLabel.textContent = 'SIDEBAR SECTIONS';
    body.appendChild(secLabel);

    SECTION_TOGGLES.forEach((t, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'nest-settings-toggle-row';
      if (i === SECTION_TOGGLES.length - 1) {
        rowEl.classList.add('nest-settings-toggle-row-last');
      }
      const textCol = document.createElement('div');
      textCol.className = 'nest-settings-toggle-text';
      const name = document.createElement('div');
      name.className = 'nest-settings-toggle-name';
      name.textContent = t.label;
      const sub = document.createElement('div');
      sub.className = 'nest-settings-toggle-sub';
      sub.textContent = t.sub;
      textCol.appendChild(name);
      textCol.appendChild(sub);
      rowEl.appendChild(textCol);

      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'nest-switch';
      sw.setAttribute('role', 'switch');
      const on = sectionsVisible[t.key] !== false;
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.setAttribute('aria-label', t.label);
      if (on) {
        sw.classList.add('nest-switch-on');
      }
      const thumb = document.createElement('span');
      thumb.className = 'nest-switch-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      sw.appendChild(thumb);
      sw.addEventListener('click', () => {
        const next = !(sectionsVisible[t.key] !== false);
        sectionsVisible[t.key] = next;
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        sw.classList.toggle('nest-switch-on', next);
        var payload = { type: 'setSectionsVisible' };
        payload[t.key] = next;
        vscode.postMessage(payload);
        // Re-render the tree beneath the overlay so closing it shows the new gating
        // immediately (the overlay itself stays open).
        render();
      });
      rowEl.appendChild(sw);
      body.appendChild(rowEl);
    });

    overlay.appendChild(body);
    // Append INSIDE the panel body (not document.body) so it overlays the tree/toolbar
    // area as an inset:0 sub-page and inherits the panel width.
    document.body.appendChild(overlay);
    settingsOverlayEl = overlay;
    reconcileOpenSettingsControls();
    renderOrganize();
    wireDialogFocusTrap(overlay);
    back.focus();
  }

  // Coerces the host's organize report to a safe shape. Every string is rendered as
  // textContent only; counts and lists are bounded.
  function coerceOrganize(msg) {
    const text = function (v, max) {
      return typeof v === 'string' ? v.slice(0, max) : '';
    };
    const num = function (v) {
      return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    };
    const moves = [];
    if (Array.isArray(msg.moves)) {
      msg.moves.slice(0, 500).forEach(function (m) {
        if (!m || typeof m !== 'object' || typeof m.sessionId !== 'string') {
          return;
        }
        moves.push({
          sessionId: text(m.sessionId, 64),
          title: text(m.title, 200),
          from: typeof m.from === 'string' ? text(m.from, 400) : null,
          to: typeof m.to === 'string' ? text(m.to, 400) : null,
          createsFolder: m.createsFolder === true,
          tags: Array.isArray(m.tags) ? m.tags.slice(0, 20).map(function (t) { return text(t, 200); }) : [],
          pin: m.pin === true,
        });
      });
    }
    return {
      kind: msg.kind === 'preview' || msg.kind === 'applied' || msg.kind === 'undone' || msg.kind === 'error' ? msg.kind : 'idle',
      message: text(msg.message, 300),
      moves: moves,
      moreMoves: num(msg.moreMoves),
      matched: num(msg.matched),
      skippedHandFiled: num(msg.skippedHandFiled),
      rulesActive: num(msg.rulesActive),
      problems: Array.isArray(msg.problems) ? msg.problems.slice(0, 20).map(function (t) { return text(t, 300); }) : [],
      canUndo: msg.canUndo === true,
      undoCount: num(msg.undoCount),
      skippedOnUndo: num(msg.skippedOnUndo),
    };
  }

  // Folder paths arrive as 'A/B'; show them with spaced separators like the breadcrumb.
  function organizePathText(p) {
    return typeof p === 'string' && p.length > 0 ? p.split('/').join(' / ') : 'Unsorted';
  }

  // Paints the Organize section from organizeState. Safe to call while the overlay is closed.
  function renderOrganize() {
    if (!settingsOverlayEl) {
      return;
    }
    const st = organizeState;
    const previewBtn = settingsOverlayEl.querySelector('[data-organize="preview"]');
    const applyBtn = settingsOverlayEl.querySelector('[data-organize="apply"]');
    const undoBtn = settingsOverlayEl.querySelector('[data-organize="undo"]');
    if (previewBtn) {
      previewBtn.disabled = organizeBusy;
    }
    if (applyBtn) {
      applyBtn.disabled = organizeBusy || st.kind !== 'preview' || st.moves.length === 0;
    }
    if (undoBtn) {
      undoBtn.disabled = organizeBusy || !st.canUndo;
      undoBtn.textContent = st.canUndo && st.undoCount > 0 ? 'Undo ' + st.undoCount : 'Undo';
    }
    const status = settingsOverlayEl.querySelector('.nest-organize-status');
    if (status) {
      const parts = [];
      if (organizeBusy) {
        parts.push('Working...');
      } else {
        if (st.message) {
          parts.push(st.message);
        }
        if (st.kind === 'preview' && st.skippedHandFiled > 0) {
          parts.push(st.skippedHandFiled + (st.skippedHandFiled === 1 ? ' chat you filed or moved to Unsorted by hand is left alone.' : ' chats you filed or moved to Unsorted by hand are left alone.'));
        }
      }
      status.textContent = parts.join(' ');
      status.hidden = parts.length === 0;
    }
    const problems = settingsOverlayEl.querySelector('.nest-organize-problems');
    if (problems) {
      problems.textContent = '';
      st.problems.forEach(function (text) {
        const li = document.createElement('li');
        li.textContent = text;
        problems.appendChild(li);
      });
      problems.hidden = st.problems.length === 0;
    }
    const list = settingsOverlayEl.querySelector('.nest-organize-list');
    if (list) {
      list.textContent = '';
      const moves = st.kind === 'preview' ? st.moves : [];
      moves.forEach(function (m) {
        const li = document.createElement('li');
        li.className = 'nest-organize-move';
        const title = document.createElement('div');
        title.className = 'nest-organize-move-title';
        title.textContent = m.title || m.sessionId;
        title.title = m.title || m.sessionId;
        li.appendChild(title);
        const detail = document.createElement('div');
        detail.className = 'nest-organize-move-detail';
        const route = document.createElement('div');
        route.className = 'nest-organize-route';
        if (typeof m.to === 'string' && m.to.length > 0) {
          const from = document.createElement('span');
          from.className = 'nest-organize-from';
          from.textContent = organizePathText(m.from);
          route.appendChild(from);
          const arrow = document.createElement('span');
          arrow.className = 'nest-organize-arrow';
          arrow.setAttribute('aria-hidden', 'true');
          arrow.textContent = '\u2192';
          route.appendChild(arrow);
          const to = document.createElement('span');
          to.className = 'nest-organize-to';
          to.textContent = organizePathText(m.to) + (m.createsFolder ? ' (new)' : '');
          route.appendChild(to);
        } else {
          const stays = document.createElement('span');
          stays.className = 'nest-organize-stays';
          stays.textContent = 'Stays in ' + organizePathText(m.from) + (m.pin && !(m.tags || []).length ? ', starred' : ', tagged');
          route.appendChild(stays);
        }
        detail.appendChild(route);
        const tagList = m.tags || [];
        if (tagList.length > 0 || m.pin) {
          const chips = document.createElement('div');
          chips.className = 'nest-organize-chips';
          tagList.forEach(function (label) {
            const chip = document.createElement('span');
            chip.className = 'nest-organize-chip';
            chip.textContent = '+ ' + label;
            chips.appendChild(chip);
          });
          if (m.pin) {
            const chip = document.createElement('span');
            chip.className = 'nest-organize-chip';
            chip.textContent = 'Star';
            chips.appendChild(chip);
          }
          detail.appendChild(chips);
        }
        li.appendChild(detail);
        list.appendChild(li);
      });
      if (st.kind === 'preview' && st.moreMoves > 0) {
        const more = document.createElement('li');
        more.className = 'nest-organize-more';
        more.textContent = '+ ' + st.moreMoves + ' more';
        list.appendChild(more);
      }
      list.hidden = list.children.length === 0;
    }
  }

  // Reconcile the OPEN overlay's controls to the current state WITHOUT a rebuild, so a
  // host-side coercion (e.g. an out-of-range window snapped to the default) is reflected
  // but focus is NOT stolen back to the back chevron on every toggle. No-op when closed.
  function reconcileOpenSettingsControls() {
    if (!settingsOverlayEl) {
      return;
    }
    const select = settingsOverlayEl.querySelector('.nest-settings-select');
    if (select) {
      select.value = String(autoArchiveWindowDays);
    }
    settingsOverlayEl.querySelectorAll('.nest-seg-opt').forEach(function (b) {
      const pressed = b.dataset.mode === groupByOverride;
      b.setAttribute('aria-checked', pressed ? 'true' : 'false');
      b.classList.toggle('nest-seg-opt-on', pressed);
    });
    const robinSwEl = settingsOverlayEl.querySelector('.nest-switch-robin');
    if (robinSwEl) {
      robinSwEl.setAttribute('aria-checked', robinAnimationsOn ? 'true' : 'false');
      robinSwEl.classList.toggle('nest-switch-on', robinAnimationsOn);
    }
    const rows = settingsOverlayEl.querySelectorAll('.nest-settings-toggle-row');
    // Rows are in SECTION_TOGGLES order; sync each switch's on-state from sectionsVisible.
    SECTION_TOGGLES.forEach(function (t, i) {
      const rowEl = rows[i];
      if (!rowEl) {
        return;
      }
      const sw = rowEl.querySelector('.nest-switch');
      if (!sw) {
        return;
      }
      const on = sectionsVisible[t.key] !== false;
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.classList.toggle('nest-switch-on', on);
    });
  }

  // ---- Archive overlay ----

  function isArchiveOpen() {
    return archiveOverlayEl !== null;
  }

  // Coerces one inbound archived row to a safe shape: strings render as textContent only, and a row
  // without a string sessionId is dropped.
  function isArchivedRow(r) {
    return !!r && typeof r.sessionId === 'string' && r.sessionId.length > 0;
  }

  // Closes the Archive overlay. restoreFocusToTrigger returns focus to the Archived (N) row (resolved by
  // class, since a re-render replaces it). Clears the held rows and search text.
  function closeArchiveOverlay(restoreFocusToTrigger) {
    if (archiveOverlayEl) {
      archiveOverlayEl.remove();
      archiveOverlayEl = null;
    }
    archivedRows = [];
    archiveSearchText = '';
    var target = null;
    if (restoreFocusToTrigger) {
      target =
        (archiveReturnFocusEl && document.body.contains(archiveReturnFocusEl)
          ? archiveReturnFocusEl
          : document.querySelector('.nest-archived-row')) || null;
    }
    archiveReturnFocusEl = null;
    if (target && typeof target.focus === 'function') {
      target.focus();
    }
  }

  // The archived rows to render, filtered by the client-side archive-search text (title
  // substring, c.title.includes(aq)). An empty search shows all rows.
  function filteredArchivedRows() {
    if (archiveSearchText.length === 0) {
      return archivedRows.slice();
    }
    return archivedRows.filter(function (r) {
      var t = typeof r.title === 'string' ? r.title : '';
      return t.toLowerCase().indexOf(archiveSearchText) !== -1;
    });
  }

  // Builds the full-panel Archive overlay, reusing the Settings overlay chrome. Opening while open re-renders
  // in place so a fresh 'archivedRows' post re-seeds the list. Open until the back chevron or Escape.
  function openArchiveOverlay() {
    // Dismiss the popovers and close Settings first; two persistent sub-pages never stack.
    closeAllTransientOverlays();
    closeSort(false);
    if (isSettingsOpen()) {
      closeSettingsOverlay(false);
    }
    if (archiveOverlayEl) {
      // Re-render in place: tear down the body and rebuild so a fresh post re-seeds it,
      // preserving the current search text.
      renderArchiveOverlayBody();
      return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'nest-overlay nest-archive-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Archived chats');

    // Header: back chevron + heading + count.
    var header = document.createElement('div');
    header.className = 'nest-overlay-header';
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'nest-overlay-back';
    back.title = 'Back';
    back.setAttribute('aria-label', 'Back');
    back.textContent = '‹'; // single left angle quote
    back.addEventListener('click', function () {
      closeArchiveOverlay(true);
    });
    header.appendChild(back);
    var heading = document.createElement('span');
    heading.className = 'nest-overlay-title';
    heading.textContent = 'Archived';
    header.appendChild(heading);
    var count = document.createElement('span');
    count.className = 'nest-archive-count';
    count.textContent = String(archivedRows.length);
    header.appendChild(count);
    overlay.appendChild(header);

    // A body wrapper the row list re-renders into (the search box stays put; the row list
    // and empty state swap under it on each keystroke).
    var bodyWrap = document.createElement('div');
    bodyWrap.className = 'nest-archive-wrap';
    overlay.appendChild(bodyWrap);

    document.body.appendChild(overlay);
    archiveOverlayEl = overlay;
    wireDialogFocusTrap(overlay);
    renderArchiveOverlayBody();
    back.focus();
  }

  // Rebuilds the overlay body under the header (note, search box, rows or empty state) on open, on each
  // keystroke and on a fresh 'archivedRows'. Restores focus to the search input if it had focus.
  function renderArchiveOverlayBody() {
    if (!archiveOverlayEl) {
      return;
    }
    // Keep the header count in sync with the full (unfiltered) archived set.
    var headerCount = archiveOverlayEl.querySelector('.nest-archive-count');
    if (headerCount) {
      headerCount.textContent = String(archivedRows.length);
    }
    var wrap = archiveOverlayEl.querySelector('.nest-archive-wrap');
    if (!wrap) {
      return;
    }
    var searchWasFocused =
      document.activeElement && document.activeElement.classList
        ? document.activeElement.classList.contains('nest-archive-search-input')
        : false;
    var caret = null;
    if (searchWasFocused) {
      var prev = wrap.querySelector('.nest-archive-search-input');
      caret = prev ? prev.selectionStart : null;
    }
    wrap.textContent = '';

    // The note under the heading.
    var note = document.createElement('div');
    note.className = 'nest-archive-note';
    note.textContent =
      'Chats kept past your archive window. Starred chats are never archived.';
    wrap.appendChild(note);

    // The gray-glow "Search archived" box: the gray focus ring is a distinct token
    // from the main orange glow (CSS .nest-archive-search-input:focus).
    var searchRow = document.createElement('div');
    searchRow.className = 'nest-archive-search';
    var icon = document.createElement('span');
    icon.className = 'nest-archive-search-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(searchGlyphGray());
    searchRow.appendChild(icon);
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'nest-archive-search-input';
    input.placeholder = 'Search archived';
    input.setAttribute('aria-label', 'Search archived chats');
    input.value = archiveSearchText;
    input.addEventListener('input', function () {
      archiveSearchText = normalizeQuery(input.value);
      renderArchiveOverlayBody();
    });
    input.addEventListener('keydown', function (ev) {
      // Escape in the box clears it first, then (if already empty) bubbles to close the
      // overlay via the document Escape handler; stop propagation only on the clear.
      if (ev.key === 'Escape' && input.value.length > 0) {
        ev.preventDefault();
        ev.stopPropagation();
        input.value = '';
        archiveSearchText = '';
        renderArchiveOverlayBody();
      }
    });
    searchRow.appendChild(input);
    wrap.appendChild(searchRow);

    // The scrolling row list.
    var listWrap = document.createElement('div');
    listWrap.className = 'nest-archive-list';
    var rows = filteredArchivedRows();
    if (rows.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'nest-empty';
      empty.textContent =
        archiveSearchText.length > 0
          ? 'No archived chats match your search.'
          : 'Nothing archived.';
      listWrap.appendChild(empty);
    } else {
      for (var i = 0; i < rows.length; i++) {
        listWrap.appendChild(makeArchivedRow(rows[i]));
      }
    }
    wrap.appendChild(listWrap);

    if (searchWasFocused) {
      var next = wrap.querySelector('.nest-archive-search-input');
      if (next) {
        next.focus();
        if (caret !== null && typeof next.setSelectionRange === 'function') {
          try {
            next.setSelectionRange(caret, caret);
          } catch (e) {
            // ignore
          }
        }
      }
    }
  }

  // One archived row: title, a folder and age line, export and Restore buttons. Labels are textContent
  // (untrusted). Restore clears userArchived and keeps the star; a click on the row body previews the copy.
  function makeArchivedRow(row) {
    var el = document.createElement('div');
    el.className = 'nest-archive-row';
    el.setAttribute('role', 'group');

    var textCol = document.createElement('button');
    textCol.type = 'button';
    textCol.className = 'nest-archive-row-text';
    // The row body previews the archived copy, so a cleaned-up chat stays reachable.
    textCol.setAttribute(
      'aria-label',
      'Preview archived chat ' + row.title,
    );
    textCol.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'previewArchivedChat', sessionId: row.sessionId });
    });
    var title = document.createElement('span');
    title.className = 'nest-archive-row-title';
    title.textContent = row.title;
    textCol.appendChild(title);
    var meta = document.createElement('span');
    meta.className = 'nest-archive-row-meta';
    var folderSpan = document.createElement('span');
    folderSpan.className = 'nest-archive-row-folder';
    folderSpan.textContent = row.folder || 'Unsorted';
    meta.appendChild(folderSpan);
    // The age dot . age (only when the chat is present and has an age; a cleaned-up chat
    // shows "copy only" instead so the row is not left with a bare folder).
    if (row.present && row.relativeTime && row.relativeTime.length > 0) {
      var sep = document.createElement('span');
      sep.className = 'nest-archive-row-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      meta.appendChild(sep);
      var age = document.createElement('span');
      age.className = 'nest-archive-row-age';
      age.textContent = row.relativeTime;
      meta.appendChild(age);
    } else if (!row.present) {
      var sep2 = document.createElement('span');
      sep2.className = 'nest-archive-row-sep';
      sep2.setAttribute('aria-hidden', 'true');
      sep2.textContent = '·';
      meta.appendChild(sep2);
      var copyOnly = document.createElement('span');
      copyOnly.className = 'nest-archive-row-age';
      copyOnly.textContent = 'copy only';
      meta.appendChild(copyOnly);
    }
    textCol.appendChild(meta);
    el.appendChild(textCol);

    // Starring an archived chat posts starUnarchive, which sets the star and clears userArchived, so the
    // chat returns to the list starred.
    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'nest-star nest-star-empty nest-archive-star';
    star.setAttribute('aria-label', 'Star and restore ' + row.title);
    star.textContent = '☆';
    star.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'starUnarchive', sessionId: row.sessionId });
    });
    el.appendChild(star);

    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'nest-archive-export';
    exportBtn.title = 'Export as Markdown';
    exportBtn.setAttribute('aria-label', 'Export ' + row.title + ' as Markdown');
    exportBtn.textContent = '⤓'; // downwards arrow to bar
    exportBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'exportChat', sessionId: row.sessionId, format: 'markdown' });
    });
    el.appendChild(exportBtn);

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'nest-archive-restore';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', 'Restore ' + row.title);
    restore.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'restoreChat', sessionId: row.sessionId });
    });
    el.appendChild(restore);
    return el;
  }

  // Gray magnifier glyph (currentColor) for the archive search box, distinct from the main search icon.
  function searchGlyphGray() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', '7');
    circle.setAttribute('cy', '7');
    circle.setAttribute('r', '5');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '1.6');
    svg.appendChild(circle);
    var line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', '10.8');
    line.setAttribute('y1', '10.8');
    line.setAttribute('x2', '14.5');
    line.setAttribute('y2', '14.5');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
    return svg;
  }

  // ---- drag and drop (in-process) ----

  function onRowDragStart(e, sessionId) {
    draggingChatIds = [sessionId];
    if (e.dataTransfer) {
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
    return Array.prototype
      .slice.call(listEl.querySelectorAll('[role="treeitem"]'))
      .filter((el) => !el.closest('.nest-fleet-group:not(.is-open) > .nest-fleet-body'));
  }

  // The live fleet row for a chat, or null. Rows come from the latest fleet message, so
  // the attachable flag is always the host's current answer.
  function fleetRowFor(sessionId) {
    if (!fleet) {
      return null;
    }
    const lists = [];
    if (fleet.orchestrator) {
      lists.push([fleet.orchestrator]);
    }
    const groups = (fleet.groups || []).concat(fleet.userFolders || []);
    if (fleet.pastOrchestrators) {
      groups.push(fleet.pastOrchestrators);
    }
    if (fleet.unsorted) {
      groups.push(fleet.unsorted);
    }
    for (const g of groups) {
      lists.push(g.rows || []);
    }
    for (const rows of lists) {
      for (const r of rows) {
        if (r.sessionId === sessionId) {
          return r;
        }
      }
    }
    return null;
  }

  function isAttachableChat(sessionId) {
    const row = fleetRowFor(sessionId);
    return !!row && row.attachable === true;
  }

  // The host re-checks attachable and falls back to a plain open, so this only chooses
  // which message to post.
  function activateRow(sessionId) {
    vscode.postMessage({ type: isAttachableChat(sessionId) ? 'openInTerminal' : 'open', sessionId });
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
    } else if (e.key === 'ArrowRight' && isRow && active.dataset.kind === 'fleet-group') {
      e.preventDefault();
      if (active.getAttribute('aria-expanded') === 'false') {
        toggleFleetGroup(active.dataset.groupId);
      } else {
        moveToFirstChild(active);
      }
    } else if (e.key === 'ArrowLeft' && isRow && active.dataset.kind === 'fleet-group') {
      e.preventDefault();
      if (active.getAttribute('aria-expanded') === 'true') {
        toggleFleetGroup(active.dataset.groupId);
      }
    } else if (e.key === 'ArrowLeft' && isRow && active.dataset.parentFleetGroup) {
      e.preventDefault();
      const entry = fleetGroupEls.get(active.dataset.parentFleetGroup);
      if (entry) {
        setFocus(entry.header);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && isRow && active.dataset.kind === 'fleet-group') {
      e.preventDefault();
      toggleFleetGroup(active.dataset.groupId);
    } else if (e.key === 'ArrowRight' && isRow) {
      e.preventDefault();
      const folderId = folderIdOf(active);
      if (folderId !== null) {
        if (active.getAttribute('aria-expanded') === 'false') {
          setCollapsed(folderId, false);
        } else {
          moveToFirstChild(active);
        }
      }
    } else if (e.key === 'ArrowLeft' && isRow) {
      e.preventDefault();
      const folderId = folderIdOf(active);
      if (folderId !== null && active.getAttribute('aria-expanded') === 'true') {
        setCollapsed(folderId, true);
      } else {
        const parent =
          active.dataset.kind === 'folder'
            ? parentFolderHeaderOf(active)
            : parentFolderHeaderById(active.dataset.parentFolderId);
        if (parent) {
          setFocus(parent);
        }
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && isRow) {
      e.preventDefault();
      if (active.dataset.kind === 'chat') {
        activateRow(active.dataset.id);
      } else if (active.dataset.kind === 'folder' && active.dataset.renameFolderId) {
        const nameEl = active.querySelector('.nest-folder-name');
        beginRename(active, active.dataset.renameFolderId, nameEl ? nameEl.textContent : '');
      }
    }
  });

  listEl.addEventListener('focus', () => {
    const rows = focusableRows();
    const entry = rows.find((r) => r.getAttribute('tabindex') === '0') || rows[0];
    if (entry) {
      entry.focus();
    }
  });

  // ---- search input ----

  // Posts the current text query to the host search. onFilterInput debounces it so typing does not
  // fire a query per keystroke.
  function postSearchQuery() {
    vscode.postMessage({ type: 'search', query: filterEl.value });
  }

  function cancelSearchDebounce() {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  }

  function onFilterInput() {
    textFilter = normalizeQuery(filterEl.value);
    if (searchClearEl) {
      searchClearEl.hidden = filterEl.value.length === 0;
    }
    // Re-render at once so the search box, chips and tag-only list stay responsive; text hits fill in when the
    // host reply lands. Clearing the box drops stale results immediately.
    if (textFilter.length === 0) {
      cancelSearchDebounce();
      searchResultsQuery = null;
      searchHitOrder = [];
      searchHitSnippets = new Map();
      render();
      // Tell the host the query is empty so it does not post late results for the
      // last non-empty query that would then be ignored anyway.
      postSearchQuery();
      return;
    }
    render();
    cancelSearchDebounce();
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      postSearchQuery();
    }, SEARCH_DEBOUNCE_MS);
  }

  function clearSearch() {
    filterEl.value = '';
    onFilterInput();
    filterEl.focus();
  }

  // ---- sort popover ----

  function isSortOpen() {
    return sortPopoverEl && !sortPopoverEl.hidden;
  }

  function openSort() {
    if (!sortPopoverEl) {
      return;
    }
    sortPopoverEl.hidden = false;
    if (sortBtnEl) {
      sortBtnEl.setAttribute('aria-expanded', 'true');
    }
    const active =
      sortPopoverEl.querySelector('.nest-popover-item[aria-checked="true"]') ||
      sortPopoverEl.querySelector('.nest-popover-item');
    if (active) {
      active.focus();
    }
  }

  function closeSort(restoreFocusToBtn) {
    if (!sortPopoverEl || sortPopoverEl.hidden) {
      return;
    }
    sortPopoverEl.hidden = true;
    if (sortBtnEl) {
      sortBtnEl.setAttribute('aria-expanded', 'false');
      if (restoreFocusToBtn) {
        sortBtnEl.focus();
      }
    }
  }

  function toggleSort() {
    if (isSortOpen()) {
      closeSort(true);
    } else {
      openSort();
    }
  }

  function applySort(mode) {
    sortMode = mode;
    if (sortPopoverEl) {
      for (const item of sortPopoverEl.querySelectorAll('.nest-popover-item')) {
        item.setAttribute('aria-checked', item.dataset.sort === mode ? 'true' : 'false');
      }
    }
    vscode.postMessage({ type: 'setState', sort: sortMode });
    render();
  }

  function wireSortPopover() {
    if (!sortBtnEl || !sortPopoverEl) {
      return;
    }
    sortBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSort();
    });
    const items = Array.prototype.slice.call(sortPopoverEl.querySelectorAll('.nest-popover-item'));
    items.forEach((item, i) => {
      item.addEventListener('click', () => {
        applySort(item.dataset.sort);
        closeSort(true);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          items[(i + 1) % items.length].focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          items[(i - 1 + items.length) % items.length].focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          applySort(item.dataset.sort);
          closeSort(true);
        }
      });
    });
    // Clicks inside the popover must not bubble to the document dismiss handler.
    sortPopoverEl.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => closeSort(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Escape closes an open Archive or Settings overlay first, returning focus to its trigger. The archive
        // search box handles its own Escape-to-clear before this.
        if (isArchiveOpen()) {
          closeArchiveOverlay(true);
          return;
        }
        if (isSettingsOpen()) {
          closeSettingsOverlay(true);
          return;
        }
        closeSort(isSortOpen());
        closeAllTransientOverlays();
        // Escape also drops an armed folder-row collapse (clearFolderToggleArm) so it cannot fire against an
        // abandoned tree.
        cancelPendingFolderToggle();
      }
    });
  }

  // ---- fleet layout ----

  // The latest host-posted fleet message (display-ready groups, rows and ARIA fields), or
  // null until the host posts one. While null, the panel draws only the original sections.
  let fleet = null;
  // Open state per group id: an explicit user choice. The Active projection forces live
  // groups open without touching this map, so turning Active off restores it.
  const groupOpen = new Map();
  // Open overrides while Active is on. Cleared whenever Active turns on or off.
  const activeOpen = new Map();
  let queueOpen = false;
  // What changed between the previous fleet message and the one being drawn. Set by the
  // message handler for exactly one render so only real changes animate.
  let fleetDiff = null;
  // The elements of the last fleet render, by group id, for in-place open and close.
  const fleetGroupEls = new Map();
  const MAX_SAVED_GROUPS = 500;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const activeBtnEl = document.getElementById('activeBtn');
  const activeLabelEl = document.getElementById('activeLabel');
  const queueBtnEl = document.getElementById('queueBtn');
  const queueLabelEl = document.getElementById('queueLabel');
  const queueListEl = document.getElementById('queueList');

  function svgEl(width, height, className, paths, circles) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    for (const c of circles || []) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(c[0]));
      circle.setAttribute('cy', String(c[1]));
      circle.setAttribute('r', String(c[2]));
      svg.appendChild(circle);
    }
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function saveFleetState() {
    const entries = Array.from(groupOpen.entries()).slice(-MAX_SAVED_GROUPS);
    try {
      vscode.setState({ fleetGroupOpen: entries, queueOpen: queueOpen });
    } catch (err) {
      // The saved copy is a convenience; the in-memory state is authoritative.
    }
  }

  function restoreFleetState() {
    let saved;
    try {
      saved = vscode.getState();
    } catch (err) {
      return;
    }
    if (!saved || typeof saved !== 'object') {
      return;
    }
    if (Array.isArray(saved.fleetGroupOpen)) {
      for (const entry of saved.fleetGroupOpen.slice(-MAX_SAVED_GROUPS)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') {
          groupOpen.set(entry[0], entry[1]);
        }
      }
    }
    queueOpen = saved.queueOpen === true;
  }

  // The groups the fleet layout draws, in order. User folders appear here only in the
  // Active projection; otherwise the folder tree below draws them.
  function fleetGroupsOf(f) {
    const out = [];
    if (!f) {
      return out;
    }
    if (f.pastOrchestrators) {
      out.push(f.pastOrchestrators);
    }
    for (const g of f.groups || []) {
      out.push(g);
    }
    if (f.active) {
      for (const g of f.userFolders || []) {
        out.push(g);
      }
    }
    if (f.unsorted) {
      out.push(f.unsorted);
    }
    return out;
  }

  // Whether a group is open under a given message. With nothing explicit, a group with a
  // live chat is open, and so is the newest group when nothing is live.
  function groupIsOpen(f, g) {
    if (f.active) {
      return activeOpen.has(g.id) ? activeOpen.get(g.id) : g.forceOpen === true;
    }
    if (groupOpen.has(g.id)) {
      return groupOpen.get(g.id);
    }
    if (g.hasLive) {
      return true;
    }
    const first = (f.groups || [])[0];
    return g === first && !(f.groups || []).some((x) => x.hasLive);
  }

  // A group that has shown live work stays open until the user closes it.
  function latchLiveGroups(f) {
    if (f.active) {
      return;
    }
    for (const g of fleetGroupsOf(f)) {
      if (g.hasLive && !groupOpen.has(g.id)) {
        groupOpen.set(g.id, true);
      }
    }
  }

  function rowSnapshot(f) {
    const status = new Map();
    const stage = new Map();
    const open = new Map();
    if (!f) {
      return { status: status, stage: stage, open: open };
    }
    const rows = [];
    if (f.orchestrator) {
      rows.push(f.orchestrator);
    }
    for (const g of fleetGroupsOf(f)) {
      for (const r of g.rows) {
        rows.push(r);
      }
      stage.set(g.id, { stage: g.stage, family: g.stageFamily, color: g.stageColor });
      open.set(g.id, groupIsOpen(f, g));
    }
    for (const r of rows) {
      status.set(r.sessionId, r.status);
    }
    return { status: status, stage: stage, open: open };
  }

  function diffFleet(prev, next) {
    if (!prev) {
      return null;
    }
    const before = rowSnapshot(prev);
    const after = rowSnapshot(next);
    const added = new Set();
    const done = new Set();
    for (const [id, status] of after.status) {
      if (!before.status.has(id)) {
        added.add(id);
      } else if (before.status.get(id) !== 'done' && status === 'done') {
        done.add(id);
      }
    }
    // Switching the Active projection moves whole groups; it is not a new row.
    const switched = prev.active !== next.active;
    if (switched) {
      added.clear();
      done.clear();
    }
    return {
      added: added,
      done: done,
      stage: before.stage,
      open: before.open,
      activeChanged: switched,
    };
  }

  function makeStatusMark(status, morph) {
    const slot = document.createElement('span');
    slot.className = 'nest-fleet-status';
    slot.setAttribute('aria-hidden', 'true');
    if (status === 'working') {
      const dot = document.createElement('span');
      dot.className = 'nest-fleet-dot nest-dot-working';
      slot.appendChild(dot);
    } else if (status === 'needs') {
      const q = document.createElement('span');
      q.className = 'nest-fleet-needs';
      q.textContent = '?';
      slot.appendChild(q);
    } else if (status === 'queued') {
      const dot = document.createElement('span');
      dot.className = 'nest-fleet-dot nest-dot-queued';
      slot.appendChild(dot);
    } else if (status === 'done') {
      slot.appendChild(svgEl(12, 12, 'nest-fleet-check', ['M2 6.5 5 9.5 10 3']));
      if (morph) {
        slot.classList.add('nest-morph');
      }
    } else {
      const dot = document.createElement('span');
      dot.className = 'nest-fleet-dot nest-fleet-dot-idle';
      slot.appendChild(dot);
    }
    return slot;
  }

  const PILL_FAMILIES = ['teal', 'orange', 'blue', 'green'];

  function applyPillColor(pill, family, color) {
    if (color) {
      const bg = hexToRgba(color, 0.15);
      if (bg) {
        pill.className = 'nest-pill nest-pill-custom';
        pill.style.setProperty('--pill-custom-bg', bg);
        pill.style.setProperty('--pill-custom-fg', color);
        return;
      }
    }
    pill.className = 'nest-pill nest-pill-' + (PILL_FAMILIES.indexOf(family) >= 0 ? family : 'blue');
  }

  // A stage pill. When the previous message had a different stage color family for the
  // same id, the pill starts in the old colors and moves to the new ones next frame, so
  // the colors cross-fade.
  function makeStagePill(text, family, color, before) {
    const pill = document.createElement('span');
    pill.textContent = text;
    const oldFamily =
      before && before.family && before.family !== family && !before.color && !color ? before.family : null;
    applyPillColor(pill, oldFamily || family, color);
    if (oldFamily) {
      requestAnimationFrame(() => requestAnimationFrame(() => applyPillColor(pill, family, color)));
    }
    return pill;
  }

  function makeAgentTag(row) {
    const tag = document.createElement('span');
    const kind = ['build', 'fix', 'qa', 'spike', 'review', 'capture'].indexOf(row.tagKind) >= 0 ? row.tagKind : 'review';
    tag.className = 'nest-agent-tag nest-agent-' + kind;
    tag.textContent = row.agentTag;
    return tag;
  }

  function setTreeitemAria(el, row) {
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(row.ariaLevel));
    el.setAttribute('aria-posinset', String(row.ariaPosInSet));
    el.setAttribute('aria-setsize', String(row.ariaSetSize));
    el.setAttribute('aria-label', row.ariaLabel);
    el.setAttribute('tabindex', '-1');
  }

  function wireFleetChat(el, row) {
    el.dataset.kind = 'chat';
    el.dataset.id = row.sessionId;
    if (activeId && row.sessionId === activeId) {
      el.classList.add('nest-active');
    }
    el.draggable = true;
    el.addEventListener('click', () => activateRow(row.sessionId));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatMenu(e, row.sessionId);
    });
    el.addEventListener('dragstart', (e) => onRowDragStart(e, row.sessionId));
    el.addEventListener('dragend', onDragEnd);
  }

  function makeOrchestratorCard(row) {
    const el = document.createElement('div');
    el.className = 'nest-fleet-orch';
    setTreeitemAria(el, row);
    wireFleetChat(el, row);
    el.appendChild(svgEl(14, 14, 'nest-fleet-orch-icon', ['M5 1.5h4l-.6 4 2.1 2H3.5l2.1-2L5 1.5ZM7 7.5v5']));
    const label = document.createElement('span');
    label.className = 'nest-fleet-orch-label';
    label.textContent = 'Orchestrator';
    el.appendChild(label);
    el.appendChild(makeStatusMark(row.status, false));
    return el;
  }

  function makeFleetChatRow(row, group) {
    const el = document.createElement('div');
    el.className = 'nest-fleet-chat' + (row.child ? ' nest-fleet-child' : '');
    setTreeitemAria(el, row);
    wireFleetChat(el, row);
    el.dataset.parentFleetGroup = group.id;
    if (fleetDiff && fleetDiff.added.has(row.sessionId)) {
      el.classList.add('nest-fleet-enter');
    }
    if (row.child) {
      const branch = document.createElement('span');
      branch.className = 'nest-fleet-branch';
      branch.setAttribute('aria-hidden', 'true');
      branch.textContent = '└';
      el.appendChild(branch);
    }
    el.appendChild(makeStatusMark(row.status, !!(fleetDiff && fleetDiff.done.has(row.sessionId))));
    if (row.agentTag) {
      el.appendChild(makeAgentTag(row));
    }
    const isTicket = group.kind === 'ticket';
    const text = isTicket ? row.suffix : row.title;
    if (text || (isTicket && !row.agentTag)) {
      const label = document.createElement('span');
      label.className = 'nest-fleet-chat-text' + (isTicket && row.suffix ? ' nest-fleet-suffix' : '');
      label.textContent = text || row.title;
      el.appendChild(label);
    }
    return el;
  }

  function makeFleetGroupHeader(g, open) {
    const el = document.createElement('div');
    const isPast = g.id === 'past-orchestrators';
    el.className = 'nest-fleet-group-row' + (isPast ? ' nest-fleet-past' : '');
    setTreeitemAria(el, g);
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.dataset.kind = 'fleet-group';
    el.dataset.id = 'fleet-group:' + g.id;
    el.dataset.groupId = g.id;
    el.appendChild(svgEl(12, 12, 'nest-fleet-chev', ['M4 2.5 7.5 6 4 9.5']));

    if (isPast) {
      const label = document.createElement('span');
      label.className = 'nest-fleet-group-text';
      label.textContent = g.label;
      el.appendChild(label);
    } else if (g.kind === 'ticket') {
      if (g.rollup) {
        el.appendChild(makeStatusMark(g.rollup, false));
      }
      const text = document.createElement('span');
      text.className = 'nest-fleet-group-text';
      const id = document.createElement('span');
      id.className = 'nest-fleet-ticket';
      id.textContent = g.ticket || g.label;
      text.appendChild(id);
      if (g.title) {
        text.appendChild(document.createTextNode(' ' + g.title));
      }
      el.appendChild(text);
      if (g.stage) {
        const before = fleetDiff && fleetDiff.stage.get(g.id);
        el.appendChild(makeStagePill(g.stage, g.stageFamily, g.stageColor, before));
      }
    } else {
      if (g.kind === 'date') {
        el.appendChild(svgEl(14, 14, 'nest-fleet-clock-icon', ['M7 4v3.2l2 1.3'], [[7, 7, 5.3]]));
      } else {
        el.appendChild(
          svgEl(15, 13, 'nest-fleet-folder-icon', [
            'M1.5 3V11a.8.8 0 0 0 .8.8h10.4a.8.8 0 0 0 .8-.8V4.6a.8.8 0 0 0-.8-.8H7L5.6 2.2H2.3a.8.8 0 0 0-.8.8Z',
          ]),
        );
      }
      const label = document.createElement('span');
      label.className = 'nest-fleet-group-text nest-fleet-label';
      label.textContent = g.label;
      el.appendChild(label);
      if (g.hasLive) {
        const live = document.createElement('span');
        live.className = 'nest-fleet-live';
        live.setAttribute('aria-hidden', 'true');
        el.appendChild(live);
      }
      const count = document.createElement('span');
      count.className = 'nest-fleet-count';
      count.setAttribute('aria-hidden', 'true');
      count.textContent = String(g.count);
      el.appendChild(count);
    }
    el.addEventListener('click', () => toggleFleetGroup(g.id));
    return el;
  }

  function renderFleetGroup(g) {
    const open = groupIsOpen(fleet, g);
    const wrap = document.createElement('div');
    wrap.className = 'nest-fleet-group';
    wrap.dataset.groupId = g.id;
    const header = makeFleetGroupHeader(g, open);
    wrap.appendChild(header);
    const body = document.createElement('div');
    body.className = 'nest-fleet-body';
    body.setAttribute('role', 'group');
    body.setAttribute('aria-label', g.label || g.ticket || '');
    const inner = document.createElement('div');
    inner.className = 'nest-fleet-body-inner';
    for (const row of g.rows) {
      inner.appendChild(makeFleetChatRow(row, g));
    }
    body.appendChild(inner);
    wrap.appendChild(body);
    if (fleetDiff && fleetDiff.activeChanged) {
      wrap.classList.add('nest-fleet-slide');
    }
    // Start in the previous open state and move to the new one next frame, so a change
    // slides instead of snapping.
    const was = fleetDiff && fleetDiff.open.has(g.id) ? fleetDiff.open.get(g.id) : open;
    wrap.classList.toggle('is-open', was);
    if (was !== open) {
      requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.toggle('is-open', open)));
    }
    fleetGroupEls.set(g.id, { wrap: wrap, header: header });
    listEl.appendChild(wrap);
  }

  function toggleFleetGroup(id) {
    const entry = fleetGroupEls.get(id);
    const g = fleetGroupsOf(fleet).find((x) => x.id === id);
    if (!entry || !g) {
      return;
    }
    const next = !groupIsOpen(fleet, g);
    if (fleet.active) {
      activeOpen.set(id, next);
    } else {
      groupOpen.set(id, next);
      saveFleetState();
    }
    entry.wrap.classList.toggle('is-open', next);
    entry.header.setAttribute('aria-expanded', next ? 'true' : 'false');
  }

  function fleetHasContent() {
    return (
      !!fleet &&
      (!!fleet.orchestrator ||
        !!fleet.pastOrchestrators ||
        (fleet.groups || []).length > 0 ||
        (fleet.active && (fleet.userFolders || []).length > 0) ||
        !!fleet.unsorted)
    );
  }

  // The fleet layout: the pinned orchestrator, past orchestrators, then the groups.
  function renderFleetLayout() {
    fleetGroupEls.clear();
    if (fleet.orchestrator) {
      listEl.appendChild(makeOrchestratorCard(fleet.orchestrator));
    }
    const all = fleetGroupsOf(fleet);
    const past = all.filter((g) => g.id === 'past-orchestrators');
    const rest = all.filter((g) => g.id !== 'past-orchestrators');
    for (const g of past) {
      renderFleetGroup(g);
    }
    if (fleet.orchestrator || past.length > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'nest-fleet-spacer';
      listEl.appendChild(spacer);
    }
    for (const g of rest) {
      renderFleetGroup(g);
    }
    if (!fleetHasContent()) {
      const empty = document.createElement('div');
      empty.className = 'nest-fleet-empty';
      empty.textContent = fleet.active ? 'Nothing is running.' : 'No chats yet.';
      listEl.appendChild(empty);
    }
  }

  function renderQueue() {
    if (!queueListEl || !queueBtnEl) {
      return;
    }
    queueBtnEl.setAttribute('aria-pressed', queueOpen ? 'true' : 'false');
    queueListEl.hidden = !queueOpen;
    queueListEl.textContent = '';
    if (!queueOpen || !fleet) {
      return;
    }
    const rows = fleet.queue || [];
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'nest-queue-empty';
      empty.textContent = 'The queue is empty.';
      queueListEl.appendChild(empty);
      return;
    }
    for (const q of rows) {
      const row = document.createElement('div');
      row.className = 'nest-queue-row';
      row.setAttribute('role', 'listitem');
      const dot = document.createElement('span');
      dot.className = 'nest-queue-dot';
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
      const pos = document.createElement('span');
      pos.className = 'nest-queue-pos';
      pos.textContent = String(q.position);
      row.appendChild(pos);
      const text = document.createElement('span');
      text.className = 'nest-queue-text';
      const key = document.createElement('span');
      key.className = 'nest-queue-key';
      key.textContent = q.key;
      text.appendChild(key);
      if (q.title) {
        text.appendChild(document.createTextNode(' ' + q.title));
      }
      row.appendChild(text);
      if (q.stage) {
        row.appendChild(makeStagePill(q.stage, q.stageFamily, q.stageColor, null));
      }
      queueListEl.appendChild(row);
    }
  }

  // The Active and Queue buttons mirror the latest fleet message.
  function renderFleetControls() {
    if (!fleet || !activeBtnEl || !queueBtnEl) {
      return;
    }
    activeBtnEl.hidden = false;
    queueBtnEl.hidden = false;
    activeBtnEl.setAttribute('aria-pressed', fleet.active ? 'true' : 'false');
    activeLabelEl.textContent = 'Active ' + fleet.activeCount;
    queueLabelEl.textContent = 'Queue ' + fleet.queueCount;
    renderQueue();
  }

  function isValidFleetMessage(msg) {
    return (
      msg &&
      msg.type === 'fleet' &&
      Array.isArray(msg.groups) &&
      Array.isArray(msg.userFolders) &&
      Array.isArray(msg.queue) &&
      typeof msg.activeCount === 'number' &&
      typeof msg.queueCount === 'number'
    );
  }

  function onFleetMessage(msg) {
    if (!isValidFleetMessage(msg)) {
      return;
    }
    fleetDiff = diffFleet(fleet, msg);
    if (fleet && fleet.active !== msg.active) {
      activeOpen.clear();
    }
    fleet = msg;
    latchLiveGroups(fleet);
    renderFleetControls();
    render();
    fleetDiff = null;
  }

  function onActiveClick() {
    const next = !(fleet && fleet.active);
    activeBtnEl.setAttribute('aria-pressed', next ? 'true' : 'false');
    vscode.postMessage({ type: 'setActive', active: next });
  }

  function onQueueClick() {
    queueOpen = !queueOpen;
    saveFleetState();
    renderQueue();
  }

  // ---- robin ----
  // The host decides the robin's state and posts it; mascot.js draws and animates it. This block
  // picks the theme and motion, redraws only when something the drawing shows changed, and stops
  // the animation while the panel is hidden.

  const robinSlotEl = document.getElementById('robinSlot');
  const robinLiveEl = document.getElementById('robinLive');
  const ROBIN_STATES = ['hatch', 'rotate', 'error', 'needs', 'worm', 'done', 'milestone', 'working', 'sleep', 'night', 'idle'];
  const ROBIN_PIXEL_PX = 3;
  const ROBIN_MAX_NOTES = 6;
  const mascot = window.NestMascot;
  const reducedMotionQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  let robinState = 'idle';
  let robinMsg = null;
  let robinHandle = null;
  let robinDrawnKey = null;
  let robinDrawnState = null;
  // Where the last drawing of robinDrawnState stopped, so a redraw resumes the scene, not replays it.
  let robinResumeAt = 0;
  // Set by the host when the sidebar view is collapsed or switched away, which does not flip document.hidden.
  let robinPanelHidden = false;

  function robinStill() {
    return !robinMsg || robinMsg.animations !== true || (reducedMotionQuery !== null && reducedMotionQuery.matches);
  }

  // Dark themes and high contrast dark use the dark palette; high contrast light keeps the light one.
  function robinDark() {
    const cls = document.body.classList;
    return (
      cls.contains('vscode-dark') ||
      (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light')) ||
      document.documentElement.getAttribute('data-theme') === 'dark'
    );
  }

  function stopRobin() {
    if (robinHandle) {
      robinResumeAt = robinHandle.elapsed();
      robinHandle.stop();
      robinHandle = null;
    }
  }

  function drawRobin() {
    if (!robinSlotEl || !mascot) {
      return;
    }
    const still = robinStill();
    robinSlotEl.setAttribute('data-state', robinState);
    robinSlotEl.setAttribute('data-motion', still ? 'still' : 'full');
    if (robinPanelHidden || document.hidden) {
      stopRobin();
      return;
    }
    const dark = robinDark();
    const key = JSON.stringify([robinMsg, robinState, still, dark]);
    if (key === robinDrawnKey && robinHandle) {
      return;
    }
    stopRobin();
    const msg = robinMsg || { speed: 0, workingCount: 0, noteBudget: 0, noteDelaysMs: [], noteMinMs: 0, noteSpreadMs: 0 };
    robinHandle = mascot.render(robinSlotEl, robinState, {
      dark,
      still,
      scale: ROBIN_PIXEL_PX,
      speed: msg.speed,
      workingCount: msg.workingCount,
      notes: { delays: msg.noteDelaysMs.slice(0, msg.noteBudget), minMs: msg.noteMinMs, spreadMs: msg.noteSpreadMs },
      startAt: robinState === robinDrawnState ? robinResumeAt : 0,
    });
    const svg = robinSlotEl.firstElementChild;
    if (svg) {
      svg.setAttribute('class', 'nest-robin-svg');
    }
    robinDrawnKey = key;
    robinDrawnState = robinState;
  }

  function isValidRobinMessage(msg) {
    return (
      msg &&
      msg.type === 'robin' &&
      ROBIN_STATES.indexOf(msg.state) !== -1 &&
      typeof msg.animations === 'boolean' &&
      typeof msg.noteMinMs === 'number' &&
      typeof msg.noteSpreadMs === 'number' &&
      typeof msg.noteBudget === 'number' &&
      Array.isArray(msg.noteDelaysMs) &&
      typeof msg.reducedHint === 'string' &&
      typeof msg.liveText === 'string'
    );
  }

  function onRobinVisibilityMessage(msg) {
    if (!msg || msg.type !== 'visibility' || typeof msg.visible !== 'boolean') {
      return;
    }
    robinPanelHidden = !msg.visible;
    drawRobin();
  }

  function onRobinMessage(msg) {
    if (!isValidRobinMessage(msg)) {
      return;
    }
    const changed = !robinMsg || robinMsg.state !== msg.state;
    const next = {
      state: msg.state,
      speed: msg.speed === 1 || msg.speed === 2 ? msg.speed : 0,
      workingCount: typeof msg.workingCount === 'number' ? Math.max(0, Math.min(Math.floor(msg.workingCount), ROBIN_MAX_NOTES)) : 0,
      animations: msg.animations,
      noteMinMs: Math.max(500, Math.min(msg.noteMinMs, 60000)),
      noteSpreadMs: Math.max(0, Math.min(msg.noteSpreadMs, 60000)),
      noteBudget: Math.max(0, Math.min(Math.floor(msg.noteBudget), ROBIN_MAX_NOTES)),
      noteDelaysMs: msg.noteDelaysMs
        .slice(0, ROBIN_MAX_NOTES)
        .map((n) => (typeof n === 'number' && n >= 0 && n <= 60000 ? n : 2500)),
    };
    while (next.noteDelaysMs.length < next.noteBudget) {
      next.noteDelaysMs.push(next.noteMinMs);
    }
    // The host may resend an identical message; redrawing would restart the scene and wipe notes in flight.
    if (robinMsg && JSON.stringify(robinMsg) === JSON.stringify(next)) {
      return;
    }
    robinMsg = next;
    robinState = msg.state;
    // A new state starts its scene from the beginning, even if it last showed before the panel hid.
    if (changed) {
      robinDrawnState = null;
      robinResumeAt = 0;
    }
    drawRobin();
    if (changed && robinLiveEl) {
      robinLiveEl.textContent = msg.liveText.slice(0, 60);
    }
  }

  drawRobin();
  document.addEventListener('visibilitychange', drawRobin);
  if (reducedMotionQuery && typeof reducedMotionQuery.addEventListener === 'function') {
    reducedMotionQuery.addEventListener('change', drawRobin);
  }
  // VS Code swaps the body theme class in place when the user changes the color theme.
  if (typeof MutationObserver === 'function') {
    const themeWatch = new MutationObserver(drawRobin);
    themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---- inbound host messages ----

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    if (msg.type === 'sections' && msg.sections) {
      // render() commits a pending rename, drops an armed toggle and closes overlays before clearing listEl.
      sections = msg.sections;
      // Drop any active tag filter whose tag no longer exists.
      const live = new Set((sections.tags || []).map((t) => t.tagId));
      for (const t of Array.from(activeTags)) {
        if (!live.has(t)) {
          activeTags.delete(t);
        }
      }
      // Drop collapsed-folder ids whose folder no longer exists so the persisted set
      // does not accumulate dead ids; re-persist only when it actually changed.
      const liveFolders = new Set((sections.folders || []).map((f) => f.folderId));
      let prunedCollapsed = false;
      for (const id of Array.from(collapsedFolders)) {
        if (!liveFolders.has(id)) {
          collapsedFolders.delete(id);
          prunedCollapsed = true;
        }
      }
      if (prunedCollapsed) {
        persistCollapsed();
      }
      renderChips();
      render();
    } else if (msg.type === 'state') {
      // render() owns the teardown before it clears listEl, as in the 'sections' handler.
      sortMode = msg.sort || 'newest';
      collapsedFolders.clear();
      if (Array.isArray(msg.collapsedFolders)) {
        for (const id of msg.collapsedFolders) {
          if (typeof id === 'string') {
            collapsedFolders.add(id);
          }
        }
      }
      if (sortPopoverEl) {
        for (const item of sortPopoverEl.querySelectorAll('.nest-popover-item')) {
          item.setAttribute('aria-checked', item.dataset.sort === sortMode ? 'true' : 'false');
        }
      }
      render();
    } else if (msg.type === 'fleet') {
      onFleetMessage(msg);
    } else if (msg.type === 'robin') {
      onRobinMessage(msg);
    } else if (msg.type === 'visibility') {
      onRobinVisibilityMessage(msg);
    } else if (msg.type === 'searchResults') {
      // Host search reply: adopt ids and snippets only when fresh for the query in the box (normalized like
      // textFilter); drop a stale one.
      const q = normalizeQuery(msg.query);
      if (!isFreshSearchReply(q, textFilter)) {
        return;
      }
      const rows = Array.isArray(msg.rows) ? msg.rows : [];
      const order = [];
      const snippets = new Map();
      for (const r of rows) {
        if (!r || typeof r.sessionId !== 'string') {
          continue;
        }
        order.push(r.sessionId);
        if (typeof r.snippet === 'string' && r.snippet.length > 0) {
          snippets.set(r.sessionId, r.snippet);
        }
      }
      searchResultsQuery = q;
      searchHitOrder = order;
      searchHitSnippets = snippets;
      // Only the flat results view depends on these; re-render if a text filter is
      // active (it is, since q === textFilter and q is non-empty here).
      if (textFilter.length > 0) {
        render();
      }
    } else if (msg.type === 'settings') {
      // Settings state: adopt the window and section toggles, then re-render the tree. An open overlay is not
      // rebuilt, since that would steal focus on every toggle; its controls are reconciled in place so a
      // host-side coercion still shows.
      if (typeof msg.autoArchiveWindowDays === 'number') {
        autoArchiveWindowDays = msg.autoArchiveWindowDays;
      }
      if (typeof msg.groupByOverride === 'string' && GROUP_BY_OPTIONS.some((o) => o.mode === msg.groupByOverride)) {
        groupByOverride = msg.groupByOverride;
      }
      if (typeof msg.robinAnimations === 'boolean') {
        robinAnimationsOn = msg.robinAnimations;
      }
      const sv = msg.sectionsVisible;
      if (sv && typeof sv === 'object') {
        sectionsVisible.starred = sv.starred !== false;
        sectionsVisible.questions = sv.questions !== false;
        sectionsVisible.folders = sv.folders !== false;
        sectionsVisible.unsorted = sv.unsorted !== false;
      }
      render();
      if (isSettingsOpen()) {
        reconcileOpenSettingsControls();
      }
    } else if (msg.type === 'organize') {
      organizeBusy = false;
      organizeState = coerceOrganize(msg);
      renderOrganize();
    } else if (msg.type === 'openSettings') {
      // The palette/view-title Settings command asked to open the in-panel overlay.
      openSettingsOverlay();
    } else if (msg.type === 'archivedRows') {
      // Archived rows for the overlay, sent after openArchive (the Archived row, the auto-archive toast or a
      // Restore). Adopt them and open or refresh the overlay.
      archivedRows = Array.isArray(msg.rows) ? msg.rows.filter(isArchivedRow) : [];
      openArchiveOverlay();
    } else if (msg.type === 'openArchive') {
      // The auto-archive toast's "Open Archive" (or a deferred open on 'ready') asked to
      // open the overlay; the rows arrive in the accompanying 'archivedRows' post, so this
      // just ensures the overlay is open (idempotent).
      openArchiveOverlay();
    } else if (msg.type === 'active') {
      // The host resolved the currently-open chat (best-effort tab-label match). Re-tint
      // in place without a full re-render: clear the old tint, apply the new one.
      const next = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      if (next === activeId) {
        return;
      }
      activeId = next;
      for (const el of listEl.querySelectorAll('.nest-row.nest-active, .nest-fleet-chat.nest-active, .nest-fleet-orch.nest-active')) {
        el.classList.remove('nest-active');
      }
      if (activeId) {
        for (const el of listEl.querySelectorAll('.nest-row, .nest-fleet-chat, .nest-fleet-orch')) {
          if (el.dataset.id === activeId) {
            el.classList.add('nest-active');
          }
        }
      }
    }
  });

  // ---- relative time (mirrors src/views/relativeTime.ts buckets, webview-local) ----

  function relative(ts) {
    if (ts === null || ts === undefined) {
      return '';
    }
    const diff = Date.now() - ts;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;
    if (diff < min) {
      return 'now';
    }
    if (diff < hour) {
      return Math.floor(diff / min) + 'm';
    }
    if (diff < day) {
      return Math.floor(diff / hour) + 'h';
    }
    if (diff < week) {
      return Math.floor(diff / day) + 'd';
    }
    if (diff < month) {
      return Math.floor(diff / week) + 'w';
    }
    if (diff < 12 * month) {
      return Math.floor(diff / month) + 'mo';
    }
    return Math.floor(diff / (12 * month)) + 'y';
  }

  // ---- wire the toolbar ----

  filterEl.addEventListener('input', onFilterInput);
  if (searchClearEl) {
    searchClearEl.addEventListener('click', clearSearch);
  }
  if (newSessionEl) {
    newSessionEl.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  }
  if (settingsEl) {
    // The gear opens Settings client-side; its controls are seeded from the last 'settings' message.
    settingsEl.addEventListener('click', () => openSettingsOverlay());
  }
  wireSortPopover();
  if (activeBtnEl) {
    activeBtnEl.addEventListener('click', onActiveClick);
  }
  if (queueBtnEl) {
    queueBtnEl.addEventListener('click', onQueueClick);
  }
  restoreFleetState();

  vscode.postMessage({ type: 'ready' });
})();
