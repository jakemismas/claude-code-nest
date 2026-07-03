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

  // The latest host-posted section model.
  let sections = { starred: [], questions: [], folders: [], tags: [], archivedCount: 0 };
  // The set of active tag-id filters (AND across selected chips: a row must carry
  // every selected tag to show).
  const activeTags = new Set();
  // The current text filter (title substring).
  let textFilter = '';

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

    // Collapse is driven by the chevron (the disclosure control) and by keyboard
    // ArrowLeft/Right, NOT a plain header click: a header click would race the
    // double-click rename below (a dblclick fires two clicks first, and each
    // toggleCollapse re-renders the whole tree, detaching the node the dblclick
    // targets). The design's "click the row toggles" is folder-tree behavior and is
    // deferred to the folder-tree slice, where a keyed render can support it without
    // the race (issue #80 non-goal; see DECISIONS.md).
    header.addEventListener('dblclick', () => beginRename(header, folderId, name));
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

    renderCrossCuttingSection('Starred', sections.starred);
    renderCrossCuttingSection('Questions', sections.questions, { showBreadcrumb: true });

    renderFoldersHeader();
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
      const d = depthOf(folder);
      if (d <= hideDeeperThan) {
        hideDeeperThan = Infinity;
      }
      if (d > hideDeeperThan) {
        continue;
      }
      renderFolderSection(folder);
      if (!folder.synthetic && collapsedFolders.has(folder.folderId)) {
        hideDeeperThan = d;
      }
    }

    renderArchivedRow();
    restoreFocus();
  }

  // The flat filtered view: a "N RESULTS" label then every matching row (across all
  // sections and folders), deduped by sessionId, with the body-match snippet shown.
  function renderFiltered() {
    const seen = new Set();
    const all = [];
    const collect = (rows) => {
      for (const row of rows || []) {
        if (seen.has(row.sessionId)) {
          continue;
        }
        if (rowMatches(row)) {
          seen.add(row.sessionId);
          all.push(row);
        }
      }
    };
    collect(sections.starred);
    collect(sections.questions);
    for (const folder of sections.folders) {
      collect(folder.rows);
    }
    const visible = sortRows(all);

    const header = document.createElement('div');
    header.className = 'nest-section-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'nest-section-label';
    labelEl.textContent = visible.length + ' RESULTS';
    header.appendChild(labelEl);
    listEl.appendChild(header);

    if (visible.length === 0) {
      renderEmpty('No chats match your search.');
      return;
    }
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Filter results');
    for (const row of visible) {
      group.appendChild(makeRow(row, 0, { showSnippet: true, showBreadcrumb: true }));
    }
    listEl.appendChild(group);
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

  function beginRename(headerEl, folderId, currentName) {
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
    const commit = () => {
      const name = input.value.trim();
      cleanup();
      if (name.length > 0 && name !== currentName) {
        vscode.postMessage({ type: 'renameFolder', folderId, name });
      }
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
    input.addEventListener('click', (e) => e.stopPropagation());
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

  // Right-click a folder header to open the folder actions menu.
  let openMenuEl = null;
  function closeFolderMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
  }
  function openFolderMenu(e, headerEl, folderId, label, currentColor) {
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
    const first = menu.querySelector('.nest-menu-item');
    if (first) {
      first.focus();
    }
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
  function openNewFolderPopover(anchorEl) {
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

  function onFilterInput() {
    textFilter = filterEl.value.trim().toLowerCase();
    if (searchClearEl) {
      searchClearEl.hidden = filterEl.value.length === 0;
    }
    render();
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
        closeSort(isSortOpen());
        closeFolderMenu();
        closeColorPicker();
        closeNewFolderPopover();
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
    settingsEl.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  }
  wireSortPopover();

  vscode.postMessage({ type: 'ready' });
})();
