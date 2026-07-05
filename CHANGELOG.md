# Changelog

All notable changes to Claude Code Nest are recorded here. The format follows
Keep a Changelog, and the project adheres to semantic versioning.

## [Unreleased]

Sprint 3 is Part 1 complete (issues #78 to #83 merged) and Part 2 is now complete
(the hover card, #84, the chat-row context menu, #85, the Settings overlay plus
auto-archive engine, #86, and the in-panel Archive overlay, #87, are all merged),
NOT yet released. The finished v0.2.0 "One Panel" release still needs Part 3
(#88, #89), the human verify gate (#76), and the pre-release security
council (#90) before the release run (#91) bumps the version and tags. A mid-sprint handoff
build, `claude-code-nest-0.1.1-sprint3-part2.vsix`, is packaged in the repo root
for smoke testing the Part 1 and Part 2 surface, and TESTING.md carries the
consolidated per-slice smoke checklist drawn from SPRINT-3-PLAN.md (every landed
section, through Part 2, is runnable; only the Part 3 sections are marked
not-yet-built). No version bump and no tag accompany this handoff.

### Added

- A visual-fidelity harness for the Sprint 3 redesign (#79). `npm run fidelity`
  renders the real Organize panel asset (with synthetic mock data) and the design
  prototype headlessly at the 320px reference width and writes screenshots to
  `.claude-working/fidelity/` for a by-eye comparison against the committed
  baselines under `media/design/reference/`. It drives headless Chrome or Edge over
  the DevTools Protocol using only Node built-ins (no new dependency), and fails
  with a clear message when no browser is found. The harness, scripts, and
  reference images are excluded from the packaged extension.
- A per-row status slot on the Organize panel chat row (#79), the first piece of
  the Sprint 3 row anatomy: a blinking `?` badge marks a chat whose last turn is an
  assistant message that asks a question, disabled under reduced motion, with the
  meaning carried on the row's aria-label. As shipped by #79 the pure model derived
  `'question'` only from the tier-A snapshot and did not yet emit the solid unread
  `'done'` dot (that needed the per-device read-state gate); the dot's render path
  existed and was exercised by the fidelity harness mock. (Superseded by #81, below,
  which adds the read-state gate so `'done'` is now emitted for a real unread reply.)
- The Organize panel chrome now matches the Sprint 3 handoff (#80): the design-token
  palette, a New session pill, a gear button, a sort popover that replaces the native
  dropdown (Newest first / Oldest first / Name A-Z, with a colored checkmark on the
  active option), and the redesigned search box. The Newsreader serif font ships in
  the package (`media/fonts/newsreader-600-latin.woff2`, loaded via an in-webview
  `@font-face`) with a local serif fallback; no heading consumes it yet, so the gate
  is the packaging proof, not a rendered heading.
- New session opens a fresh Claude Code chat (#80). It calls the installed Claude
  Code new-chat command (`claude-vscode.newConversation`, with `sidebar.open` as a
  graceful fallback) rather than the URI open path, which only resumes an existing
  chat; a total failure shows an informational notice.
- An `Archived (N)` row on the Organize panel (#80). Archived chats are now excluded
  from the visible sections and the tag-chip counts and are summarized in this bottom
  row, which opens the Archive view until the in-panel Archive overlay ships.
- Tag pills on a chat row now render in their per-tag color (#80).
- The reworked chat row and its per-device read state (#81). Each row now carries a
  status slot with two live affordances gated on a per-device read state: a blinking
  `?` badge when the last turn is an UNREAD assistant message that asks something, and
  a solid unread dot (`done`) when it is an unread assistant reply that does not. Both
  clear when you open the chat (via Nest, or by focusing its named Claude Code tab),
  because opening stamps a per-device `lastSeenAt` for that chat. The read state is
  LOCAL and NEVER synced (stored in workspace state under one key, like sort and the
  collapsed set), so it can never widen the synced surface. The Questions section is
  redefined to match: a chat is in Questions exactly when its status is `question`
  (an unread assistant turn that asks something), replacing the previous "last turn
  was yours" heuristic. Question detection is a new pure tail-window heuristic that
  looks for a trailing `?`, a `?` inside the truncated snippet's tail, or a tight set
  of input-request phrases, and is biased toward NOT flagging a plain statement. The
  row also gains a star toggle that persists, an active-row tint on the chat whose tab
  is focused, and a folder breadcrumb on Questions and search-result rows.
- The folder tree rebuilt to the Sprint 3 handoff (#82). Each folder header shows a
  chevron, a color-filled folder glyph (default warm tan `#C2A56E`), a 13px/600 name
  that ellipsizes, and a chat count that rolls up over subfolders (the chats directly
  in it plus every descendant), computed in the pure model over the stored hierarchy
  so it is filter-independent. The native OS color input is replaced by an in-panel
  8-swatch picker over the handoff palette (with a Default chip), and the bare
  new-folder prompt by an in-panel name popover with Create/Cancel; both restore focus
  to their anchor on close. Double-click a header for inline rename. The tree renders
  at most one visible sublevel: a clamped render depth is emitted while the true depth
  is carried for collapse bookkeeping, and folder CREATION is capped at one sublevel at
  the write source, so `A/B/C` creates only `A/B`; deeper LEGACY folders (e.g. synced
  from an older client) still render, clamped at the second indent tier, and are never
  modified or lost. The collapse-one-level control folds the deepest open level first
  and re-expands the whole tree once every level is folded. The frozen dropReducer, the
  drag drop highlight (`#FAE6DC` with an inset accent ring), the drop-on-Unsorted
  unfile, and the keyboard/ARIA tree are preserved rather than rebuilt.
- Full-text search and tag-chip filtering in the Organize panel (#83). Typing in the
  search box now searches chat CONTENT, not just titles: the panel posts a debounced
  query to the host, which ranks chats with the existing host-only MiniSearch index
  (in globalStorage or memory, never synced, never under `~/.claude/projects`) and
  returns ranked hits. Results render as a flat "N RESULTS" list that intersects the
  text hits with the client-side tag-chip AND-filter, so text and tags combine; the
  tag-only flat view (chips selected, no text) and clear-restores-sections both keep
  working. A body-only match (the query is not in the title) shows a matched-context
  snippet PREFIXED with the speaker, `You:` or `Claude:`; a title match shows no
  snippet. The role label rides only the snippet, never the search index, so a search
  for "claude" does not match every chat. The persisted index stays tier-A-only (no
  message body is written to disk); the body is read on demand in memory and discarded.
  No schema change, no new file-write path, and the synced surface is unchanged.
- A chat-row right-click context menu in the Organize panel (#85), slice
  s3b-context-menu. Right-clicking a chat row opens a menu that lists EVERY project tag
  with a checkmark on the chat's current tags; clicking a tag toggles it on the chat. A
  Create new tag entry switches the menu to a name input plus the 8-swatch color picker
  with Add/Cancel, mints the tag with that color, and applies it to the chat. Export as
  Markdown and Export as JSON reuse the existing export pipeline (save dialog and the
  exportIO chokepoint with the projects-path guard). Archive chat appears only when the
  chat is neither starred nor archived; a starred chat shows the note that starred chats
  are kept and never archived. The menu lists all tags (not just the visible-chat filter
  chips) via an additive `allTags` field on the row model built from `meta.tags`, leaving
  buildTagChips unchanged; its intents route through thin OrgPanelActions seams
  (toggleChatTag, the new createTagWithColor, exportChat, archiveChat) that reuse the
  existing store, export, and read-only archive-body paths, so no new scan or write path
  is added. The menu is a body-level transient overlay that dismisses on Escape and
  outside click and is fully keyboard operable (Arrow keys rove, Enter/Space activate);
  every label sink is textContent, and every outbound field is coerced at the host
  boundary (sessionId and tagId as strings, color via isValidColor-or-null, format as a
  closed union). The synced surface is unchanged.
- An in-panel Settings overlay and a batched auto-archive engine (#86), slice
  s3b-settings-overlay. The standalone Settings WebviewPanel is retired: Settings now
  render as a full-panel overlay inside the Organize panel with a back chevron, a
  Newsreader heading, a "Keep chats for" window select (7/14/30/90 days, 1 year, or
  Never), and four section-visibility pill switches (Starred, Questions, Folders,
  Unsorted). The gear opens it client-side and the palette openSettings command reveals
  the panel and opens the overlay. The window default follows the effective Claude
  cleanupPeriodDays (30 when unset); the window and the toggles persist on workspaceState
  through the existing state-store `_KEY` pattern, never on the synced ProjectMeta, so
  the synced surface stays exactly `nest.meta.v1::<projectKey>`. The section toggles are
  client-side render gates only, and an unfiled chat stays reachable via search and tag
  chips (and the Unsorted section still renders when every other section that could hold
  it is hidden), so disabling Unsorted can never strand a chat. Separately, a batched
  engine auto-archives chats: on activation and after a scan refresh it archives unstarred
  chats older than the auto-archive window (the synced userArchived flag plus a Nest-owned
  body copy, coalesced into one flush) and, keyed independently to the effective Claude
  cleanup age, writes a protective body copy for a starred chat past that age WITHOUT
  archiving it, so choosing "Never" for auto-archiving still keeps starred chats safe from
  Claude cleanup. The archive decision is a pure module (src/store/autoArchivePolicy.ts)
  with an injected clock, reusing the retention convention (keepWindowDays <= 0 is Never,
  starred is exempt, the boundary is inclusive with strictly-greater triggering); it reuses
  store.setChatArchived and archiveBodyStore, adding no new fs write path, and the read-only
  invariant and the synced surface are unchanged.
- A rich hover preview card in the Organize panel (#84), the first Part 2 slice.
  Hovering a chat row (or pressing `p` on a focused row) opens a floating 270px card
  with the chat title; a folder, age, and compact `NNk tok` meta line; the tag pills;
  and the first user message and last assistant message, each clamped. The card is
  hover-stable (a short leave delay keeps it up while the pointer travels onto it) and
  keyboard-operable, with Escape closing it and restoring focus to the row. The card is
  a webview DOM node, not the retired MarkdownString tooltip, and every content sink is
  written as textContent (no innerHTML). Its two body lines are read on demand: the
  client posts a hover-scoped `previewBody` request for the ONE chat, the host reads that
  single transcript, picks the first user and last assistant body, posts them back keyed
  by sessionId, and discards them; the reply renders only while the card is still open
  for that chat. Bodies never enter the scan snapshot, no body is persisted, and the
  synced surface is unchanged.
- An in-panel Archive overlay (#87), slice s3b-archive-overlay, completing Part 2. The
  bottom "Archived (N)" row now opens a full-panel overlay inside the Organize panel
  (reusing the Settings overlay's back-chevron and Newsreader-heading chrome) instead of
  focusing a separate tree. Each archived row shows the chat title over a folder and age
  meta line, an export button, a Restore button (hover fills the accent), and a star that
  un-archives the chat (star-and-restore). The overlay carries its own "Search archived"
  box with a deliberately GRAY focus glow (#A6A294 ring, rgba(120,114,102,0.30) bloom),
  distinct from the main orange search glow; the search filters the posted rows client-side
  by title. Archived rows are built by a new pure, vscode-free builder
  (orgPanelModel.buildArchivedRows) from the SYNCED userArchived membership, posted on
  demand when the overlay opens; a chat whose transcript Claude already cleaned up still
  lists (its title falls back to the Nest-owned body copy, shown as "copy only"), and its
  row previews that saved copy. Restore clears the synced userArchived flag (keeping the
  star) through the existing restoreChat command; every inbound message is coerced at the
  host boundary and every label is rendered as textContent, so no new write path or synced
  scalar is introduced and the read-only invariant holds. The overlay is keyboard-operable
  with a focus-restoring Escape. (The slice landed in 7a9256e, whose message put the
  Fixes line inside the final paragraph and so kept the `Nest-Slice` trailer from
  parsing; this follow-up carries the trailer on its own final paragraph so the slice
  reads as built.)

### Changed

- Row density (comfortable/compact) is removed from the Organize panel (#80): the
  Sprint 3 handoff has a single row density. The tag pills and the last-message
  snippet, previously shown only in the comfortable density, are now always shown.
  The sort preference still persists per workspace; the density preference no longer
  exists.
- The Organize panel is now the only browsing surface (#78): the flat Chats tree
  and the Smart Groups tree are retired, per the Sprint 3 one-panel design
  (UI-SPEC.md deviation 5). With the Archive tree retired in #87 and the settings
  editor tab retired in #86, the Organize panel webview is now Nest's ONLY contributed
  view. FoldersProvider and TagsProvider stay as non-view services (project-key
  resolution, the link pick list, the token rollup seam); the open-chat command id
  moved to the URI launcher module.
- Link to Chat... and Unlink are now fully palette-driven: run with no selection,
  each quick-picks its chats (the source chat to link from; the linked child to
  unlink from its designated parent). Unlink is no longer hidden from the palette.
- The palette Refresh command re-scans under progress and re-renders the Organize
  panel; the retired trees' Refresh Smart Groups command and their view menus,
  welcome views, walkthrough step, and activation events were swept out.

### Removed

- The `claudeNest.flat` and `claudeNest.smartGroups` views and every contribution
  that targeted them. Smart-group promote commands remain registered for
  programmatic callers but have no UI surface. The per-row token badge stays on the
  Organize panel rows.
- The `claudeNest.archive` tree view and every contribution that targeted it (#87):
  the view, its `onView` activation event, its viewsWelcome empty state, its
  view/title Refresh Archive and Settings buttons, and its view/item/context row
  actions. The `claudeNest.refreshArchive` command is removed outright (the palette
  Refresh re-primes the shared scan and the overlay re-requests its rows on open). The
  archived chats, the Nest-owned body copy, the archived-copy preview, and the
  star/unstar/restore curation commands all survive; only the tree surface is gone.
  Star, archive, restore, and preview-archived-copy now route through the Organize
  panel (the row star toggle, the right-click context menu, and the in-panel Archive
  overlay), so `starChat`, `unstarChat`, `restoreChat`, `archiveChat`, and
  `previewArchivedChat` stay registered for those programmatic callers but have no
  menu/palette surface (recorded in the commandSurfaces regression gate). The Preview
  Full Chat and Export Chat... commands remain the accepted interim gap from #78 (still
  awaiting the palette / a live-chat preview surface).

## [0.1.1] - 2026-06-30

A verify-and-polish pass over the released 0.1.0 plus the collapsible-folders
feature, folded into the Sprint 2 work item (#16).

### Added

- Collapsible folder sections in the Organize panel (#64): each real folder
  section collapses and expands with a disclosure chevron and aria-expanded, the
  full ARIA tree keyboard pattern (ArrowRight expands a collapsed folder or moves
  to its first child, ArrowLeft collapses an expanded folder or moves to the
  parent), and a "collapse one level" control that folds the deepest open visible
  level. The collapsed set persists per workspace and is never synced, mirroring
  sort and density. The synthetic Unsorted catch-all stays always expanded.

### Changed

- The Settings command title is now "Settings" (#67), so the command palette
  shows "Claude Code Nest: Settings" instead of repeating the product name. The
  command id and the settings editor tab title are unchanged.
- The orphaned Refresh Folders and Refresh Tags commands, left without a tree
  after the slice 6 retirement, are hidden from the command palette (#69). The
  kept non-view providers' refresh is still callable internally.
- ARCHITECTURE.md gained a module map and its Git landing strategy was corrected
  to PR-per-slice; SPRINT-2-PLAN.md and the CHANGELOG were reconciled with the
  shipped surfaces, and an inaccurate prune comment was fixed (#63, #66).
- The deferred host-only integration tests were updated to the post-slice-6 view
  set (#68); the frozen dropReducer DropTargetView literals are unchanged.

### Fixed

- Org-panel folder headers, which are focusable tree items, now show the same
  accent focus ring as chat rows (#62), so keyboard focus is consistent across
  the tree and matches the UI-SPEC accessibility criterion.

### Removed

- Two dead exports (the unused ExportSaveTarget interface and the
  createMetadataStore factory) were removed (#67). No behavior change.

## [0.1.0] - 2026-06-28

### Added

- Sprint 2 baseline (in progress, not part of the 0.0.1 release): a Chats
  (Preview) WebviewView (claudeNest.chatsPreview) added beside the native Chats
  tree as a proof of concept for richer webview rendering (inline filter box,
  card rows). It is strictly additive and read-only: it reads the SAME scanChats
  path and opens chats through the SAME OPEN_CHAT_COMMAND as the native tree, is
  CSP-locked with a per-render nonce, and leaves the shipped views and the model
  untouched. The 0.0.1 feature set below is unchanged by it.
- Tier-A transcript summary (slice 0, no UI): the single transcript reader now
  retains a bounded, read-only per-chat summary that later slices consume without
  re-reading or re-parsing a transcript: message count, the truncated text and
  role of the last user/assistant turn (for the awaiting-reply heuristic), summed
  token usage (input, output, cache-creation, cache-read), the distinct files
  referenced by Read/Edit/Write tool_use blocks (deduped and capped), and the
  distinct models used. The fields are additive on TranscriptScan and ChatRecord;
  titles, timestamps, PR, branch, and uuid logic and the tolerant
  skip-unknown-types contract are unchanged. Full message bodies are never held
  on the scan snapshot, only bounded reductions.
- Lazy body reader, token badge, rich hover preview, and Preview Full Chat
  (slice s2-tier-b-body-and-hover): a new vscode-free on-demand body reader
  (readTranscriptBodies) reads ONE chat's full message bodies when needed and
  discards them; no provider holds the result and bodies never enter the scan
  snapshot. A "Preview Full Chat" command reads that one transcript on demand and
  opens its formatted text in a read-only editor document, then discards the
  bodies. Every chat row (the flat Chats view, the Folders view, and the Tags
  view) now shows a ~token badge beside its relative time, and hovering a row
  opens a rich MarkdownString preview card built to the UI-SPEC hover card:
  folder, age, ~token total, full tag set, and BOTH a first and a last message
  snippet, plus the distinct models and files-touched count as additive context.
  The Chats (Preview) cards gained the same token badge and snippet summary line.
  The card content is produced by a vscode-free builder (buildChatTooltip) from
  plain folder/tag values the providers resolve at the row's call site, so the
  builder stays in the headless unit gate; the flat view gained the same
  MetadataStore dependency the Folders and Tags views already carry so its card
  shows the real folder and full tag set rather than a degraded subset. All of it
  reads only the bounded tier-A summary on the snapshot except the on-demand body
  read; nothing writes under ~/.claude.
- Full-text content search (slice s2-fulltext-search): the Chats (Preview) filter
  box gained a "Search chat content" mode that ranks chats by full-text relevance
  and shows a matched-context snippet under each result. The search engine is
  MiniSearch, VENDORED into the repo (src/search/vendor/minisearch.js, the upstream
  MIT UMD dist) rather than added as an npm dependency, because .vscodeignore
  excludes node_modules/** and the package proof runs with
  `vsce package --no-dependencies`, so an installed dependency would never ship and
  the install check would silently false-pass; the compile step copies the vendored
  module into out/search/vendor/, which ships in the VSIX. The durable logic lives in
  two host modules: src/search/searchIndex.ts (vscode-free buildIndex / ranked
  search returning {sessionId, score, snippet} / a pure snippet builder that centers
  on the matched term and truncates with ellipses) and src/search/searchStore.ts
  (vscode-thin: persist and load the index ONLY through exportIO against
  context.globalStorageUri, falling back to an in-memory rebuild when absent). The
  index lives in extension globalStorage, is NEVER registered for Settings Sync
  (it is a file, not a globalState key, so it stays outside setKeysForSync), and is
  NEVER written under ~/.claude/projects/ (every exportIO write runtime-asserts the
  path guard). The PERSISTED index is built from tier-A fields only (title, last
  message, files touched), so no body-derived token is written to disk; full-body
  search is in-memory only, reading each chat's body on demand via bodyReader and
  discarding it once indexed. The throwaway POC webview owns only the query wiring
  and rendering (slice 6 supersedes it with the org panel). New headless unit tests
  cover ranked sessionIds, the title boost, file-field matching, snippet
  centering/truncation, empty/no-match/limit cases, the tier-A-only persisted docs,
  the persist/load round-trip and the absent/malformed/version-mismatch rebuild
  fallbacks, a guard test that the store target resolves under globalStorage and
  that the reused assertNotUnderClaudeProjects rejects a projects-path target, and
  an isolated-process check that searchIndex loads with no vscode module.
- Curation scalars and per-scalar last-writer-wins reconcile (slice
  s2-schema-scalars-and-lww, no UI): the synced ProjectMeta gained four optional,
  additive curation scalars with NO schema-version bump: per-chat starred,
  userArchived, and archivedAt, and per-folder color. Both cross-machine merge
  paths share the single mergeProjectMeta arbiter, which now resolves these by
  last-writer-wins alongside folderId: the per-chat scalars by the single
  per-record updatedAt stamp (archivedAt travels coupled to userArchived so the
  timestamp never desynchronizes from the flag, and a tie keeps the local side),
  and Folder.color by the document-level updatedAt (foldersEqual, cloneFolder, and
  normalizeFolder all carry color so a color-only edit is not a silent no-op).
  Without this arbitration a foreign Settings Sync write would wholesale-replace a
  newly curated scalar. The schema normalizers carry the new nested fields through
  every read and migrate (default-absent, garbage-typed values dropped), leaving
  the top-level forward-compat escrow untouched; folderId stays the surfaced
  conflict floor. MetadataStore gained setChatStarred, setChatArchived (which sets
  archivedAt on archive and clears it on unarchive), and setFolderColor, each
  stamping the record and coalescing into the existing debounced pending write. New
  headless unit tests cover the normalize round-trip and additive (no-bump)
  migration, the per-scalar LWW arbitration and the Folder.color trap, the foreign
  starred-flip reconcile, and the three new store setters.
- Star, user-archive, the Archive view, and a Nest-owned body copy (slice
  s2-star-archive): new Star/Unstar and Archive/Restore commands on a chat row in
  the Chats, Folders, and Tags views write the slice-3 synced curation scalars
  through the store (starred is independent of the archive flag; archiving sets
  userArchived and a coupled archivedAt). A new read-mostly Archive view
  (claudeNest.archive) lists the user-archived chats and offers Restore (which
  clears the flag and the timestamp, keeps the star, and removes the copy); it
  registers with no drag-and-drop controller and shows a viewsWelcome empty state.
  On archive, the chat's full body is read ONCE on demand via the existing body
  reader and a Nest-OWNED copy is written to extension globalStorage
  (globalStorage/archive/<sessionId>.json) so the chat survives Claude Code's own
  cleanup of ~/.claude/projects; an archived chat whose transcript is later removed
  still appears in the Archive view with its stored title. The copy is LOCAL and is
  never synced, and the body store does NO node fs and NO direct vscode.workspace.fs:
  every write/read/list/delete goes through the exportIO chokepoint, which
  runtime-asserts the target is not under ~/.claude/projects/, so nothing renames,
  moves, or deletes a transcript. A new contributes.configuration value,
  claudeNest.archiveKeepWindowDays (7, 30, 90, or 0 for never; default 30), governs
  how long Nest keeps a copy; a pure, vscode-free retention policy decides keep vs
  prune from {archivedAt, starred, keepWindowDays, now} with starred chats always
  exempt and 0 meaning never prune, and a best-effort prune runs on activation. New
  headless unit tests cover the retention policy (starred always kept, never keeps
  all, 7d prunes only past-window unstarred, the inclusive boundary case, and the
  keep-window coercion), the body store (write/read round-trip, delete, star-flag
  update, prune-by-retention, and the reused path guard that a projects-path target
  is rejected and writes nothing), the commands (the synced-flag writes, the
  archivedAt coupling, best-effort copy on write failure, and restore semantics),
  and the Archive provider asserting it lists by the SYNCED userArchived flag and
  NOT the local-only orphan-reconcile flag. Three follow-on enhancements close
  gaps in the same slice: (1) the STAR badge now renders on every primary chat
  surface (Chats, Folders, Tags), not only in the Archive view, so starring a chat
  gives feedback everywhere it appears; each provider reads the synced
  ChatMeta.starred via a shared resolveStarred and folds it into the row reuse key
  so a toggle re-renders the affected rows. (2) A "Preview Archived Copy" command
  (claudeNest.previewArchivedChat) opens the Nest-owned body copy by sessionId so a
  cleaned-up archived chat stays readable after Claude removes its transcript; it
  is the default click for an archived row whose transcript is gone and a context
  action on every archived row, and it routes through the SAME pure formatter as
  the live preview so the two outputs are identical. (3) A live-store backstop now
  guards the prune: before deleting a copy the pure policy marked prune,
  pruneArchivedBodies re-checks the live synced state and force-keeps a copy that is
  still userArchived and starred, covering the case where the copy's own snapshot
  drifted stale-false (a swallowed star-flag write, a star applied where the copy
  never landed, or a star synced from another device); a throwing check fails safe
  toward keep. New headless unit tests cover the star badge on all three surfaces,
  the archived-copy preview orchestration (present, missing, and empty copy), and
  the backstop (protected stale copy kept, unprotected copy still pruned, throwing
  check fails safe).
- Per-chat Export Chat and the token cost rollup (slice s2-export-and-rollup): two
  commands. (1) "Export Chat..." (claudeNest.exportChat), a context action on a chat
  row in the Chats, Folders, and Tags views, exports ONE chat to Markdown or JSON.
  The body is read ONCE on demand via the existing bodyReader (read-only on the
  transcript) and DISCARDED after rendering; the file is written ONLY through the
  exportIO chokepoint, whose runtime path guard (assertNotUnderClaudeProjects)
  refuses a target under ~/.claude/projects/, so a save-dialog target aimed at a
  transcript path is rejected rather than overwriting it. The Markdown render is a
  YAML front-matter org layer (title, sessionId, timestamp, folder name, full tag
  set, starred flag, link target ids, models, files-touched/message counts, and the
  four tier-A token counts plus their total) followed by the title heading and the
  ordered turns as labelled You/Claude paragraphs; the JSON render is a single
  versioned, round-trippable document. Both formatters are PURE and vscode-free
  (src/export/chatExport.ts) so they stay in the headless gate; the vscode-thin
  orchestrator (src/commands/exportChatCommands.ts) takes injected seams for the
  format pick, the save dialog, the body read, the org-layer resolution, and the
  guarded write. Front-matter injection is closed: every Markdown front-matter
  scalar is emitted as a double-quoted, escaped YAML string (yamlQuote) and sequences
  as quoted flow arrays, so a title containing a colon, a quote, a newline, or a
  leading "---" cannot terminate the block or inject a second one (the JSON formatter
  gets this free via JSON.stringify); the title heading is markdown-escaped. The
  export carries tokens only, NO USD (slice non-goal). (2) "Show Token Cost Rollup"
  (claudeNest.showTokenRollup), a view-title action on the Chats, Folders, and Tags
  views, sums each chat's tier-A token total by folder and by tag and opens a
  read-only plain-text report (no webview/CSP dependency). The counting rule is
  pinned: by FOLDER a chat counts ONCE in its single home folder (or the synthetic
  Unfiled bucket), so the per-folder totals PARTITION the library; by TAG a chat
  counts ONCE per EACH of its tags (or the synthetic Untagged bucket), so a
  multi-tag chat adds its full total to every tag bucket and the per-tag totals are
  INTENTIONALLY NOT a partition (their sum can exceed the library total). The report
  carries an explicit note so the by-tag total does not read as a double-count bug.
  The reducers (src/rollup/tokenRollup.ts) and the report renderer
  (src/rollup/rollupReport.ts) are PURE and vscode-free; the vscode-thin command
  (src/commands/tokenRollupCommand.ts) takes injected seams for the chat-id set, the
  per-chat token totals (a new FoldersProvider.tokenTotalsByChat seam), the project
  meta, and the document open, and surfaces an info notice when no project resolves
  or there are no scanned chats. New modules: src/export/chatExport.ts,
  src/commands/exportChatCommands.ts, src/rollup/tokenRollup.ts,
  src/rollup/rollupReport.ts, src/commands/tokenRollupCommand.ts. New headless unit
  tests cover the Markdown and JSON formatters (the org layer and token header, the
  no-body case, the YAML front-matter injection escaping, the JSON round-trip), the
  export-command orchestration (the format/cancel and save/cancel guards, the
  on-demand body read and discard, the guarded write, and the write-failure error
  path), the rollup reducers (the by-folder partition, the by-tag multi-tag
  non-partition, the Unfiled/Untagged synthetic buckets, the stale folder/tag id
  fallbacks, and the sort order), the report wording (including the multi-tag note),
  and the rollup-command orchestration (the no-project/no-chats info notice and the
  open path). The contributed commands and menu entries are added in package.json.
- Primary org panel (slice s2-org-panel-webview): a new CSP-locked, nonce-scripted
  WebviewView (claudeNest.orgPanel, "Organize") is now the PRIMARY organization
  surface. It renders a section model assembled by a pure, vscode-free module
  (src/views/orgPanelModel.ts): a Starred section (the synced star flag), a Questions
  section (chats whose last genuine turn was yours, a SCAN-TIME HEURISTIC labelled as
  such, not a live signal), the single-home folder hierarchy with per-folder color and
  chat counts, and an always-present Unsorted bucket. It adds tag filter chips
  (clickable, combinable), sort (newest/oldest/name), density (comfortable/compact,
  persisted per workspace), double-click or Enter folder rename, a right-click folder
  actions menu (rename, set/clear color, delete), and in-panel drag-and-drop. The drop
  path REUSES the unchanged pure drop reducer through a thin extraction shell
  (src/dnd/webviewDropAdapter.ts): a folder-row or empty-space drop files (or unfiles)
  the dragged chats, a tag-chip drop tags them. Because a webview drag is fully
  in-process, the cross-tree drag stash is not used. Accessibility is built in: an
  ARIA tree (role tree/treeitem/group), a single roving tabindex, arrow-key
  navigation, Enter/Space activation, and a visible focus ring. A content-search mode
  reuses the slice-2 host-side MiniSearch machinery. New modules:
  src/views/orgPanelWebview.ts, src/views/orgPanelModel.ts,
  src/dnd/webviewDropAdapter.ts, media/orgPanel.{js,css}. New headless unit tests
  cover the section assembly (the heuristic flags only a user-last chat; single-home
  folder placement with stale-folder fallback; per-folder color; empty sections; the
  always-present Unsorted bucket; tag chips and counts; absent-meta tolerance; the
  Unsorted/UNFILED sentinel contract), the drop-adapter extraction mapping and intent
  application (folder-move, unfile, tag-add, the no-op cases, project-key tolerance,
  and that the adapter never touches the cross-tree stash), and the content-search
  refresh-during-build race (re-pointed from the retired preview).

### Changed

- The native Folders and Tags TreeViews (and their tree drag-and-drop controllers)
  are RETIRED, superseded by the primary org panel above. The flat Chats TreeView is
  KEPT as the accessible fallback. The FoldersProvider and TagsProvider remain as
  non-view services (project-key resolution, the link target pick list, the token
  rollup seam, reveal/home resolution); the pure drop reducer, the native
  drag-and-drop controller, and the cross-tree drag stash are unchanged and still
  unit-tested. The Export Chat, token rollup, star, and archive commands that the
  per-slice Added entries above describe on the Chats, Folders, and Tags views ship
  in v0.1.0 on the kept flat Chats view, the Organize panel, and the Archive view;
  only the Folders and Tags tree surfaces themselves are removed. Tag removal remains
  reachable via the "Tag Chats..." multi-select toggle on the flat Chats view. The proof-of-concept Chats (Preview) WebviewView
  (claudeNest.chatsPreview) is removed, superseded by the org panel; its
  content-search machinery moved into the org panel host. The unused
  "minisearch" entry in package.json "dependencies" was removed to match the
  slice-2 vendored-module contract (MiniSearch is vendored under
  out/search/vendor/ and shipped by the package step, not an npm dependency).

### Security

- Pre-release security audit (Sprint 2): a 10-lens adversarial security council
  reviewed the entire Sprint 2 change set over three rounds, and every actionable
  finding was fixed before release. A critical archive path-traversal (arbitrary
  file read, write, or delete via an unvalidated chat-id map key reaching
  vscode.Uri.joinPath) is closed by validating every untrusted folder/tag/chat map
  key at the normalize and merge boundaries and confining archive body IO under the
  archive directory (#54). Record-id and color validation, which initially covered
  only reference ids and folder color, now also covers map keys and tag color (#44,
  #52, #54, #56). A defense-in-depth gap where JSON cloning reattached Object
  prototype to the store maps is closed by gating ids at the store mutation sinks
  and rebuilding cloned maps with a null prototype (#58). A restore data-loss that
  deleted the only surviving archived copy of a cleaned-up chat (#48), an archive
  prune that could drop a wanted copy (#50), and a lockfile/manifest drift (#46)
  are also fixed. The final pass reported zero actionable findings; 18 minor
  hardening notes are tracked in #59. The repository is public and was confirmed
  free of committed secrets, with synthetic-only test fixtures, no network calls,
  and no telemetry.

## [0.0.1] - 2026-06-17

First packaged release. Ships all ten dependency-ordered slices (0 through 9):
the namespaced Activity Bar panel and flat Chats view, the per-project metadata
store with reconcile, the single-home Folders view, the many-to-many Tags view
with Untagged, drag-and-drop plus multi-select tagging, links with branch-nested
display, read-only promotable Smart Groups, the cleanupPeriodDays Settings
webview, export/import with cross-machine sync hardening, and the Polish pass
(empty states, cancellable scan progress, walkthrough, gallery icon, marketplace
metadata). Strictly read-only over the transcripts under ~/.claude/projects/;
the only sanctioned write anywhere under ~/.claude is the surgical single-key
settings.json edit through the read-only chokepoint. Packaged as
claude-code-nest-0.0.1.vsix; see TESTING.md for install and the consolidated
manual smoke checklist.

### Added

- Slice 9 (Polish): marketplace metadata, a getting-started walkthrough, a raster
  gallery icon, and a cancellable progress indicator on the explicit Refresh
  commands. package.json gains a top-level "icon": "media/icon.png" (a 256x256 RGBA
  nest-motif tile; media/nest.svg stays the activitybar viewsContainers icon, which
  is not valid as the gallery tile), plus keywords, galleryBanner, homepage, bugs,
  and qna. A contributes.walkthroughs "Get Started with Claude Code Nest" adds four
  markdown steps (open the panel, organize, smart groups, backup) under
  media/walkthrough/. The four Refresh commands (claudeNest.refresh /
  refreshFolders / refreshTags / refreshSmartGroups) now run through a new
  vscode-free orchestration module (src/commands/refreshScanCommands.ts) that wraps
  the scan in vscode.window.withProgress with a CancellationToken: it primes the
  provider snapshot via a new ScanPrimable.primeSnapshot seam, then fires
  onDidChangeTreeData once. getChildren and getParent stay SYNCHRONOUS and read the
  memoized snapshot (the binding rule), so the progress/cancellation lives only on
  the explicit refresh path, not the passive reveal path. The scanner stays
  vscode-free: scanChats gains optional plain-callback options
  {onProgress(done,total), shouldCancel()} that the vscode layer supplies; a cancel
  stops the scan early and returns the partial-but-sorted result rather than
  throwing. FlatProvider gained the same lazy memoized-snapshot shape the other
  three providers already had (records cached until refresh), so priming it under
  progress actually caches the scan. The empty-state contract (a viewsWelcome for
  each of the four views and getChildren-never-throws) was VERIFIED unchanged. The
  extension is telemetry-free (no reporter, no @vscode/extension-telemetry), and the
  new scan-failure/cancellation toast is worded so it never attributes a failure to
  Claude. New headless unit tests cover the scanner progress/cancellation seam
  (scanProgress.test.ts) and the progress-command orchestration
  (refreshScanCommands.test.ts, vscode-free via injected seams); a deferred
  electron-host spec (src/test/integration/activation.test.ts) asserts activation,
  view/welcome/icon/walkthrough contributions, and the empty-state contract against
  the real host.
- Slice 8 (Export/import plus sync hardening): two commands, Export Library to
  JSON (claudeNest.exportLibrary) and Import Library from JSON
  (claudeNest.importLibrary), plus an additive cross-machine reconcile that runs
  on activation and on window focus, and a debounced opt-in auto-export snapshot
  with retention. Export writes ALL projects with their per-project and per-record
  stamps to a user-chosen JSON envelope ({ version, exportedAt, projects }) as the
  authoritative backup. Import does scratch-validate-before-swap: it parses,
  validates the envelope WRAPPER shape, migrates the envelope across export-format
  versions (a SEPARATE version from the per-project SCHEMA_VERSION), runs each
  embedded project through the existing schema.migrateProjectMeta (REUSED, not
  duplicated, preserving each project's __unknown forward-compat escrow), and only
  THEN merges additively per project via store.putProjectMeta, NEVER deleting a
  project absent from the file. The additive per-project merge applies the pinned
  collision identity rule: folders and tags union by id (same-id conflict resolved
  by the higher document updatedAt), chat tags union as a set, chat links union
  deduped on the exact (targetChatId, kind) pair (matching addLink), and chat
  folderId is the last-writer-wins scalar arbitrated by the per-RECORD
  ChatMeta.updatedAt (there is no per-scalar-field stamp and SCHEMA_VERSION is not
  bumped); a genuine differing-non-null folderId on both sides is the irreducible
  conflict floor, counted and surfaced through an honest last-writer-wins warning
  toast. The cross-machine reconcile (reconcileSync) detects a foreign-device
  wholesale-replace by diffing the live synced value against a LOCAL-ONLY on-disk
  shadow (the last value this device wrote or saw, stored under the non-synced
  nest.shadow.v1:: key so isMetaKey is false and it is never swept into
  setKeysForSync), using the per-project/per-record deviceId and updatedAt stamps
  as the signal; on a detected foreign write it merges additively (the same
  union/LWW shape as import) so a foreign opaque-value replace does not silently
  drop local-only organization. Detection is best-effort polling (there is no
  Memento remote-change event): it runs once on activation and again on each
  window focus-gain via vscode.window.onDidChangeWindowState. The opt-in
  auto-export (default off, gated behind a globalState flag with a one-time prompt
  to point a canonical export at a synced or git-tracked location) writes a
  debounced snapshot to context.globalStorageUri and prunes to the most recent N
  (RETENTION_COUNT = 10). The pure modules (src/store/exportImport.ts,
  reconcileSync.ts, schemaMigrate.ts, autoExport.ts) are vscode-free and
  unit-tested headless (round-trip, envelope validation, version migration,
  additive merge and the collision identity rule, the reconcile algorithm,
  retention, and scratch-validate-before-swap); ALL filesystem IO, the activation
  hook, the focus polling, globalStorage access, and the warning toast live in the
  vscode-bound src/commands/exportImportCommands.ts. Because the read-only lint
  bank's first selector is object-agnostic, even a vscode.workspace.fs write trips
  it (the slice-patch assumption that it would not was disproved by the lint gate),
  so all file IO is isolated in the narrow, carve-out-exempted src/store/exportIO.ts
  (added to .eslintrc alongside claudeSettingsIO.ts); it imports no node fs and
  never writes under ~/.claude, so the chokepoint stays intact.

### Fixed

- Slice 8 reconcile data loss: the cross-machine reconcile silently dropped a
  local-only tag, link, or chat when a foreign device delivered a SUBSET snapshot
  (a value missing a record this device had added but never synced). The merge
  correctly unioned the dropped record back, but reconcileAllProjects gated the
  store write on the merge's changed flag, which compares the merged document to
  its BASE. In the reconcile path the base is the local-only SHADOW, so a foreign
  subset produced merged == shadow (changed:false), the write was skipped, the
  store kept the lossy foreign value, and the shadow was then advanced to it,
  making the loss permanent. The fix gates the write on a new storeChanged flag
  (merged differs from the live STORE value, not from the shadow), so a foreign
  subset is always written back and the dropped record is restored; a pure-superset
  foreign write (nothing dropped) still skips the redundant write. The import path
  was never affected because there the merge base IS the live store. Regression
  tests cover the subset restore and the superset no-op at both the pure
  reconcileProjectSync level and the reconcileAllProjects orchestration level.

- Slice 8 auto-export coverage: added headless behavior tests for the AutoExporter
  debounce timer (the named "debounced" ship item) -- the opt-in gate no-op, the
  coalesce-a-burst-into-one-snapshot rule, dispose cancellation, the best-effort
  write-failure swallow, and the prune wiring (listDirectory to computeRetentionPrune
  to delete) -- via a small injected debounce window and an in-memory vscode.fs stub.

- Slice 7 (Settings webview): a gear button on every claudeNest view title
  (claudeNest.openSettings) opens a single reusable, CSP-locked, nonce-scripted
  WebviewPanel that reads and edits Claude Code's GLOBAL cleanupPeriodDays in
  ~/.claude/settings.json. The panel shows the current stored value, or Claude's
  default (CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30) flagged as "using default"
  when the key is absent, alongside a prominent warning that the setting is
  global (it affects every workspace's Claude Code, not just this project). This
  is the ONE sanctioned write anywhere under ~/.claude, and it lands the
  read-only chokepoint that all the prior lint-hardening entries pre-staged:
  src/settings/claudeSettingsIO.ts is now the only module in src that performs a
  write-capable fs call (the eslint no-restricted-syntax bank carves out exactly
  this file plus the test tree, verified by the headless lint gate), and every
  write routes through writeCleanupPeriodDays, which hard-asserts the
  canonicalized absolute target equals the ONE allowed settings.json path and
  throws a SettingsIoError otherwise, so nothing routed through it can ever write
  under ~/.claude/projects/. assertAllowedTarget canonicalizes both the allowed
  path (os.homedir()-anchored, the same anchor chatScanner uses) and the
  candidate via path.resolve + path.normalize, then case-folds ONLY the leading
  drive letter on win32 (the projectKeyResolver convention); it deliberately does
  NOT realpath the target because create-when-missing is in scope and realpath
  throws on a nonexistent path, and a normalized dot-segment path that collapses
  to the allowed path is accepted while a real projects/x.jsonl target is
  rejected. The edit is SURGICAL: a single-key jsonc byte-range splice computed
  by a top-level-only, comment- and string-aware scanner (never
  parse-then-stringify). An existing top-level cleanupPeriodDays has only its
  value bytes replaced (siblings, whitespace, comments, and key order untouched),
  a value already equal to the request is a no-op that rewrites nothing, and an
  absent key is INSERTED AS THE FIRST MEMBER followed by a comma anchored right
  after the opening brace (an empty {} gets the sole member with no trailing
  comma) so every existing member survives byte-for-byte; a same-named key NESTED
  at depth > 1 is never matched (the scanner skips whole bracketed values and a
  depthAt re-check confirms depth 1). EOL is preserved by detecting CRLF anywhere
  in the document, and a missing file is created with a minimal LF document
  containing just the key. A pre-write mtime guard re-stats the file immediately
  before writing and aborts on any change, comparing statSync().mtimeMs (float
  ms, not the second-resolution Date) so a same-second concurrent edit is still
  caught; writeCleanupPeriodDays takes an optional WriteOptions.statMtimeMs
  injection seam (mirroring ScannerOptions / ResolveDeps) because the fs module
  namespace property is non-configurable and cannot be monkeypatched, and the
  atomic temp-write-then-rename (a '.nest-settings-<pid>-<ts>.tmp' sibling) stays
  inside the exempt chokepoint module. Validation (validateCleanupPeriodDays)
  accepts a number or a clean base-10 integer string and rejects decimals,
  expressions, hex, exponent, empty, and negative input with a specific message;
  the webview posts a string and the host echoes the validation error back. The
  webview/host message protocol (handleSettingsMessage) is a pure, vscode-free
  reducer over a typed Inbound/Outbound message union driven through an injected
  SettingsIo seam (a 'ready' yields the current state; a 'save' validates, writes
  through the chokepoint, then replies 'saved' plus a fresh 'state', or 'error'
  on a validation/IO failure), so it is unit-tested with a fake messenger and no
  real panel. The vscode-bound settingsWebview.ts owns only the binding: the
  reusable-panel lifecycle, the per-load nonce and CSP (default-src none, scripts
  gated to the nonce, styles only from the webview source), the asWebviewUri
  asset URLs and localResourceRoots, and the onDidReceiveMessage <-> postMessage
  wiring; it coerces the untrusted inbound message shape before handing it to the
  pure reducer. The body markup ships as media/settings.html and the module
  substitutes the nonce, CSP, and asset URLs into it (they cannot be baked into a
  static file under a CSP that forbids inline script); media/settings.{js,css}
  ship in the VSIX unchanged (.vscodeignore excludes src/**, **/*.ts, and
  out/test/** but not media/**, confirmed by vsce package output, so no
  packaging change beyond the asWebviewUri + localResourceRoots plumbing was
  needed). New modules: src/settings/claudeSettingsIO.ts (the vscode-free
  chokepoint: path canonicalization and assertion, the surgical jsonc edit,
  validation, the mtime guard, and the pure message protocol),
  src/settings/settingsWebview.ts (the only vscode-bound module), and the
  media/settings.{html,js,css} assets. Headless unit tests cover the
  claudeSettingsIO chokepoint against scratch fixtures (preserve siblings and
  formatting on replace, the equal-value no-op, first-member insertion with the
  trailing comma and the empty-{} sole-member shape, CRLF EOL preservation,
  create-when-missing, the nested-same-name non-match, the path-assertion throw
  including the dot-segment-collapse accept and the projects/x.jsonl reject, the
  validation accept/reject boundaries, and the injected-mtime concurrent-edit
  abort) and the message protocol via the fake messenger (ready -> state, save ->
  saved + fresh state, save with an invalid value -> error, an IO throw -> error).
  The vscode-bound panel (the CSP/nonce HTML assembly, asWebviewUri plumbing, and
  the live onDidReceiveMessage wiring) has no headless test and is verified by the
  slice-7 manual smoke (TESTING.md).
- Slice 6 (Smart Groups): a read-only claudeNest.smartGroups tree that recomputes
  four signal groups from the current scan on every refresh, never auto-files a
  chat, and never mutates the store except through an explicit promote command.
  The four signals (all pure, vscode-free, headless-tested) are: by Pull Request
  (SOLID: a chat carries a PR when its transcript had a type "pr-link" line, keyed
  by the canonical owner/repo#number, derived from the explicit pr-link fields OR
  parsed from the PR url path, else a bare #number when no repo is known, else the
  raw url; deriving repo+number from the url means a transcript whose pr-link
  carried only a url and one that carried only repo+number for the SAME PR
  co-locate in one bucket instead of splitting), by Ticket Prefix (best-effort: a 2-to-10
  uppercase-letter, hyphen, digits token anchored at the START of the resolved
  title and followed by a word boundary; essentially absent in this user's data so
  it renders empty cleanly), by Git Branch (best-effort: groups by the gitBranch on
  user/assistant lines, SUPPRESSING the meaningless detached-HEAD bucket so a HEAD
  session and a branchless chat join no bucket; usually empty here), and by Fork
  Lineage (best-effort, often empty: a disjoint-set union over the leading
  message-UUID prefix groups transcripts that share at least MIN_SHARED_PREFIX (2)
  leading uuids into fork families, keeping only families of two or more, with a
  STABLE count-free label so the promote path reuses by name as a family grows).
  Every signal group is ALWAYS present even with zero buckets, so an empty
  best-effort group renders as a childless row marked "best-effort, none" rather
  than vanishing, and getChildren never throws (a scan failure degrades to []).
  Two explicit, idempotent promotion commands turn a chosen bucket into real
  metadata: claudeNest.promoteSmartGroupToFolder files every member into a
  top-level folder and claudeNest.promoteSmartGroupToTag applies a tag to every
  member. Idempotency is two-level: membership (setChatFolder is last-write,
  addChatTag dedupes, so re-promoting a member is a no-op) AND group identity
  (idempotency-on-NAME: a second promote reuses the existing top-level folder
  matched by name, or the existing tag matched by label, rather than minting a
  duplicate). The promote batch follows the deleteFolder-cascade shape: N
  synchronous store calls coalesce into one pending write, then one flush and one
  refresh; a promote with no resolved project, an empty name, or zero members is a
  null no-op. New id-grammar surface: the four signal groups are keyed by the
  separator-free reserved sentinels __smart_pr__, __smart_ticket__,
  __smart_branch__, __smart_fork__ (added to RESERVED_SENTINELS so the id factory
  can never mint one), and a bucket row is keyed by a new two-char '::' namespace
  ('<groupId>::<bucketKey>') layered over the existing single-char ':'/'#'/'>'
  composite separators; the '::' token lives only under a '__smart_*__' prefix that
  the other views never mint or split, and a chat-occurrence row under a bucket is
  '<bucketNodeId>::<chatId>' so the SAME chat appearing in two buckets (it can carry
  a PR and a branch) yields two distinct tree-wide-unique nodes that each
  dereference the ONE shared ChatRecord. Node objects are memoized by id and the
  cache is pruned to the live id set on each refresh. New modules:
  src/smart/smartGroupEngine.ts (the pure composition and the bucket-id grammar),
  src/smart/signals/{bucket,pr,ticket,branch,forkLineage}.ts (the four pure
  signals), src/commands/promoteSmartGroup.ts (the two idempotent promote commands),
  src/views/smartGroupsProvider.ts (the only vscode-bound module). Headless unit
  tests cover each signal as a pure function (PR key precedence and co-location,
  the ticket prefix accept/reject boundary cases, the HEAD suppression, fork-lineage
  on synthetic shared and divergent uuid prefixes including the transitive union and
  the two-member-minimum and longest-common-prefix), the engine assembly (four
  groups always present, empty groups, the '::' bucket-id round-trip), the id-factory
  sentinel additions, and the promotion orchestration (idempotency-on-name folder
  reuse and tag-label reuse, the no-project/empty-name/zero-member null guards,
  membership dedup on re-promote, one refresh per batch). The vscode-bound view
  (the tree rendering, the promote context menu, empty-group rendering) has no
  headless test and is verified by the slice-6 manual smoke (TESTING.md).
- Slice 5 (Links plus branch display): a chat can be linked to another chat from a
  chat row in any view (the claudeNest.linkToChat command), and a linked child can be
  unlinked from its designated parent's context menu (claudeNest.unlinkChat). A
  kind:'parent' link on a SOURCE chat pointing at a TARGET chat makes the target
  render NESTED beneath the source in the Folders tree as a distinct linkedChild node
  with a git-branch ThemeIcon; the schema and model also carry a kind:'related'
  cross-reference link (no nesting), but the user-facing picker offers only 'parent'
  this slice because a related link has no read/navigate/remove surface yet (the
  'related' kind is deferred to a later slice that renders and unlinks it, so a user
  cannot create an invisible, unremovable link). Because the store lets a child be the
  target of parent links from more than one source, links.ts pins ONE deterministic
  DESIGNATED parent per child (the lexicographically smallest source chat id) so the
  child nests under the same parent on every render and the traversal is deterministic;
  unlink recomputes that designated parent from the current store and removes exactly
  the parent link backing the visible nesting, so the child then nests under the next
  smallest source (the correct remove-this-one-nesting semantics). Transitive cycles
  and diamonds are blocked by a proper visited-set graph traversal at expansion time,
  bounded by a second independent depth cap (MAX_LINK_DEPTH = 16); a broken target (a
  link whose target chat id no longer resolves to a scanned chat, e.g. the target was
  deleted on disk) still renders MUTED and unlink-able but is a leaf (its record is
  unknown, so it is never recursed into). A drop landing on a linkedChild row in the
  Folders view files the dragged chat ALONGSIDE the linked child (resolving the child's
  underlying chat's current home folder via a ChatHomeResolver), and returns a strict
  no-op sentinel when that home cannot be resolved, so a drop on a linked-child row
  never silently unfiles the dragged chat. The cross-view drag carrier was also
  corrected this slice: the cross-tree payload rides an in-process singleton stash
  (src/dnd/dragContext.ts), because VSCode 1.66 does NOT deliver a source controller's
  custom DataTransferItem to a peer controller's handleDrop (it re-applies the source
  handleDrag items only when source view === destination view); on a real cross-tree
  drop the peer controller receives at most an OPAQUE host-internal value under the
  source's reserved MIME, which parseChatIds rejects, so handleDrop parses the
  DataTransfer first and falls back to the stash whenever that parse yields no chat ids
  (an absent payload OR the opaque cross-tree value). The link-graph build, the
  single-parent selector, the cycle/diamond traversal with the depth cap, the
  broken-target rule, and the linkedChild composite-id grammar
  (`${parentChatId}>link>${chatId}`, split on the first '>') live in the vscode-free
  src/model/links.ts so the headless gate exercises them; the view layer
  (src/views/linkDecoration.ts and the foldersProvider splice) turns a LinkedChild into
  a muted-or-branch-icon TreeItem and memoizes the node object by id (broken state is a
  reuse discriminator). New modules: src/model/links.ts, src/views/linkDecoration.ts,
  src/commands/linkCommands.ts; foldersProvider gained the linkedChild splice and
  getParent recovery. Headless unit tests cover the parent-source candidate set
  (ignoring self-links and related links), the deterministic smallest-id parent
  selector, the link-forest build, transitive-cycle and diamond detection, the depth
  cap, broken-target handling, the linkedChild composite-id round-trip, the node-object
  memoization reuse rule, and the link-command orchestration (parent link add and
  refresh-once, the no-target and cancel guards, idempotent re-link, unlink recomputing
  the designated parent). The live cross-tree carrier and the linkedChild drop-target
  resolution (both needing the vscode host) are verified by the deferred electron test
  (TESTING.md). Manual smoke (TESTING.md): link chat B under chat A; B renders nested
  under A with the branch icon; a cycle is prevented; a deleted target shows muted;
  unlink removes the nesting; a drop on a linked-child row files alongside it.
- Slice 4 (drag and drop plus context-menu tagging): the primary affordance is the
  canPickMany "Tag Chats..." QuickPick plus an inline tag row button, wired from a
  chat row in ANY view (Chats, Folders) and a tag occurrence in the Tags view; it
  applies to the WHOLE multi-selection, pre-checks only the tags common to every
  selected chat, applies the add/remove diff against each chat's current set, and
  fires a single refresh of both membership views (commands/taggingCommands.ts with
  pure tagSetDiff / commonAppliedTagIds helpers, ui/tagQuickPick.ts). Both the
  Folders and Tags views also register a TreeDragAndDropController (dnd/dndController.ts)
  with canSelectMany: dragging one or more chats onto a folder sets their single home
  (onto the Unfiled bucket or empty space unfiles), and onto a tag adds that tag (onto
  Untagged or empty space is a no-op); the drop is interpreted strictly by the TARGET
  view, never the source. Cross-view drags (a Folders chat dropped on a Tags tag and
  the reverse) work via the reserved-MIME carrier: VSCode 1.66 preserves a custom MIME
  set in handleDrag into handleDrop ONLY for a drop in the same tree, so on a cross-tree
  drop the host strips the shared chat MIME and carries only the SOURCE tree's reserved
  MIME (application/vnd.code.tree.<treeidlowercase>) between two trees of the same
  extension; handleDrag therefore writes the chat-id JSON under BOTH the shared chat MIME
  (the within-view carrier) AND its own reserved MIME (the cross-view carrier), each
  controller lists BOTH reserved MIMEs plus the shared chat MIME in dropMimeTypes so the
  host offers the peer tree as a drop target, and handleDrop recovers the payload from
  whichever recognized MIME is present. A multi-select drop batches into N synchronous
  store calls that coalesce into one pending write, then one flush and one refresh
  (refresh coalescing); a drop with no resolved project, no recognized payload MIME, an
  empty or foreign payload, or no real target is a no-op. The interpretation and payload
  logic stays vscode-free so the headless gate exercises it: dnd/dropReducer.ts holds the
  MIME guard, the folder-move vs tag-add interpretation by target view, the synthetic
  Unfiled/Untagged bucket handling, and multi-node batching with de-duplication;
  dnd/dropPayload.ts holds the tolerant parseChatIds (a missing / null / non-string /
  malformed / non-array value yields [], non-string elements filtered) and the pickPayload
  recognized-MIME selector that recovers a cross-view payload off either reserved MIME and
  prefers the shared chat MIME within-view. The vscode-bound controller only pulls the
  plain values off the real DataTransfer, dispatches the node types by instanceof, and
  applies the reducer's intents. New modules: src/dnd/dropReducer.ts, src/dnd/dropPayload.ts,
  src/dnd/dndController.ts, src/commands/taggingCommands.ts, src/ui/tagQuickPick.ts. Headless
  unit tests cover the pure reducer (MIME guard including a rejected foreign and per-view
  reserved MIME, folder-move vs tag-add by target view, the Unfiled/Untagged/empty-target
  cases, multi-node batching and de-dup, the sentinel-literal contract), the payload helpers
  (parseChatIds tolerance and non-string filtering, pickPayload cross-view carrier selection
  and within-view priority, the reserved-MIME tree-id literals), and the tagging command
  orchestration (project/no-tags/empty-selection guards, single- and multi-chat apply with
  common-set pre-check, add/remove diff, confirm-without-change and cancel no-ops, one
  refresh per batch). The controller's instanceof node-dispatch (chatIdsFromSource,
  targetIdFor) and the live cross-tree carrier behavior are verified by the deferred electron
  test (TESTING.md), since both require the vscode host. Manual smoke (TESTING.md): the
  QuickPick canPickMany tagging from any view; drag a chat onto a folder and onto a tag;
  multi-drag a selection; a real Folders<->Tags cross-view drag; an unrecognized drop source
  is a no-op.
- Slice 3 (Tags view): the claudeNest.tags tree, the MANY-TO-MANY tag membership.
  Create and delete tags; apply or remove a tag on a chat via the row context menu
  or from the Chats / Folders rows. A chat appears once under EACH tag in its
  effective set and once under a synthetic Untagged bucket (sentinel tag id
  __untagged__) when that set is empty. Each on-screen appearance is a distinct
  ChatOccurrence wrapper with its own tree-wide-unique composite id
  ${tagId}:${chatId}; every wrapper dereferences the ONE shared ChatRecord resolved
  from a records map, so the bare record is never returned under two parents.
  getParent splits an occurrence id on the FIRST ':' to recover the single owning
  tag (tagId is separator-free, minted by idFactory.mintTagId or the __untagged__
  sentinel, and chatId is a separator-free UUID, so the split is unambiguous); the
  Tags view reveals a specific occurrence only, while the chat's single-home
  reveal-by-chat target stays the Folders view. A chat's EFFECTIVE tag set is the
  subset of its stored tag ids that still resolve to a real Tag (de-duped,
  order-preserving); a dangling tag id (e.g. a tag deleted on another machine before
  reconcile) contributes no occurrence, so a chat whose every tag id is dangling
  lands in Untagged, mirroring how a dangling folderId routes a chat to Unfiled.
  Deleting a tag removes the tag record AND strips its id from every chat that had
  it (via the store's deleteTag), so no occurrence survives a delete and a chat that
  loses its last tag recomputes into Untagged on the next refresh; chats are never
  deleted. The Untagged membership is RECOMPUTED on every refresh while node objects
  are MEMOIZED by id across refreshes (reused when the shared chat's title and
  timestamp still match) so VSCode's reference-keyed element cache keeps reveal and
  selection stable; the memo cache is pruned to the live id set so it cannot grow
  unbounded. Each tag mutation flushes the store then fires onDidChangeTreeData once
  (refresh coalescing). createTag mints a separator-free id through the shared id
  factory and re-asserts it at the write boundary (assertMintableId), the invariant
  the occurrence grammar depends on. The vscode-free model holds the binding rules:
  the composite-id grammar and the single-owning-tag getParent recovery
  (occurrence.ts: tagOccurrenceId, parseTagOccurrenceId, makeOccurrence,
  canReuseOccurrenceItem, memoizeById) and the many-to-many assembly plus the
  Untagged membership rule (untagged.ts: effectiveTagIds, isUntagged,
  assembleTagsTree), so the provider only delegates and both binding rules are
  exercised by the headless gate. New modules: src/model/occurrence.ts (the
  ChatOccurrence wrapper, the composite-id grammar, and the pure memoization core),
  src/model/untagged.ts (the Untagged bucket sentinel and the many-to-many tree
  assembly), src/views/tagsProvider.ts, and src/commands/tagCommands.ts; idFactory
  now mints tag ids (mintTagId) and the __untagged__ sentinel was already reserved
  out of the mintable space. Headless unit tests cover the five highest-priority
  areas: the composite-id round-trip (including the minted-id and Untagged shapes
  and the malformed-id null cases), tree-wide composite-id uniqueness over a 50-by-8
  synthetic set (proving distinct-wrapper ids for a multi-tag chat and that no chat
  is dropped), the single owning tag per occurrence, Untagged membership equal to
  the empty effective-tag set (including the all-dangling case), and node-object
  memoization by id; plus the command orchestration (create mints separator-free and
  refreshes once, delete confirms and strips the tag from every chat, add offers only
  not-yet-applied tags, remove drops only the occurrence's owning tag). Manual smoke
  (TESTING.md): tag one chat with two tags and confirm it appears under both; an
  untagged chat appears only under Untagged; removing the last tag moves it to
  Untagged; deleting a tag removes it from every chat without deleting any chat.
- Read-only chokepoint lint hardening (pre-Slice-3, while no src file imports fs):
  closed two pre-existing chinks that would have breached the chokepoint once a
  write-capable slice (Slice 7) lands. First, an arbitrarily-named whole-module
  alias from require (const myfs = require('fs'), or a reassignment
  later = require('fs')) defeated the fs-object-name gate on computed write calls
  (myfs[m](...)), so the require module alias is now banned at the binding for fs,
  node:fs, and fs/promises; the only sanctioned whole-module reference stays a
  namespace import (import * as fs), whose writes are member or computed calls
  already covered. Second, aliasing a write-capable member off a require result
  (const w = require('fs').writeFile) escaped both the const w = fs.writeFileSync
  alias selector (its object was a require CallExpression, not the fs identifier) and
  the bare-identifier backstop (which may not name an async write), so that
  require-result member alias is now banned across all write names. The bare-identifier
  backstop was also extended to the async write names writeFile / appendFile /
  copyFile. Verified against an exploit probe (every require-alias, computed-key, and
  member-alias write entry point errors) and a legitimate-reads probe (namespace-import
  reads and a non-write member alias off require('fs').readFileSync stay clean). Lint
  runs in pretest, so the strengthened guard is enforced by the headless test gate,
  not by review.
- Read-only chokepoint lint hardening: closed a hole where a require-destructured
  fs write (const { writeFile } = require('fs/promises'), sync or async) slipped
  the guard because the require-destructure selector could never match (it tested
  init as both an ObjectPattern and a require call at once). The selector now
  targets the destructure binding on the declarator with an fs-module-constrained
  require initializer, covering sync and async write names; a non-fs
  require-destructure was verified to stay clean. Closes the gap before the
  write-capable settings slice lands.
- Slice 2 (Folders view): the claudeNest.folders tree, a single-home nestable
  hierarchy. Create (including slash-nested names), rename, and delete folders;
  assign a chat to a folder via the row context menu or the command palette. A
  slash name like Work/ClientA expands at create time into a CHAIN of real
  parent-child Folder records (Work parentId=null, ClientA parentId=Work),
  reusing any existing segment by (parentId, name) and minting a new record only
  for a missing segment, so no literal slash is ever stored in a single
  Folder.name and parentId stays meaningful for the delete cascade and getParent.
  Each chat appears under EXACTLY one folder via the composite member-node id
  ${folderId}#${chatId}, with a synthetic Unfiled bucket (sentinel folderId
  __unfiled__) holding every chat whose folderId is null or whose home folder no
  longer resolves; getParent splits a member id on the FIRST # to recover the one
  owning folder. Creating a child under a right-clicked folder roots the slash-path
  expansion at that folder's AUTHORITATIVE id (expandFolderPath startParentId), not
  by recomposing and re-matching its name path, so a new child always hangs under
  the exact clicked folder even when a same-named sibling exists; renameFolder
  rejects a name that would collide with an existing sibling (parentId, name) so
  the reuse key and the assign picker stay unambiguous. Folder deletion cascades to
  descendant folders and unfiles their
  member chats (chats are never deleted). Node objects are memoized by id across
  refreshes so reveal and selection stay stable, and a folder mutation flushes the
  store then fires onDidChangeTreeData once (refresh coalescing). The single-home
  getParent resolution (chatId -> owning folder id with the Unfiled fallback) and
  the node-object memoization reuse rule live in the vscode-free folderTree model
  (buildChatHomeIndex, resolveChatHomeFolderId, canReuseFolderItem,
  canReuseChatMemberItem) so the provider only delegates and both binding rules are
  exercised by the headless gate. New modules:
  src/model/idFactory.ts (the vscode-free id factory: mints separator-free folder
  ids and exposes the guard/assertion that rejects ':' '#' '>' and excludes the
  __unfiled__ / __untagged__ sentinels from the mintable space, per
  ARCHITECTURE.md "enforce in the id factory"), src/model/folderTree.ts
  (vscode-free slash-path expansion, single-home tree assembly, composite-id
  grammar, delete-cascade set, the pure getParent resolution, and the memoization
  reuse predicates), src/views/foldersProvider.ts, and
  src/commands/folderCommands.ts. Headless unit tests cover slash-path expansion
  and reuse (including startParentId rooting under a clicked-parent id with a
  same-named-sibling guard), the single-home invariant (including dangling-home and
  dangling-parent routing), tree assembly, the composite-id round-trip, the pure
  getParent home-index resolution and the memoization reuse predicates, the
  rename sibling-name-collision guard, the cascade set with a cyclic-store guard,
  and the id factory's separator/sentinel guarantees across many generations.
- Slice 1 (storage): the MetadataStore over globalState with one synced key per
  project (nest.meta.v1::<projectKey>) and setKeysForSync refreshed to the union
  of all known project keys whenever a new project key first appears (and
  re-established from the Memento on reload). The full ProjectMeta schema
  (folders, tags, chats with per-record updatedAt + deviceId stamps, plus the
  per-project stamps), with a defensive, total migration that lifts an older or
  malformed stored value to the current schemaVersion (drops unknown fields,
  defaults missing ones, preserves what normalizes from a newer-version value).
  preserves what normalizes from a newer-version value, AND escrows that newer
  writer's unrecognized top-level fields verbatim under a __unknown carrier while
  keeping the document at its original higher schemaVersion, so mutating a
  newer-schema synced document on an older build does not strip the foreign
  machine's richer data and clobber it on the next sync). Writes are debounced
  and serialized: a burst of mutations coalesces into one persisted write per
  project and writes never interleave, last-writer-wins in-process. The
  serialized write chain is fault-tolerant: a rejected globalState.update (a
  transient Settings Sync write failure, locked storage, quota) no longer poisons
  the chain and silently stops all later persistence for the session; the failed
  write is re-staged and retried on the next debounce tick and the chain tail
  always resolves. Orphan reconcile (src/store/reconcile.ts) soft-marks records
  missingSince, soft-archives them only after a grace window, and never
  hard-deletes; a zero-result or suspiciously-low-count scan for a project that
  had records is treated as suspect and the whole pass is skipped. Orphan state
  is LOCAL ONLY: it lives on a separate, non-synced companion document
  (nest.local.v1::<projectKey>) that is never registered for sync. A per-install
  deviceId (src/store/deviceId.ts) stamps every write. New modules:
  src/store/schema.ts, src/store/metadataStore.ts, src/store/reconcile.ts,
  src/store/deviceId.ts. The store, schema, reconcile, and deviceId modules are
  vscode-free and depend on locally-declared structural seams (SyncMemento,
  DeviceIdStore); extension.ts adapts the real context.globalState to those
  seams at the call site. Headless unit tests cover CRUD, schema versioning and
  migration, the debounce/serialize coalescing and last-writer-wins guard, the
  setKeysForSync refresh-on-new-key union, the reconcile transitions, and the
  zero-result / low-count circuit breaker.
- Slice 0 (scaffold, read JSONL, flat list): the namespaced claudeNest Activity
  Bar view container and the claudeNest.flat tree view listing every chat for the
  active workspace as a title plus a relative time. Clicking a chat fires Claude
  Code's documented URI handler (vscode://Anthropic.claude-code/open?session=...)
  through an injectable openExternal. New modules: src/model/types.ts,
  src/claude/jsonlReader.ts (tolerant line-type scan), src/claude/chatScanner.ts
  (read-only *.jsonl glob under ~/.claude/projects), src/claude/projectKeyResolver.ts
  (encodes every non-[A-Za-z0-9-] character to a hyphen, matching Claude's on-disk
  rule, plus case-insensitive drive-letter match and cwd-scan fallback),
  src/launch/uriLauncher.ts, src/views/relativeTime.ts (vscode-free relative-time
  formatter), src/views/flatProvider.ts. Headless unit tests cover the reader,
  resolver (including a non-separator special-character row), relative-time
  boundaries, launcher, and scanner against scratch fixtures.
- Read-only chokepoint lint guard: a bank of eslint no-restricted-syntax
  selectors bans every write-capable fs call outside the sanctioned settings-IO
  module (src/settings/claudeSettingsIO.ts) and the test fixtures, at every entry
  point a write can take: member call (fs.writeFileSync), computed access
  (fs['writeFileSync']), named/destructured import from fs/node:fs/fs/promises,
  require destructure, alias (const w = fs.writeFileSync), and the bare call once
  in scope. A namespace import (import * as fs) stays legal because writes through
  it are member or computed calls already covered. Lint is wired into pretest, so
  it runs as part of the headless `npm test` gate, enforcing the "nothing writes
  under ~/.claude/projects/" invariant in CI rather than by review alone.
- Initial repository scaffold: minimal TypeScript VSCode extension (package.json
  with engines.vscode ^1.66.0, tsconfig, eslint, mocha unit harness), the
  PLAN.md slice cut, the ARCHITECTURE.md binding design rules and sync
  architecture, an empty DECISIONS.md, and the .claude/workflows/nest-slice-build.js
  autonomous build-orchestration workflow.
