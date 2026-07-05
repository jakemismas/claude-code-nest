// The PRIMARY org-panel webview script. Renders the host-assembled section model
// (Starred, Questions heuristic, the folder hierarchy with per-folder color,
// Unsorted, and the bottom Archived row) as an ARIA tree, supports tag filter
// chips, sort via a popover, folder rename, folder color, drag-and-drop that posts
// a self-describing drop message the host maps to the unchanged pure reducer, full
// keyboard navigation, and a title filter.
//
// Sprint 3 slice s3a-design-shell (issue #80) re-skins the shell to the design
// handoff (media/design/, UI-SPEC.md): the New session pill, the gear, the sort
// POPOVER (replacing the native select), the search box with a clear button, the
// FOLDERS header + / ^ buttons, and the Archived (N) row. Density is removed (the
// design has a single row density). Content-search mode is not surfaced this slice
// (the AC permits title-filtering until the search slice); the host's content-search
// plumbing stays intact for that later slice.
//
// Accessibility is an ACCEPTANCE CRITERION, not polish (UI-SPEC.md deviation 5): the
// list is role="tree" with role="treeitem" rows grouped under role="group"
// sections, a single roving tabindex, arrow-key navigation, Enter/Space activation,
// and a visible focus ring (CSS). The new sort popover and the toolbar buttons
// (New session, gear, sort) are keyboard operable with focus handling and
// aria-labels so the ARIA story does not regress.
(function () {
  const vscode = acquireVsCodeApi();

  // The 8-color handoff palette (media/design/README.md line 98; the tag AND folder
  // color choices). Used by the in-panel folder color-swatch picker (issue #82 AC2),
  // which replaces the native <input type=color>. These are compile-time literals; a
  // chosen value is still re-validated at the host boundary (orgPanelWebview coerce ->
  // isValidColor) before it can reach any style sink.
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

  // The latest host-posted section model. allTags is the FULL project tag list (every
  // tag with id/label/color/count), distinct from tags (the filter-chip row, which omits
  // zero-chat tags); the chat context menu (issue #85 AC #1) lists allTags so a zero-chat
  // tag can still be checked/toggled.
  let sections = { starred: [], questions: [], folders: [], tags: [], allTags: [], archivedCount: 0 };
  // The set of active tag-id filters (AND across selected chips: a row must carry
  // every selected tag to show).
  const activeTags = new Set();
  // The current text filter (normalized: trimmed + lowercased). Text MATCHING is
  // HOST-side (the MiniSearch content index over titles + on-demand bodies): the
  // client posts { type:'search', query } and the host replies with { type:
  // 'searchResults' }; the client never re-implements a text index (ARCHITECTURE.md
  // "search-index location": the index is HOST-ONLY, in globalStorage or memory,
  // never synced, never under ~/.claude/projects).
  let textFilter = '';

  // The host content-search results for the CURRENT text query. searchHitSnippets
  // maps sessionId -> the host snippet (a role-prefixed body-match snippet, or null
  // on a title match, issue #83 AC #1); searchHitOrder is the host-ranked id list;
  // searchResultsQuery is the normalized query those results correspond to, so a
  // late reply for a stale query is ignored (the host posts twice per query as the
  // two-phase warm-then-body index refines, and keystrokes can interleave). Text
  // hits are trusted ONLY when searchResultsQuery === textFilter.
  let searchHitSnippets = new Map();
  let searchHitOrder = [];
  let searchResultsQuery = null;

  // The debounce timer for the outbound { type:'search' } post (issue #83 AC #4:
  // typing stays responsive; the query post is debounced while a chip toggle stays
  // immediate). Cleared and re-armed on each keystroke.
  let searchDebounceTimer = null;
  const SEARCH_DEBOUNCE_MS = 140;

  // Sort, hydrated from the host's persisted state on 'state'.
  let sortMode = 'newest';

  // The collapsed-folder id set (issue #64), seeded from the host's persisted state
  // on 'state' and posted back via setState whenever it changes. A folder id here
  // renders its header with aria-expanded="false", hides its role="group" body, and
  // hides every descendant folder section so the hidden rows are never in the DOM
  // (so they cannot receive the roving tabindex). Workspace-local and never synced.
  const collapsedFolders = new Set();

  // The dragged chat ids for an in-flight in-panel drag (fully in-process; the drop
  // posts these straight to the host). Cleared on dragend.
  let draggingChatIds = [];

  // The currently-open chat's sessionId (best-effort tab-label match, posted by the
  // host as an 'active' message). Its row gets the .nest-active tint, the ONLY row
  // highlight (starred rows are NOT tinted; UI-SPEC.md deviation 4). null tints no row.
  let activeId = null;

  // The roving-tabindex focus target: the dataset.id of the row that holds the
  // single tabindex="0". Kept stable across re-renders by id when possible.
  let focusedId = null;

  // ---- Settings overlay (slice s3b-settings-overlay, issue #86) ----

  // The auto-archive window in DAYS (0 = Never), hydrated from the host 'settings'
  // message. Persisted on workspaceState by the host; the client only reflects and
  // posts it. The allowed values mirror autoArchivePolicy.AUTO_ARCHIVE_WINDOW_DAYS.
  let autoArchiveWindowDays = 30;
  const AUTO_ARCHIVE_OPTIONS = [
    { days: 7, label: '7 days' },
    { days: 14, label: '14 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: '1 year' },
    { days: 0, label: 'Never archive' },
  ];

  // The four section-visibility toggles (all ON by default, AC #3). Client-side
  // render gates only: hiding a section never removes a chat from the model, and
  // search + chips still reach every chat, so no chat is ever made unreachable.
  const sectionsVisible = { starred: true, questions: true, folders: true, unsorted: true };

  // The Settings overlay element (body-of-panel position:absolute;inset:0), or null
  // when closed. Unlike the click-dismiss popovers it is a persistent sub-page: it
  // stays open until the back chevron or Escape, so it is tracked separately from the
  // transient-overlay close-set. settingsReturnFocusEl restores focus to the gear on
  // close.
  let settingsOverlayEl = null;
  let settingsReturnFocusEl = null;

  // ---- rich hover preview card (slice s3b-hover-card, issue #84) ----

  // The floating 270px card element (body-level, position:fixed) or null when no
  // card is open. previewSessionId is the chat the open card is for; previewHideTimer
  // is the 130ms leave-delay timer that keeps the card up while the pointer travels to
  // it (issue #84 AC #2); previewFromKeyboard is true when the card was opened by a
  // keystroke on the focused row, so Escape restores focus to that row (issue #84
  // AC #5). Body lines are fetched on demand from the host (previewBody message) for
  // this one chat and are NEVER stored anywhere but the card DOM the close tears down
  // (issue #84 AC #3).
  const PREVIEW_LEAVE_DELAY_MS = 130;
  const PREVIEW_WIDTH = 270;
  let previewEl = null;
  let previewSessionId = null;
  let previewHideTimer = null;
  let previewFromKeyboard = false;

  // Convert a strict #rrggbb hex color to an rgba() string at the given alpha. Used
  // for the tag-pill @15% background and the active-chip @15%/@45% background/border
  // (design README). Computed here rather than via CSS color-mix(), which needs
  // Chromium 111+ and would be INVALID on the engines floor (VS Code 1.66 ships
  // Chromium 98). Colors reaching here are already validated to #rrggbb at the store
  // normalize boundary (schema.isValidColor); a non-matching value returns null so
  // the caller keeps the CSS fallback tint.
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
          // Active chip: color @15% background, color @45% border (design README
          // line 36), computed as rgba() so no CSS color-mix() is needed.
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

  // The CLIENT-side filter is the tag AND-filter only: a row must carry every
  // selected tag. TEXT matching is HOST-side (searchHit* above), joined in
  // renderFiltered, so this is not consulted for text; it gates the sectioned
  // tree's per-section visibility and the tag-only flat view. A row with no active
  // tag filter always passes here.
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

  // Whether any tag chip or text filter is active. When filtering, the sectioned
  // list is replaced by a flat "N RESULTS" list (design README line 47).
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

  // Build one chat row (role="treeitem"). Draggable; double-click is reserved for
  // folder rename, so a row's activation is a single click / Enter / Space. opts may
  // carry showSnippet (search/filter results show the body-match snippet beneath) and
  // showBreadcrumb (Questions + search results show the folder-path breadcrumb).
  function makeRow(row, depth, opts) {
    const el = document.createElement('div');
    el.className = 'nest-row';
    // The active row (currently-open chat) is the ONLY tint; starred rows are NOT
    // tinted (design README line 57). Best-effort tab-label match from the host.
    if (activeId && row.sessionId === activeId) {
      el.classList.add('nest-active');
    }
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-label', rowAriaLabel(row));
    el.setAttribute('tabindex', '-1');
    el.dataset.kind = 'chat';
    el.dataset.id = row.sessionId;
    // Depth indents: top-level 11px, subfolder child 29px, deeper 47px (design README
    // line 50; step 18). Base 11 keeps the row's status glyph aligned with the design.
    el.style.paddingLeft = 11 + depth * 18 + 'px';
    el.draggable = true;

    const main = document.createElement('div');
    main.className = 'nest-row-main';

    // The left status slot (design README line 51): a solid dot for status 'done'
    // or a blinking '?' badge for status 'question'. Always present (even when
    // empty) so titles align down the column. The meaning rides the aria-label; the
    // glyph is decorative.
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

    // Folder breadcrumb (Questions and search/filter results only), muted, on the
    // right of the title (design README lines 42, 54). Rendered only when the caller
    // asks for it AND the chat is filed (row.breadcrumb non-null).
    if (opts && opts.showBreadcrumb && row.breadcrumb) {
      const crumb = document.createElement('span');
      crumb.className = 'nest-row-breadcrumb';
      crumb.textContent = row.breadcrumb;
      main.appendChild(crumb);
    }

    if (row.tags && row.tags.length > 0) {
      const tagRow = document.createElement('span');
      tagRow.className = 'nest-row-tags';
      for (let i = 0; i < row.tags.length; i++) {
        const t = document.createElement('span');
        t.className = 'nest-tag';
        const tagColor = row.tagColors && row.tagColors[i];
        if (tagColor) {
          t.style.setProperty('--tag-color', tagColor);
          // Tag pill @15% background (design README line 54), computed as rgba() so
          // no CSS color-mix() is needed on the engines floor.
          const bg = hexToRgba(tagColor, 0.15);
          if (bg) {
            t.style.background = bg;
          }
        }
        t.textContent = row.tags[i];
        tagRow.appendChild(t);
      }
      main.appendChild(tagRow);
    }

    const time = document.createElement('span');
    time.className = 'nest-row-time';
    time.textContent = relative(row.timestamp);
    main.appendChild(time);

    // Star affordance: filled accent star when starred, hollow muted star otherwise
    // (design README line 56). Clicking toggles it and persists immediately through the
    // store (the host routes it to the star/unstar curation commands). A <button> so it
    // is independently keyboard-focusable and screen-reader labelled; its click is
    // stopped from bubbling to the row's open handler.
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
    // Right-click a chat row to open its context menu (issue #85): tag toggles, create
    // tag, export, archive. The row model carries everything the menu needs (tagIds,
    // starred); a fresh sections model may replace this row object, so the menu resolves
    // the LIVE row by sessionId on open rather than closing over this stale one.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatMenu(e, row.sessionId);
    });
    el.addEventListener('dragstart', (e) => onRowDragStart(e, row.sessionId));
    el.addEventListener('dragend', onDragEnd);
    // Rich hover card (issue #84): entering the row opens the card near the cursor;
    // leaving arms the 130ms delayed close so the pointer can travel onto the card.
    // A drag in progress suppresses the card (the prototype clears hoverId on
    // dragstart) so a floating card never fights the drop UI.
    el.addEventListener('mouseenter', (e) => {
      if (draggingChatIds.length > 0) {
        return;
      }
      openPreview(row, e.clientX, e.clientY, false);
    });
    el.addEventListener('mouseleave', schedulePreviewClose);
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

  // Build a cross-cutting section header (Starred, Questions): a bare muted uppercase
  // label. The design authority (media/design/ChatSidebar.dc.html lines 117, 138 and
  // the frozen media/design/reference/prototype-320.png) draws these headers with NO
  // count and NO badge, matching the FOLDERS and UNSORTED labels; do not add either.
  function makeSectionHeader(text) {
    const header = document.createElement('div');
    header.className = 'nest-section-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'nest-section-label';
    labelEl.textContent = text;
    header.appendChild(labelEl);
    return header;
  }

  // Render a flat cross-cutting section (Starred / Questions). Hidden entirely when
  // it has no visible rows (UI-SPEC). opts is passed through to makeRow (Questions
  // rows carry showBreadcrumb per the design).
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

  // Render one folder section (a header plus a role="group" of rows). A folder
  // section is a DROP TARGET: dropping chats onto it files them there (or unfiles on
  // the synthetic Unsorted bucket). A REAL folder header is double-click renameable,
  // right-click recolorable, and collapsible; the synthetic Unsorted catch-all is a
  // plain drop-target label.
  function renderFolderSection(folder) {
    const { folderId, name, color, depth, synthetic } = folder;
    const visible = sortRows((folder.rows || []).filter(rowMatches));
    const collapsed = !synthetic && collapsedFolders.has(folderId);

    if (synthetic) {
      // UNSORTED: a plain uppercase section label that is also a drop target.
      const header = document.createElement('div');
      header.className = 'nest-unsorted-header';
      header.textContent = name;
      header.dataset.dropFolderId = folderId;
      attachDropTarget(header, folderId);
      listEl.appendChild(header);
    } else {
      // The header count is the rolled-up count (chats in this folder + all its
      // subfolders; design README line 66, issue #82 AC1), a stable structural count
      // from the model, NOT the post-filter visible.length. Folder headers render
      // only in the unfiltered tree (filtering swaps to the flat results list), so
      // the unfiltered rollup is the right number. Fall back to the visible count
      // only if the model did not supply one (older host).
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
    // Real folders nest their chats one level under the folder HEADER (depth + 1: a
    // top-level folder's chats sit at the 29px child indent). The synthetic Unsorted
    // bucket has NO header row to nest under; its chats are unparented, top-level rows
    // and must align with the Starred/Questions rows at the 11px top-level indent
    // (design README line 50). So render synthetic-bucket rows at the bucket's own
    // depth (0), not depth + 1.
    const rowDepth = synthetic ? depth : depth + 1;
    for (const row of visible) {
      const rowEl = makeRow(row, rowDepth);
      rowEl.dataset.parentFolderId = folderId;
      group.appendChild(rowEl);
    }
    attachDropTarget(group, folderId);
    listEl.appendChild(group);
  }

  // A real folder header row: chevron, colored folder glyph, name, count. It is a
  // navigable, actionable, collapsible treeitem (role="treeitem", aria-level,
  // aria-expanded). Enter/Space opens rename; double-click renames; right-click
  // opens the folder actions menu; the chevron toggles collapse.
  function makeFolderHeader(folder, collapsed, count) {
    const { folderId, name, color, depth } = folder;
    const header = document.createElement('div');
    header.className = 'nest-folder-row';
    // Depth indents match the chat rows: top-level 11px, subfolder 29px (design README
    // line 50; step 18).
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
    chevron.textContent = collapsed ? '▸' : '▾';
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      // The chevron toggles immediately (it is the disclosure control, not a rename
      // target). Cancel any armed row toggle first so a pending deferred toggle does
      // not fire a second time right after this one.
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

    // Collapse toggles on a plain header-row click (issue #82 AC2, design README
    // line 63), in addition to the chevron and keyboard ArrowLeft/Right. The click
    // is DEFERRED by a double-click window (onFolderRowClick) so it does not race the
    // double-click rename: without the defer, the first click of a double-click would
    // toggle collapse, re-render the tree (listEl.textContent = ''), detach this
    // header, and the dblclick would never open rename. A dblclick cancels the armed
    // toggle and opens rename instead.
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

  // The colored rounded-folder SVG glyph (fill = folder color), matching the design.
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
  // buttons (design README line 44).
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

  // The bottom Archived (N) row, shown only when any chat is archived. Opens the
  // interim Archive view (the in-panel Archive overlay lands in s3b).
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
    btn.addEventListener('click', () => vscode.postMessage({ type: 'openArchive' }));
    listEl.appendChild(btn);
  }

  function renderEmpty(message) {
    const empty = document.createElement('div');
    empty.className = 'nest-empty';
    empty.textContent = message;
    listEl.appendChild(empty);
  }

  // The default render: cross-cutting sections then the folder hierarchy, plus the
  // Archived row. When a filter is active, a flat "N RESULTS" list replaces the
  // sectioned view (design README line 47).
  function render() {
    // render() is the SINGLE choke point for every tree re-render: it is the only
    // site that clears listEl, and all re-render paths (the inbound 'sections'/'state'
    // handlers, the deferred folder-collapse timer, collapse-all/one, search, and the
    // keyboard collapse) funnel through it. Clearing listEl detaches the in-list
    // rename input and orphans the body-level position:fixed overlays (color picker,
    // new-folder popover, folder actions menu), which would otherwise float at a stale
    // point while their captured-closure buttons post mutations for a folderId this
    // render may have recolored, renamed, or deleted. So teardown lives HERE, once, and
    // no caller can reintroduce the orphan/dropped-rename gap: commit any in-progress
    // rename (its input dies with listEl and removing a focused node does not fire
    // blur), drop any armed deferred toggle whose target node is being replaced, and
    // close all transient overlays. Order: commit the rename before the overlays close
    // so a rename begun from the folder menu is not lost when the menu is removed.
    commitPendingRename();
    cancelPendingFolderToggle();
    closeAllTransientOverlays();
    listEl.textContent = '';
    listEl.dataset.mode = 'tree';

    if (isFiltering()) {
      renderFiltered();
      restoreFocus();
      return;
    }

    const total =
      sections.starred.length +
      sections.questions.length +
      sections.folders.reduce((n, f) => n + f.rows.length, 0);
    if (total === 0 && (!sections.archivedCount || sections.archivedCount <= 0)) {
      renderEmpty('No Claude Code chats found for this workspace yet.');
      return;
    }

    // Section-visibility gates (issue #86 AC #3): each toggle hides only the SECTION's
    // rendering; the model, search, and chips are untouched, so a hidden section's
    // chats stay reachable via search and the tag chips. Starred/Questions also hide
    // when empty (unchanged). Folders hidden -> skip the FOLDERS header and every real
    // folder; Unsorted hidden -> skip the synthetic Unsorted bucket. Disabling Unsorted
    // can never strand an unfiled chat: it remains reachable through search/chips (and
    // through any other section it also belongs to).
    if (sectionsVisible.starred) {
      renderCrossCuttingSection('Starred', sections.starred);
    }
    if (sectionsVisible.questions) {
      renderCrossCuttingSection('Questions', sections.questions, { showBreadcrumb: true });
    }

    renderFolderTree();

    renderArchivedRow();
    restoreFocus();
  }

  // Render the FOLDERS header and the folder tree, honoring the Folders and Unsorted
  // section-visibility toggles. Split out of render() so the gating reads cleanly; the
  // collapse/hide bookkeeping is unchanged.
  function renderFolderTree() {
    const showFolders = sectionsVisible.folders;
    const showUnsorted = sectionsVisible.unsorted;
    // The FOLDERS header belongs to the real folder tree; hide it when Folders is off.
    // When ONLY Unsorted is on (Folders off), the synthetic Unsorted bucket still
    // renders below without a FOLDERS header, matching "Unsorted is the always-present
    // catch-all" while respecting the Folders toggle.
    if (showFolders) {
      renderFoldersHeader();
    }
    // The folders array is a pre-order flattening. When a folder is collapsed we
    // skip every following entry whose depth is greater than the collapsed folder's
    // depth, so the whole collapsed subtree (rows and descendant folder sections) is
    // omitted from the DOM. This uses the TRUE structural depth (treeDepth), not the
    // clamped render depth: two legacy folders can both clamp to render depth 2, but
    // their treeDepths differ, so a collapsed clamped-deep folder still hides its
    // clamped-deep descendants. Falls back to the clamped depth if the model did not
    // supply treeDepth (older host).
    const depthOf = (f) => (typeof f.treeDepth === 'number' ? f.treeDepth : f.depth);
    let hideDeeperThan = Infinity;
    for (const folder of sections.folders) {
      // The synthetic Unsorted bucket is gated by the Unsorted toggle; the real
      // folders by the Folders toggle. A folder skipped by its toggle contributes
      // nothing to the collapse bookkeeping (it and its subtree are simply not drawn).
      if (folder.synthetic) {
        if (showUnsorted) {
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

  // Build a sessionId -> row lookup over every section (Starred, Questions, and each
  // folder's rows), first-seen wins. The SAME chat appears in several sections (a
  // starred, filed, question chat is in all three); we want one row object carrying
  // its tags/status/breadcrumb/star to resolve a host text hit against.
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

  // MIRROR of src/views/orgPanelInteractions.ts normalizeQuery: the ONE way both the
  // outbound text filter and the inbound search-reply compare normalize a query
  // (trim then lowercase), so a reply the host echoes compares equal to the stored
  // textFilter for the same input. Kept name-identical to the kernel so the parity
  // test can pin that the webview uses it.
  function normalizeQuery(raw) {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  }

  // MIRROR of src/views/orgPanelInteractions.ts isFreshSearchReply: a reply for
  // replyQuery is trusted only when it matches the current non-empty textFilter; an
  // empty filter trusts nothing and a mismatch is a superseded reply to drop.
  function isFreshSearchReply(replyQuery, currentTextFilter) {
    if (currentTextFilter.length === 0) {
      return false;
    }
    return normalizeQuery(replyQuery) === currentTextFilter;
  }

  // Whether the host content-search results in hand correspond to the current text
  // query. A late reply for a stale query (the host posts twice per query as its
  // two-phase index refines, and keystrokes interleave) is not trusted. Delegates to
  // the shared freshness mirror so the render side and the inbound-message side use
  // one rule (searchResultsQuery is already normalized when stored).
  function haveFreshTextResults() {
    return isFreshSearchReply(searchResultsQuery, textFilter);
  }

  // MIRROR of src/views/orgPanelInteractions.ts joinTextHits: intersect the host-
  // ranked ids with the client tag filter, dedupe (first occurrence wins), collect
  // each non-empty host snippet, then apply the panel sort (host rank -> membership,
  // sort -> order). Returns { rows, snippets }. Kept name/shape-aligned with the
  // kernel the unit test pins.
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

  // The flat filtered view: a "N RESULTS" label then the flat matching rows, with a
  // body-match snippet and a folder breadcrumb. Two combine modes (issue #83):
  //   - TEXT present: the result set is the HOST text-hit ids (searchHitOrder)
  //     intersected with the CLIENT tag AND-filter (rowMatches). Row content comes
  //     from the client section row; the snippet is the HOST snippet for that id
  //     (null on a title match -> no snippet row). Text is host-only, tags are
  //     client-side, the combined result is one flat list.
  //   - TAG-ONLY (chips, no text): the existing pure client-side tag-AND flat view,
  //     unchanged (no host round-trip).
  // The bottom "Archived (N)" row renders in this view too, matching the handoff
  // (media/design/ChatSidebar.dc.html: the Archived block is a sibling after both
  // the filtering and non-filtering blocks).
  function renderFiltered() {
    const withText = textFilter.length > 0;
    let visible = [];
    // rowSnippets carries the per-row snippet to show (host snippet on a text
    // match). Keyed by sessionId; absent -> no snippet row.
    const rowSnippets = new Map();

    if (withText) {
      // Host text hits joined with the client tag filter, in host rank order, then
      // sorted by the panel's sort control (design README "Sort applies to every
      // list"): host rank decides MEMBERSHIP, the chosen sort decides ORDER. The
      // join/dedup/snippet-collect + sort is the shared joinTextHits mirror. Only a
      // FRESH host reply is joined; a stale/absent reply yields an empty set.
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
      // Tag-only flat view: pure client-side, unchanged from the prior slice.
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
    labelEl.textContent = visible.length + ' RESULTS';
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
        // A body-match snippet OVERRIDES the row's tier-A snippet; a title match (or
        // tag-only) shows none. Pass it through a shallow row copy so makeRow's
        // row.snippet contract is untouched and the section row object is not mutated.
        const rowForRender = snip ? Object.assign({}, row, { snippet: snip }) : row;
        group.appendChild(
          makeRow(rowForRender, 0, { showSnippet: !!snip, showBreadcrumb: true }),
        );
      }
      listEl.appendChild(group);
    }

    // The Archived (N) row is present in the filtered view too (handoff parity).
    renderArchivedRow();
  }

  // The card's folder label: the row's folder-path breadcrumb, or 'Unsorted' when the
  // chat is unfiled (breadcrumb null), matching the prototype (folderPath || 'Unsorted').
  function previewFolderLabel(row) {
    return row.breadcrumb && row.breadcrumb.length > 0 ? row.breadcrumb : 'Unsorted';
  }

  // The card's token label. The row seam carries the host's '~NNk tokens' badge; the
  // design card shows the compact 'NNk tok' form (README line 53). Trim the trailing
  // 'tokens' word to 'tok' for display WITHOUT a second host read (issue #84 patch:
  // tokens on the card come from the row model already on the client). Empty when the
  // chat recorded no usage, so the meta line drops the token segment rather than
  // showing a bare 'tok'.
  function previewTokensLabel(row) {
    var t = typeof row.tokens === 'string' ? row.tokens.trim() : '';
    if (t.length === 0) {
      return '';
    }
    return t.replace(/\s*tokens?$/i, ' tok');
  }

  // Open (or move) the rich hover card for a row. Builds the card from the row/section
  // model already on the client (title, folder, age, tokens, tags) and requests the two
  // body lines from the host on demand (previewBody). x/y anchor the card near the
  // cursor (hover) or the row (keyboard). fromKeyboard drives the Escape focus-restore.
  // The card is a body-level position:fixed node; every content sink is textContent
  // (never innerHTML), the s3a render-site security class (issue #84 AC #5).
  function openPreview(row, x, y, fromKeyboard) {
    clearPreviewHideTimer();
    if (!row) {
      return;
    }
    closePreview(false);
    previewSessionId = row.sessionId;
    previewFromKeyboard = !!fromKeyboard;

    var card = document.createElement('div');
    card.className = 'nest-preview-card';
    card.setAttribute('role', 'tooltip');

    var titleEl = document.createElement('div');
    titleEl.className = 'nest-preview-title';
    titleEl.textContent = row.title;
    card.appendChild(titleEl);

    var meta = document.createElement('div');
    meta.className = 'nest-preview-meta';
    var metaParts = [previewFolderLabel(row), relative(row.timestamp)];
    var tokLabel = previewTokensLabel(row);
    if (tokLabel.length > 0) {
      metaParts.push(tokLabel);
    }
    for (var mi = 0; mi < metaParts.length; mi++) {
      if (mi > 0) {
        var sep = document.createElement('span');
        sep.className = 'nest-preview-meta-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '·';
        meta.appendChild(sep);
      }
      var seg = document.createElement('span');
      seg.textContent = metaParts[mi];
      meta.appendChild(seg);
    }
    card.appendChild(meta);

    if (row.tags && row.tags.length > 0) {
      var tagWrap = document.createElement('div');
      tagWrap.className = 'nest-preview-tags';
      for (var ti = 0; ti < row.tags.length; ti++) {
        var pill = document.createElement('span');
        pill.className = 'nest-preview-tag';
        var tagColor = row.tagColors && row.tagColors[ti];
        if (tagColor) {
          pill.style.setProperty('--tag-color', tagColor);
          var bg = hexToRgba(tagColor, 0.15);
          if (bg) {
            pill.style.background = bg;
          }
        }
        pill.textContent = row.tags[ti];
        tagWrap.appendChild(pill);
      }
      card.appendChild(tagWrap);
    }

    // The two body lines land asynchronously from the host (previewBody reply); until
    // then the body block is empty. A placeholder keeps the card from jumping when the
    // lines arrive.
    var bodyWrap = document.createElement('div');
    bodyWrap.className = 'nest-preview-body';
    card.appendChild(bodyWrap);

    // Keep the card up while the pointer travels onto it (issue #84 AC #2): entering
    // the card cancels the leave timer, leaving it re-arms the delayed close.
    card.addEventListener('mouseenter', clearPreviewHideTimer);
    card.addEventListener('mouseleave', schedulePreviewClose);

    document.body.appendChild(card);
    previewEl = card;
    positionPreview(card, x, y);

    // Request the body lines for this ONE chat. The host reads the transcript on
    // demand, returns the first user + last assistant text, and discards them; the
    // reply is applied only if the card is still open for this same chat.
    vscode.postMessage({ type: 'previewBody', sessionId: row.sessionId });
  }

  // Position the card near the anchor, clamped into the viewport so it never overflows
  // (prototype pvLeft/pvTop clamp, ChatSidebar.dc.html:789-790).
  function positionPreview(card, x, y) {
    var left = Math.min((x || 0) + 16, window.innerWidth - (PREVIEW_WIDTH + 20));
    left = Math.max(8, left);
    var top = Math.max(10, Math.min((y || 0) - 16, window.innerHeight - 220));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  // Apply a host previewBody reply: render the first-user / last-assistant lines into
  // the OPEN card, but only when the reply is for the chat the card is still showing
  // (a late reply for a chat the pointer already left is dropped). Each line is a
  // role label plus the body text, clamped to 3 lines by CSS (issue #84 AC #1); the
  // text sink is textContent so transcript content can never inject markup.
  function applyPreviewBody(sessionId, firstUser, lastAssistant) {
    if (!previewEl || previewSessionId !== sessionId) {
      return;
    }
    var bodyWrap = previewEl.querySelector('.nest-preview-body');
    if (!bodyWrap) {
      return;
    }
    bodyWrap.textContent = '';
    var lines = [];
    if (typeof firstUser === 'string' && firstUser.length > 0) {
      lines.push({ role: 'YOU', cls: 'nest-preview-role-you', text: firstUser });
    }
    if (typeof lastAssistant === 'string' && lastAssistant.length > 0) {
      lines.push({ role: 'CLAUDE', cls: 'nest-preview-role-claude', text: lastAssistant });
    }
    for (var i = 0; i < lines.length; i++) {
      var block = document.createElement('div');
      block.className = 'nest-preview-line';
      var label = document.createElement('div');
      label.className = 'nest-preview-role ' + lines[i].cls;
      label.textContent = lines[i].role;
      block.appendChild(label);
      var text = document.createElement('div');
      text.className = 'nest-preview-text';
      text.textContent = lines[i].text;
      block.appendChild(text);
      bodyWrap.appendChild(block);
    }
  }

  function clearPreviewHideTimer() {
    if (previewHideTimer !== null) {
      clearTimeout(previewHideTimer);
      previewHideTimer = null;
    }
  }

  // Arm the 130ms leave-delay close (issue #84 AC #2). Cancelled if the pointer re-enters
  // the row or the card before it fires.
  function schedulePreviewClose() {
    clearPreviewHideTimer();
    previewHideTimer = setTimeout(function () {
      previewHideTimer = null;
      closePreview(false);
    }, PREVIEW_LEAVE_DELAY_MS);
  }

  // Tear the card down and forget the chat it showed (the body lines it held die with
  // the DOM node, honoring issue #84 AC #3: bodies are discarded when the card closes).
  // When restoreFocus is true AND the card was opened from the keyboard, focus returns
  // to the row it was opened from (issue #84 AC #5).
  function closePreview(restoreFocusToRow) {
    clearPreviewHideTimer();
    if (!previewEl) {
      previewSessionId = null;
      return;
    }
    var wasKeyboard = previewFromKeyboard;
    var forId = previewSessionId;
    previewEl.remove();
    previewEl = null;
    previewSessionId = null;
    previewFromKeyboard = false;
    if (restoreFocusToRow && wasKeyboard && forId) {
      var rows = focusableRows();
      var target = rows.find(function (r) {
        return r.dataset.kind === 'chat' && r.dataset.id === forId;
      });
      if (target) {
        setFocus(target);
      }
    }
  }

  // Open the card for the currently focused chat row via the keyboard (issue #84 AC #5),
  // anchored to the row's own box so it reads next to the row it previews.
  function openPreviewForFocusedRow(rowEl) {
    var row = rowByEl(rowEl);
    if (!row) {
      return;
    }
    var rect =
      rowEl && typeof rowEl.getBoundingClientRect === 'function'
        ? rowEl.getBoundingClientRect()
        : { right: 12, top: 12 };
    openPreview(row, rect.right, rect.top, true);
  }

  // Resolve a chat row element to its section-model row object (title/folder/age/
  // tokens/tags). Uses the same rowsBySessionId lookup the search join uses.
  function rowByEl(rowEl) {
    if (!rowEl || !rowEl.dataset || rowEl.dataset.kind !== 'chat') {
      return null;
    }
    return rowsBySessionId().get(rowEl.dataset.id) || null;
  }

  // ---- collapse / expand (issue #64) ----

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

  // The true structural depth of a folder section (treeDepth when the model supplies
  // it, else the clamped render depth for an older host). Collapse/hide bookkeeping
  // must key on the true depth, since two legacy folders can share a clamped render
  // depth.
  function treeDepthOf(folder) {
    return typeof folder.treeDepth === 'number' ? folder.treeDepth : folder.depth;
  }

  // Whether a folder section at index i has at least one descendant folder. The
  // pre-order flattening guarantees a folder's first descendant (if any) is the very
  // next entry at a greater (true) depth.
  function folderHasChild(i) {
    const here = sections.folders[i];
    const next = sections.folders[i + 1];
    return !!(next && treeDepthOf(next) > treeDepthOf(here));
  }

  // "Collapse one level" (the ^ button): collapse the deepest currently-open VISIBLE
  // folder tier; repeated clicks fold upward; once all folded, the next click
  // re-expands ALL (design README line 72, prototype ChatSidebar.dc.html
  // collapseLevel). Mirrors the unit-tested pure helper foldOneLevel: it computes the
  // deepest visible open tier and, when nothing is collapsible but real folders
  // exist, clears the collapsed set instead of no-opping.
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
      // Nothing is collapsible. If there are real folders, they are all folded to
      // their shallowest level, so this terminal click re-expands them all by
      // clearing the collapsed set (only when it actually holds ids, so a tree with
      // no collapsible nesting does not thrash).
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

  // The in-flight folder rename, so a cross-surface re-render (a 'sections'/'state'
  // message landing while the user is mid-rename) can COMMIT the half-typed name
  // before it destroys the input, instead of silently dropping it. Removing a
  // focused element from the DOM does not reliably fire 'blur', so render() cannot
  // rely on the blur-commit; it calls commitPendingRename() explicitly first.
  // Holds { commit } for the open input, or null when no rename is active.
  let pendingRename = null;

  function commitPendingRename() {
    if (pendingRename) {
      const p = pendingRename;
      pendingRename = null;
      p.commit();
    }
  }

  // Folder-row single- vs double-click arbitration (issue #82 AC2 / design README
  // line 63: "Click toggles expand/collapse. Double-click enters inline rename").
  // A click that toggles collapse re-renders the whole tree, detaching the node a
  // following dblclick needs, so a per-click toggle would race the rename: the
  // first click of a double-click would fire the toggle, re-render, and the dblclick
  // would never open rename. The browser fires click, click, dblclick, so the toggle
  // is DEFERRED by a double-click window and cancelled if a second click / dblclick
  // arrives first. This mirrors src/views/orgPanelInteractions.ts (registerFolder-
  // Click / registerFolderDblClick, DOUBLE_CLICK_MS): lastFolderClickAt is the arm
  // stamp, folderToggleTimer is the pending timer, folderToggleArmedId is the folder
  // the armed toggle targets (so a click on a DIFFERENT folder cancels the stale arm
  // rather than toggling the wrong one).
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

  // Right-click a folder header to open the folder actions menu.
  // Wire ArrowUp/ArrowDown cyclic roving focus and Enter/Space activation across the
  // .nest-menu-item buttons of a role="menu" overlay, matching the sort popover
  // (wireSortPopover) so every ARIA menu in the panel honors the same keyboard pattern
  // it advertises (issue #85 AC #5, "fully keyboard operable"). Native buttons already
  // fire click on Enter/Space, but keeping an explicit handler is harmless and keeps the
  // affordance uniform with the sort popover. Call after all items are appended and
  // BEFORE focusing the first item.
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
    // Opening a conflicting surface aborts any armed folder-row collapse so the folder
    // cannot collapse out from under the menu a beat later (and so the deferred timer
    // cannot fire render() and orphan this body-level menu).
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
    // "Set color" opens the in-panel 8-swatch picker (AC2), anchored under the folder
    // header so the swatches read next to the folder they recolor, seeded with the
    // folder's current color. The native <input type=color> is retired.
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
  // ---- chat context menu (issue #85: tags, create tag, export, archive) ----

  // The right-click menu on a chat row. Body-level position:fixed, in the SAME transient-
  // overlay class as the folder menu / color picker / new-folder popover, so a tree
  // re-render or Escape tears it down (closeAllTransientOverlays) and it can never post a
  // mutation for a row a refresh removed. Two modes: the LIST mode (tag toggles, create
  // tag, export, archive-or-starred-note) and the NEW-TAG mode (name input + 8-swatch
  // picker + Add/Cancel). chatMenuSessionId is the chat the open menu targets; the menu
  // re-resolves the LIVE row by that id on each (re)render so a toggle reads current tags.
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

  // Resolve the live row object for the open menu's chat, or null when it is gone (a
  // refresh removed it). Used so a tag toggle reads the CURRENT tag set, not the stale
  // row captured when the menu opened.
  function chatMenuRow() {
    if (!chatMenuSessionId) {
      return null;
    }
    return rowsBySessionId().get(chatMenuSessionId) || null;
  }

  function openChatMenu(e, sessionId) {
    // Opening the menu dismisses any hover card and aborts an armed folder-row toggle, so
    // no other transient surface fights it or fires a re-render that orphans it.
    closePreview(false);
    cancelPendingFolderToggle();
    closeAllTransientOverlays();
    if (!sessionId) {
      return;
    }
    chatMenuSessionId = sessionId;
    chatMenuNewTagMode = false;
    chatMenuNewTagName = '';
    chatMenuNewTagColor = HANDOFF_PALETTE[0];
    // Restore focus to the row on close when it survives (a keyboard-opened menu returns
    // there); a pointer right-click has no meaningful return target beyond the row.
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
    // Clamp near the click point so the menu never overflows (prototype openCtx clamp:
    // width ~210, height allowance ~320 for the tag list).
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
          // The refresh that follows the store write re-renders the tree AND (via the
          // sections handler's teardown) closes this menu, so the checkmark reflects the
          // new state on reopen. Close now so the menu does not linger over a re-render.
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

    // Archive is shown ONLY when the chat is neither starred nor archived (issue #85
    // AC #4; the archived flag lives behind the archived-exclusion, so a visible row is
    // never already archived, but a starred row must instead show the keep note). A
    // starred chat shows the "kept and never archived" note in its place.
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

  // The NEW-TAG mode: a name input, the 8-swatch color picker, and Add tag / Cancel. On
  // Add, post createTagWithColor with only a HANDOFF_PALETTE literal (or the default), the
  // trimmed name, and the target sessionId; the host mints + applies + refreshes.
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
      // Cancel returns to the tag LIST (the prototype's cancelNewTag), not closing the
      // whole menu.
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

  // The in-panel 8-swatch folder color picker (issue #82 AC2), replacing the native
  // <input type=color>. It floats near the anchor (the folder header row or the
  // right-click point), paints one swatch per handoff-palette color plus a "Default"
  // (clear) chip, marks the folder's current color, and posts setFolderColor on a
  // pick. Only palette literals (or null) are ever sent; the host re-validates.
  let openColorEl = null;
  let colorReturnFocusEl = null;
  function closeColorPicker() {
    if (openColorEl) {
      openColorEl.remove();
      openColorEl = null;
    }
    // Restore focus to the folder header the picker was opened from, so keyboard
    // focus is never dropped to <body> on close (mirrors the sort popover's
    // focus-restore; s3a-design-shell ARIA rule).
    if (colorReturnFocusEl) {
      const el = colorReturnFocusEl;
      colorReturnFocusEl = null;
      if (typeof el.focus === 'function') {
        el.focus();
      }
    }
  }
  // anchorEl is the folder header the picker hangs under (used for positioning AND
  // focus restore); currentColor is the folder's color (#rrggbb) or null so the
  // active swatch shows a ring.
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
        // A committed pick triggers a store mutation + re-render, which re-seats the
        // roving tabindex; do not fight it by refocusing the stale header.
        colorReturnFocusEl = null;
        closeColorPicker();
        vscode.postMessage({ type: 'setFolderColor', folderId, color });
      });
      grid.appendChild(sw);
      swatches.push(sw);
    }
    pop.appendChild(grid);

    // A "Default" chip clears any custom color (posts null), matching the folder
    // menu's existing "Clear color" action so the picker is self-sufficient.
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

  // ---- new-folder popover (issue #82 AC3) ----

  // The in-panel "New folder" popover the FOLDERS header + button opens, replacing
  // the bare createFolder handoff to the native input box. A name input plus Create /
  // Cancel; Create posts { type:'createFolder', name } (the host runs the same
  // createFolder command with the name as presetName, so slash-path expansion and
  // the one-sublevel depth cap still apply). Enter commits, Escape cancels; an
  // outside click dismisses it (shared document handler below).
  let openNewFolderEl = null;
  let newFolderReturnFocusEl = null;
  function closeNewFolderPopover() {
    if (openNewFolderEl) {
      openNewFolderEl.remove();
      openNewFolderEl = null;
    }
    // Restore focus to the + button so keyboard focus is not dropped to <body> on
    // close. On a committed Create the caller nulls this first (a re-render follows).
    if (newFolderReturnFocusEl) {
      const el = newFolderReturnFocusEl;
      newFolderReturnFocusEl = null;
      if (typeof el.focus === 'function') {
        el.focus();
      }
    }
  }

  // Close ALL three body-level transient overlays together. They are appended to
  // document.body (outside listEl) and are position:fixed, so a tree re-render
  // (listEl.textContent = '') does NOT remove them: they would float, orphaned, at
  // a stale viewport point while their captured-closure buttons still post
  // setFolderColor/renameFolder/deleteFolder for a folderId the same refresh may
  // have recolored, renamed, or deleted. The Escape handler and every inbound tree
  // re-render ('sections'/'state') both route through this ONE function so the
  // close-set can never drift. The keys mirror src/views/orgPanelInteractions.ts
  // TRANSIENT_OVERLAY_KEYS ('colorPicker', 'newFolderPopover', 'folderMenu').
  function closeAllTransientOverlays() {
    closeColorPicker();
    closeNewFolderPopover();
    closeFolderMenu();
    // The chat context menu (issue #85) is another body-level position:fixed overlay in
    // this class; a tree re-render or Escape must tear it down too so its captured-closure
    // items cannot post a toggle/export/archive for a row a refresh removed.
    closeChatMenu();
    // The hover card is also a body-level position:fixed overlay that a tree
    // re-render (listEl.textContent = '') would orphan, floating at a stale point
    // while it references a row that no longer exists. Tear it down with the rest.
    // No focus restore here: render() re-seats the roving tabindex, and the Escape
    // path already ran closePreview(true) before reaching this shared close-set.
    closePreview(false);
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
        // A successful create triggers a re-render that re-seats focus; do not
        // refocus the (still-present) + button and fight it.
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
    input.focus();
  }

  // ---- Settings overlay (slice s3b-settings-overlay, issue #86) ----

  // The four section toggles, in the design's order, with their sub-labels
  // (media/design/ChatSidebar.dc.html:281-299). Each drives sectionsVisible[key] and
  // posts { type:'setSectionsVisible', [key]:next }.
  const SECTION_TOGGLES = [
    { key: 'starred', label: 'Starred', sub: 'Show starred chats at the top' },
    { key: 'questions', label: 'Questions', sub: 'Surface chats awaiting your reply' },
    { key: 'folders', label: 'Folders', sub: 'Show the folder tree' },
    { key: 'unsorted', label: 'Unsorted', sub: 'Show chats not in a folder' },
  ];

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

  // Build and open the full-panel Settings overlay. A back chevron + Newsreader 16px/600
  // heading, an ARCHIVING group (a "Keep chats for" select), and a SIDEBAR SECTIONS
  // group of four pill switches (on = #d97757). The overlay is position:absolute;inset:0
  // over the panel; it stays open until the back chevron or Escape. Idempotent: opening
  // it while open re-renders in place (so a fresh 'settings' state re-seeds the controls).
  function openSettingsOverlay() {
    // A conflicting transient surface is torn down, but this persistent sub-page is not
    // in that close-set; opening it dismisses the click-dismiss popovers so nothing
    // floats over it.
    closeAllTransientOverlays();
    closeSort(false);
    if (settingsOverlayEl) {
      closeSettingsOverlay(false);
    }
    settingsReturnFocusEl = settingsEl || null;

    const overlay = document.createElement('div');
    overlay.className = 'nest-overlay nest-settings-overlay';
    overlay.setAttribute('role', 'dialog');
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
    // area exactly like the design's inset:0 sub-page and inherits the panel width.
    document.body.appendChild(overlay);
    settingsOverlayEl = overlay;
    back.focus();
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

  // ---- drag and drop (in-process) ----

  function onRowDragStart(e, sessionId) {
    // A drag starting dismisses any open hover card (prototype clears hoverId on
    // dragstart) so a floating card never overlaps the drop UI.
    closePreview(false);
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
    return Array.prototype.slice.call(listEl.querySelectorAll('[role="treeitem"]'));
  }

  function activateRow(sessionId) {
    // Opening a chat dismisses the hover card (prototype openChat sets hoverId null).
    closePreview(false);
    vscode.postMessage({ type: 'open', sessionId });
  }

  function moveFocus(delta) {
    // Arrow navigation dismisses a keyboard-opened hover card so a stale card does
    // not linger over a row the focus has left (issue #84 AC #5). closePreview(false)
    // does not restore focus, so it will not fight the setFocus below.
    closePreview(false);
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
    } else if ((e.key === 'p' || e.key === 'P') && isRow && active.dataset.kind === 'chat') {
      // Keyboard-equivalent hover preview (issue #84 AC #5): 'p' on a focused chat row
      // opens the SAME card the pointer hover opens, anchored to the row; Escape (the
      // shared document handler) closes it and restores focus to this row. Rides the
      // EXISTING roving-tabindex ARIA tree (UI-SPEC deviation 5), not a new focus model.
      e.preventDefault();
      openPreviewForFocusedRow(active);
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

  // Post the current text query to the host content-search seam. Debounced by
  // onFilterInput (issue #83 AC #4) so a fast typist does not fire a query per
  // keystroke; the host's body-index build already yields to the event loop
  // (BODY_READ_CHUNK) so neither side blocks the UI thread.
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
    // Re-render immediately so the search box, chip state, and (for a tag-only
    // filter) the flat list stay responsive; the TEXT hit set fills in when the
    // debounced host reply lands. When the box is emptied, drop any stale host
    // results at once so clearing restores the sectioned view without a flash.
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
        // The Settings overlay is a persistent sub-page: Escape closes it first (and
        // returns focus to the gear) rather than falling through to the tree overlays.
        if (isSettingsOpen()) {
          closeSettingsOverlay(true);
          return;
        }
        closeSort(isSortOpen());
        // Close the hover card first, restoring focus to the row it was opened from
        // when it was a keyboard-opened card (issue #84 AC #5). Runs before the other
        // overlay closes so a keyboard preview reliably returns focus to its row.
        closePreview(true);
        closeAllTransientOverlays();
        // Escape is a documented abort trigger for the deferred folder-row toggle
        // (orgPanelInteractions.ts clearFolderToggleArm): dismissing the UI must also
        // drop any armed collapse so it cannot fire a beat later against the tree the
        // user just abandoned.
        cancelPendingFolderToggle();
      }
    });
  }

  // ---- inbound host messages ----

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    if (msg.type === 'sections' && msg.sections) {
      // render() (called below) is the single choke point that commits a pending
      // rename, drops any armed folder-toggle, and tears down the body-level overlays
      // before it clears listEl, so this handler does not repeat that teardown.
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
      // Like 'sections', this handler re-renders via render() below, which owns the
      // rename-commit / toggle-drop / overlay-teardown before it clears listEl.
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
    } else if (msg.type === 'searchResults') {
      // Host content-search reply (issue #83 AC #1/#3). Adopt the ranked ids and the
      // per-id snippet ONLY for the query still in the box; a reply for a stale query
      // (the host posts twice per query as its two-phase index refines, and
      // keystrokes interleave) is dropped. The host echoes its RAW trimmed query;
      // normalize it the same way textFilter is (the shared normalizeQuery mirror)
      // and drop the reply unless it is fresh for the query still in the box.
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
    } else if (msg.type === 'previewBody') {
      // Host reply to a hover-scoped previewBody request (issue #84). Apply the first-
      // user / last-assistant lines to the OPEN card only when it is still showing this
      // same chat; applyPreviewBody drops a stale reply for a chat the pointer has left.
      if (typeof msg.sessionId === 'string') {
        const firstUser = typeof msg.firstUser === 'string' ? msg.firstUser : null;
        const lastAssistant = typeof msg.lastAssistant === 'string' ? msg.lastAssistant : null;
        applyPreviewBody(msg.sessionId, firstUser, lastAssistant);
      }
    } else if (msg.type === 'settings') {
      // The host posted the Settings overlay state (issue #86): the auto-archive window
      // and the four section-visibility toggles. Adopt them and re-render the tree so
      // the section gates apply. We do NOT rebuild an OPEN overlay here: the host posts
      // 'settings' after every setAutoArchiveWindow / setSectionsVisible the user just
      // made in the open overlay, and rebuilding would steal focus back to the back
      // chevron on every toggle. The open overlay already reflects the user's own change
      // optimistically (the switch/select handlers update their control in place); the
      // fresh state is seeded the next time the overlay is opened. Reconcile the open
      // overlay's controls in place (without a rebuild) so a host-side coercion (e.g. an
      // out-of-range window snapped to the default) is still reflected.
      if (typeof msg.autoArchiveWindowDays === 'number') {
        autoArchiveWindowDays = msg.autoArchiveWindowDays;
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
    } else if (msg.type === 'openSettings') {
      // The palette/view-title Settings command asked to open the in-panel overlay.
      openSettingsOverlay();
    } else if (msg.type === 'active') {
      // The host resolved the currently-open chat (best-effort tab-label match). Re-tint
      // in place without a full re-render: clear the old tint, apply the new one.
      const next = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      if (next === activeId) {
        return;
      }
      activeId = next;
      for (const el of listEl.querySelectorAll('.nest-row.nest-active')) {
        el.classList.remove('nest-active');
      }
      if (activeId) {
        for (const el of listEl.querySelectorAll('.nest-row')) {
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
    // The gear opens the in-panel Settings overlay directly (client-side render). No
    // host round-trip is needed to OPEN it; the overlay's controls are seeded from the
    // last 'settings' message the host posted on 'ready' and re-posts on every change.
    settingsEl.addEventListener('click', () => openSettingsOverlay());
  }
  wireSortPopover();

  vscode.postMessage({ type: 'ready' });
})();
