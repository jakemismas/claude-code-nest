# Claude Code Nest: Architecture and Binding Design Rules

This document is the living contract for the build. The fit review and the
adversarial review lenses check each slice against it. Build agents must honor
the binding rules below. Keep this file updated as slices land.

## Overview

Claude Code Nest is a VSCode extension that overlays a virtual organization
layer (folders, tags, links, and a settings editor) on Claude Code chat
transcripts for a single project. It contributes its own Activity Bar view
container (claudeNest) and never modifies Claude's data beyond one sanctioned,
guarded settings write. Since Sprint 3 slice s3a-view-consolidation the org
panel webview is the SOLE browsing surface (UI-SPEC.md deviation 5); the
Archive tree and the settings editor tab survive only until part 2 ships their
in-panel replacements.

## Module map (navigation index)

The extension is one vscode entry point (src/extension.ts) wiring pure, vscode-free
logic modules to thin vscode-bound surfaces. The unit gate imports only the
vscode-free modules. This index says where each binding contract below lives.

- Read path (vscode-free): src/claude/jsonlReader.ts is the SOLE transcript parser;
  src/claude/chatScanner.ts is the SOLE file reader (globs *.jsonl); src/claude/
  bodyReader.ts reads one chat's bodies on demand and discards them; src/claude/
  projectKeyResolver.ts encodes the project key.
- Store and sync (vscode-free logic, thin memento adapter in extension.ts):
  src/store/metadataStore.ts (the synced nest.meta.v1::<projectKey> document and the
  local-only nest.local.v1 orphan document), schema.ts/schemaMigrate.ts (migration and
  the per-scalar LWW arbiter mergeProjectMeta), reconcile.ts (orphan reconcile),
  reconcileSync.ts (cross-machine reconcile against the local nest.shadow.v1 shadow),
  exportImport.ts/autoExport.ts (backup), deviceId.ts.
- Write carve-outs (the ONLY two modules exempt from the eslint write-ban bank):
  src/settings/claudeSettingsIO.ts (the one sanctioned ~/.claude write, path-asserted)
  and src/store/exportIO.ts (globalStorage and user-chosen export targets). Both go
  through src/store/exportPathGuard.ts (assertNotUnderClaudeProjects, the pure,
  headless-tested guard).
- Id grammar and models (vscode-free): src/model/idFactory.ts (minting plus the
  separator and sentinel guard), folderTree.ts, occurrence.ts, untagged.ts, links.ts,
  types.ts.
- Drag and drop: src/dnd/dropReducer.ts is the FROZEN pure interpretation contract
  (never modified after slice 6); dndController.ts (native tree, retired from wiring
  but kept and unit-tested), dragContext.ts (cross-tree stash, native path only),
  webviewDropAdapter.ts (the org-panel extraction shell), dropPayload.ts.
- Search (host-only): src/search/searchIndex.ts (vscode-free) and searchStore.ts
  (persists via exportIO to globalStorage, never synced). MiniSearch is vendored at
  src/search/vendor/minisearch.js and copied to out/ by the compile step, never an npm
  dependency.
- Smart groups (vscode-free signals): src/smart/smartGroupEngine.ts plus
  src/smart/signals/{pr,ticket,branch,forkLineage,bucket}.ts. The Smart Groups
  TREE was retired in slice s3a-view-consolidation; the engine and the promote
  commands (programmatic, palette-hidden) remain for a future in-panel surface.
- Export and rollup (pure): src/export/chatExport.ts, src/rollup/tokenRollup.ts,
  src/rollup/rollupReport.ts.
- View surfaces (post s3a-view-consolidation, UI-SPEC.md deviation 5): the live
  views are the org panel (src/views/orgPanelWebview.ts plus the pure
  orgPanelModel.ts), the SOLE browsing surface, and Archive (archiveProvider.ts),
  which survives until part 2 ships the in-panel Archive overlay. The flat Chats
  tree (flatProvider.ts) and Smart Groups tree (smartGroupsProvider.ts) are
  DELETED; the OPEN_CHAT_COMMAND id now lives in src/launch/uriLauncher.ts.
  FoldersProvider.ts and TagsProvider.ts are KEPT as non-view services
  (project-key resolution, link target pick list, the tokenTotalsByChat rollup
  seam, reveal and home resolution) since slice 6 retired their trees;
  chatTooltip.ts/chatMeta.ts/relativeTime.ts/linkDecoration.ts are vscode-free
  view helpers.
- Commands: src/commands/* are vscode-thin orchestrators over the pure modules above
  (folders, tags, tagging, links, curation, export, rollup, export-import,
  promote-smart-group, preview, refresh-scan); src/settings/settingsWebview.ts is the
  vscode-bound settings panel.

## Ground-truth calibration (verified against the real files, read-only)

- Filename equals sessionId (a UUID). The chat scanner globs *.jsonl only.
- Titles, PR data, and timestamps are carried on dedicated JSONL line TYPES, not
  as top-level keys on arbitrary lines:
  - type "ai-title" carries aiTitle.
  - type "custom-title" carries customTitle.
  - type "pr-link" carries prNumber, prUrl, prRepository.
  - user or assistant lines carry timestamp, cwd, gitBranch, uuid, parentUuid.
  The reader scans by line type and tolerates unrelated types (queue-operation,
  hook_success, attachment, deferred_tools_delta, last-prompt) without throwing.
  Title resolution order: customTitle, then aiTitle, then slug, then a truncated
  first user-message text.
- Project-key encoding rule (verified exact): lowercase only the leading drive
  letter, then replace EVERY character that is not [A-Za-z0-9-] with a single
  hyphen, preserving existing hyphens. This is the full character class Claude
  Code uses on disk, not just the path separators: any non-alphanumeric character
  in a folder name (space, dot, '+', '&', '(', ')', ',', apostrophe, '@', '!',
  etc.) collapses to a hyphen. Verified against the live ~/.claude/projects
  listing: c:\Users\JakeMismas\Documents\Claude Code - Nest maps to
  c--Users-JakeMismas-Documents-Claude-Code---Nest, and c:\Users\JakeMismas\Notes+
  Github maps to c--Users-JakeMismas-Notes--Github (the '+' AND the space each
  become a hyphen). A separators-only encoder leaves the '+' intact and returns
  null for that project, so the broad class is mandatory. The transcript cwd field
  is the self-verification anchor: derive the key, then confirm by re-encoding a
  transcript's cwd, and fall back to a cwd scan across ~/.claude/projects/* if
  the exact directory is missing.
- Smart-group signal strength for this user's real data: prNumber and prUrl are
  the only clean, present signal (roughly 5 to 10 percent of files).
  Ticket-prefixed titles are essentially absent, gitBranch is almost always
  "HEAD", and no two transcripts shared a leading message-UUID sequence in the
  sample. Build the ticket and fork-lineage groups best-effort and let them
  render empty gracefully. PR grouping is the one to make solid. (Slice 6 landed
  this: the four signals live in the vscode-free src/smart/* modules; the gitBranch
  group additionally SUPPRESSES the meaningless detached-HEAD bucket, and the
  fork-lineage group requires a shared leading message-UUID prefix of length >= 2
  and a family of two or more. The signal-group row ids are the four reserved
  '__smart_*__' sentinels and a bucket row is keyed by the '::' namespace; see the
  Separator-namespace discipline rule and DECISIONS.md.)
- cleanupPeriodDays is currently ABSENT from ~/.claude/settings.json. The present
  top-level keys are permissions, model ("opus[1m]"), and hooks (with absolute
  Windows paths). The webview must handle read-when-missing (show Claude's
  default) and create-on-write without disturbing siblings.

## Tier-A summary reductions (Sprint 2, slice 0)

The single transcript reader (src/claude/jsonlReader.ts) retains a bounded,
read-only tier-A summary per chat on TranscriptScan, carried through readChat onto
ChatRecord. These are the ONLY transcript-content fields the scan snapshot holds;
full message BODIES are never retained on the snapshot and are read on demand for
one chat and discarded (slice 1's bodyReader). The fields, all defaulted to
0/null/[] when absent and absorbed additively alongside the slice-6 signal
absorbers without disturbing title/timestamp/PR/branch/uuid logic or the tolerant
skip-unknown-types contract:

- messageCount: count of user/assistant lines (not raw JSONL lines); tool_result
  feedback user lines still count here.
- lastMessageText (truncated) plus lastMessageRole ('user' | 'assistant' | null):
  the LAST GENUINE user/assistant turn, for the awaiting-reply heuristic and
  previews. A textless assistant turn (pure tool_use) is a real assistant action
  and DOES advance the role to 'assistant', keeping the prior snippet text. A
  tool_result-only user line, however, is the harness feeding a tool output back
  into an assistant loop (the dominant real user-line shape) and is NOT a human
  turn: it does not advance the role to 'user' and does not overwrite the snippet,
  so the slice-6 awaiting-reply heuristic (lastMessageRole === 'user') reads human
  intent rather than the tool loop.
- tokenTotals: the four trusted message.usage counts (input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens) summed ONCE per logical
  assistant turn. A turn spans several JSONL lines that share one message.id and
  repeat the identical usage block verbatim (verified ground truth), so usage is
  deduped by message.id and counted on first sighting; a per-line sum over-counts
  3-5x. An id-less line cannot be deduped and is always counted. All other usage
  keys are ignored, and a missing or malformed usage block or field contributes 0.
- filesTouched: distinct file_path values from tool_use blocks (verified ground
  truth: file_path rides Read, Edit, AND Write blocks, so this is "files
  referenced" including read-only Reads, not strictly "files edited"), deduped in
  first-seen order and CAPPED (MAX_FILES_TOUCHED) like leadingMessageUuids.
- models: distinct message.model values (assistant lines), first-seen order.

usage, model, and tool_use blocks are assistant-line-only (verified ground truth),
so those absorbers fire only on assistant lines; messageCount and the last-message
absorber fire on both user and assistant lines. The reader stays the SOLE parser
and the scanner the SOLE file reader; no slice adds a second scan path.

## On-demand body reader and rich hover card (Sprint 2, slices 1 and tier-b)

The scan snapshot holds only the bounded tier-A reductions above; full message
BODIES are never retained on it. When a feature needs the full text of ONE chat
(the "Preview Full Chat" command), the vscode-free body reader
(src/claude/bodyReader.ts, readTranscriptBodies) reads that single transcript on
demand and returns the bodies to the caller, which uses and discards them. No
provider holds the result and bodies never enter the scan snapshot, preserving the
"bounded reductions on the snapshot, full body never" invariant.

The rich hover-preview card is built by a PURE, vscode-free builder
(src/views/chatTooltip.ts, buildChatTooltip) that returns plain MARKDOWN text and
takes only plain data: a ChatRecord plus the chat's resolved folder NAME and full
TAG label set. The provider wraps the returned string in a vscode.MarkdownString.
This split keeps the builder in the headless unit gate, mirroring the
occurrence.ts / tagsProvider.ts and dropReducer.ts / dndController.ts
vscode-free-builder convention (the unit test that imports the builder must not
transitively require vscode). The card renders the binding UI-SPEC fields (folder,
age, ~token total, full tag set, and the first/last message snippets that ride the
tier-A scan, never the full body); models and the files-touched count are additive
context. tokenBadge in the same module is the single source of the row's ~token
description so the badge and the card's token line agree.

To feed the builder REAL folder/tag values, each provider resolves the project key
on demand (resolveProjectKey, so the lookup recovers without a window reload),
reads the project meta ONCE per render, and resolves each row's folder name and
tag set (src/views/chatMeta.ts resolveFolderName / resolveTagLabels) at the call
site before handing those plain values to buildChatTooltip. The store read is
tolerant: an unresolved key leaves folder/tags empty and the card renders
"Unfiled"/"none" rather than throwing, keeping the never-throw-out-of-getChildren
rule (DECISIONS.md 2026-06-19 Slice 1). Each kept builder folds the card inputs
into its node memoization key (cardFolderName/cardTagsSignature) so a re-file or
tag edit rebuilds the row's node and its tooltip while an unchanged row keeps its
object. (The flat Chats tree, this card's original third surface, was retired in
slice s3a-view-consolidation, and the kept builders now ride the view-less
folders/tags services, so no attached view renders the card until the s3b
in-panel hover card lands; the rule continues to bind the kept node builders.)

## Search-index location (Sprint 2, slice 2) — binding

Full-text content search (slice s2-fulltext-search) is built on MiniSearch with
these binding placement rules. They exist so the search feature cannot violate the
read-only invariant, the sync blast-radius bound, or the "bounded reductions on the
snapshot, full body never persisted" tier-A rule.

- MiniSearch is VENDORED, not an npm dependency. It lives at
  src/search/vendor/minisearch.js (the upstream published UMD/CommonJS dist,
  byte-faithful aside from a license/version header and the stripped sourceMap
  comment, MIT, version pinned in the header) plus a hand-thin
  src/search/vendor/minisearch.d.ts covering only the constructor and the
  add/addAll/search/toJSON/loadJSON surface searchIndex.ts uses. It is NOT added to
  package.json (the extension stays zero-runtime-dependency) and `npm install
  minisearch` is NOT run. The reason is a hard packaging conflict: .vscodeignore
  excludes node_modules/** AND the installCheck packages with
  `vsce package --no-dependencies` (which skips the dep walk), so an npm-installed
  minisearch would never ship and the install proof would silently false-pass. The
  compile script copies src/search/vendor/{minisearch.js,minisearch.d.ts} into
  out/search/vendor/ after tsc (the same `node -e` fs shape as the clean script);
  out/** ships in the VSIX (only out/test/** is excluded), so the require resolves
  at runtime. searchIndex.ts imports it by the RELATIVE path './vendor/minisearch',
  never the bare specifier 'minisearch'. installCheck, .vscodeignore,
  --no-dependencies, and the package.json dependencies (absent) all stay unchanged.
  See DECISIONS.md 2026-06-19 Slice s2-fulltext-search.
- MiniSearch is HOST-ONLY. The index and all ranking/snippeting are host modules
  (src/search/searchIndex.ts, vscode-free; src/search/searchStore.ts, vscode-thin).
  The webview only posts a query string and renders host-returned ranked rows, so
  there is exactly one vendored copy under out/search/vendor/, no media/ copy, and
  no webview-CSP concern.
- The index lives in extension globalStorage, NEVER under ~/.claude/projects/, and
  is NEVER synced. searchStore.ts persists/loads ONLY through exportIO
  (exportIO.writeTextFile/readTextFile against context.globalStorageUri), which
  runtime-asserts assertNotUnderClaudeProjects before every write; it introduces no
  new fs write path, so the eslint write-ban bank stays intact. The index is a FILE
  in globalStorage, not a globalState key, so it is structurally outside the
  MetadataStore sync surface and is never registered with setKeysForSync — the
  synced surface stays exactly nest.meta.v1::<projectKey>. A missing or unreadable
  persisted index falls back to an in-memory rebuild; the persisted index is a
  warm-start cache, never the source of truth.
- The PERSISTED index is built from TIER-A fields ONLY (title, lastMessageText,
  filesTouched), so no body-derived token is ever written to disk, keeping the
  "bounded reductions on the snapshot, full body never persisted" invariant honest.
  Full-body search is an IN-MEMORY concern: the live index is built in memory from
  the tier-A fields plus each chat's body read on demand via
  bodyReader.readTranscriptBodies and DISCARDED once indexed (the index holds search
  tokens, never the raw body, and nothing about it enters the scan snapshot). See
  DECISIONS.md 2026-06-19 Slice s2-fulltext-search fold-in 3.

## Archive as an org layer plus a Nest-owned body copy (Sprint 2, slice 4) — binding

Star and user-archive are CURATION SCALARS on the synced ChatMeta (slice 3); slice
4 adds the commands, the Archive view, and the Nest-owned body copy. These rules are
binding so the archive feature cannot violate the read-only invariant or the
synced/local flag separation.

- The user-archive FLAG is the SYNCED ChatMeta.userArchived, written ONLY through
  store.setChatArchived (which sets/clears archivedAt coupled to the flag, slice 3).
  It is DISTINCT from the local-only orphan-reconcile LocalChatState.archived on the
  separate nest.local.v1 document (schema.ts:80-96, 125-129): userArchived is a
  deliberate, synced curation choice; LocalChatState.archived is missing-on-disk
  machinery (DECISIONS.md 2026-06-15). archiveProvider lists chats by
  store.getProjectMeta(projectKey).chats[id].userArchived === true and NEVER reads
  LocalChatState.archived. Restore calls store.setChatArchived(false) (clearing
  archivedAt); star/unstar (store.setChatStarred) is INDEPENDENT of the archive flag,
  so a restored chat keeps its star. (Slice 4 unit test asserts the provider reads
  userArchived, not the orphan flag.)
- The Nest-owned BODY COPY is a FILE in extension globalStorage, LOCAL and NEVER
  synced. It never renames, moves, or deletes anything under ~/.claude/projects. On
  archive, the full body is read ONCE on demand (bodyReader.readTranscriptBodies,
  read-only) and a copy is written to globalStorageUri/archive/<sessionId>.json so
  the chat survives Claude's cleanup. archiveBodyStore.ts mirrors searchStore.ts
  EXACTLY: it does NO node fs and NO direct vscode.workspace.fs; every
  write/read/list/delete goes through exportIO (writeTextFile/readTextFile/
  listDirectory/deleteFile/ensureDirectory), which runtime-asserts
  assertNotUnderClaudeProjects before every write/createDirectory/delete. So
  archiveBodyStore.ts is under the FULL read-only lint bank (it is NOT a carve-out)
  and cannot write a transcript; ensureDirectory runs before the first write; one
  file per archived chat keyed by the separator-free sessionId UUID; and an exposed
  archivedBodyPath helper lets the guard test assert the target is under globalStorage
  and that a projects-path globalStorage throws.
- The KEEP-WINDOW is the extension's FIRST contributes.configuration value,
  claudeNest.archiveKeepWindowDays (enum 7/30/90 and 0 for never). It is read in the
  vscode-thin layer via vscode.workspace.getConfiguration('claudeNest') and passed as
  a plain keepWindowDays number into the PURE archiveRetention.ts policy, which never
  reads getConfiguration (the headless gate would break otherwise). The policy
  decides keep|prune purely from {archivedAt, starred, keepWindowDays, now} with no
  clock or config access, so the boundary case (now - archivedAt exactly ==
  keepWindowDays * MS_PER_DAY) is deterministic. keepWindowDays <= 0 is the
  never-prune sentinel (keep all), and STARRED exemption takes precedence over the
  window (a starred copy is always kept, even past the window). A prune pass runs
  best-effort on activation.
- A LIVE-STORE BACKSTOP guards the prune against a stale copy snapshot. Each body
  copy carries its own {archivedAt, starred} snapshot, kept current only best-effort
  (updateStarFlag swallows failures; a star applied where the copy never landed, or a
  star synced from another device that never touched this install's copy, can leave
  the snapshot stale-false while the LIVE synced flag is true). So before deleting a
  copy the pure policy marked prune, pruneArchivedBodies consults an optional
  isLiveProtected(sessionId) check: when the chat is still userArchived AND starred in
  the live synced meta it is force-kept. The check is a no-write read of getProjectMeta
  wired in the vscode-thin layer (extension.ts), so the pure policy and the sync
  surface stay unchanged; a throwing check fails SAFE toward keep. Starring is the
  user's explicit "do not lose this" signal and the copy is the chat's only durable
  form after Claude's cleanup, so a stale-snapshot star must never let the prune delete
  it.
- The Archive view registers WITHOUT a dragAndDropController (read-mostly;
  archive/restore are commands, not drops; the retired smartGroups view shared this
  shape) and takes the same (workspacePath, store) deps as FoldersProvider, resolving the
  project key on demand. getChildren(undefined) returns [] and never throws; an
  onView:claudeNest.archive activationEvent and a viewsWelcome empty-state entry back
  the view. An archived chat whose transcript was cleaned up out of band still lists
  here (membership comes from the synced flag, not the scan); its title falls back to
  the body copy's stored title (loaded asynchronously). Its default click is Open when
  the live transcript is still present, but when the transcript is gone the click
  PREVIEWS the Nest-owned body copy instead (claudeNest.previewArchivedChat), so a
  cleaned-up row stays openable — the whole point of the copy. previewArchivedBody
  reads the copy by sessionId and routes through the SAME pure formatter as the live
  preview (formatPreviewLines), so the two renderings are byte-identical; a missing or
  empty copy surfaces an info notice, never a blank document.
- The STAR BADGE renders on every chat-row node builder (folders members, tags
  occurrences, archived rows; the flat tree carried it too until its retirement in
  slice s3a-view-consolidation, and the org panel renders starred state its own
  way). Each builder resolves the SYNCED ChatMeta.starred via the shared
  resolveStarred(meta, chatId) (never the local orphan state) and swaps the row
  icon to star-full when set. ThemeIcon cannot composite two glyphs, so the star
  replaces the default comment-discussion icon. Each builder folds starred into
  its reuse key (cardStarred field) so a star toggle rebuilds exactly the affected
  rows and re-renders the badge on the next refresh. See DECISIONS.md Slice
  s2-star-archive.

## Per-chat export and token rollup (Sprint 2, slice 5) — binding

Export one chat to Markdown or JSON (the org layer in front-matter) through the
exportIO chokepoint, and roll up tier-A token cost by folder and tag (tokens only, NO
USD). These rules are binding so the export cannot violate the read-only invariant and
the rollup stays an honest, vscode-free reduction.

- The EXPORT formatters (src/export/chatExport.ts, renderMarkdown / renderJson) are
  PURE and vscode-free: they take a ChatRecord, a resolved ExportOrgLayer
  {folder, tags, starred, links}, and the ordered bodies, and return a string. The
  command layer (src/commands/exportChatCommands.ts, exportChat) is vscode-thin and
  reads the body ONCE on demand via bodyReader.readTranscriptBodies (read-only) then
  DISCARDS it. The write goes ONLY through the injected writeExport seam, wired in
  extension.ts to exportIO.writeTextFile, which runtime-asserts
  assertNotUnderClaudeProjects before the bytes land. So an export the user navigates
  (via the save dialog) into ~/.claude/projects is REFUSED by the guard and never
  overwrites a transcript. The seam is named writeExport, NOT writeFile/writeTextFile:
  the read-only lint bank's first selector is object-AGNOSTIC (it bans any callee
  property named writeFile), so a deps.writeFile(...) call would trip it the same as
  fs.writeFile; the only sanctioned write stays exportIO.writeTextFile (a carve-out
  module).
- MARKDOWN FRONT-MATTER ESCAPING is mandatory. The front-matter carries
  user/transcript-derived strings (title, tags, folder name, link ids). Every scalar
  is emitted as a DOUBLE-QUOTED YAML string with backslash/quote/newline/CR/tab
  escaped (yamlQuote), and sequences as quoted flow arrays, so a title containing a
  colon, a quote, a newline, or a leading '---' is contained on its own quoted line
  and can neither break the block nor inject a second front-matter block. An unfiled
  folder renders the YAML null. The JSON formatter gets this for free via
  JSON.stringify and is round-trippable (JSON.parse(renderJson(...)) === the doc).
  chatTooltip.escapeMarkdown solves the markdown-injection twin; this is the YAML twin.
- The TOKEN-TOTALS SEAM: the rollup needs per-chat tokenTotals, but the existing
  foldersProvider.chatRecords() projects each record down to {title, timestamp} and
  DROPS tokenTotals. The narrow FoldersProvider.tokenTotalsByChat() seam returns a
  fresh Map<sessionId, TokenTotals> from the full records the provider already holds
  behind ensureSnapshot(), mirroring chatRecords(). It surfaces only the bounded
  tier-A token reductions that already ride the scan snapshot (never a body).
- The ROLLUP reducer (src/rollup/tokenRollup.ts, rollupByFolder / rollupByTag) is
  PURE and vscode-free: it takes a plain {chatId -> TokenTotals} map plus ProjectMeta
  membership and NEVER reads the provider. THE COUNTING RULE is pinned and asserted: a
  chat counts ONCE in its single home folder (unfiled, or a stale folderId, routes to
  the synthetic Unfiled bucket), so the by-folder totals PARTITION the library; a chat
  counts ONCE per EACH of its tags (untagged routes to the synthetic Untagged bucket),
  so a multi-tag chat adds its full total to every tag bucket and the by-tag totals
  are INTENTIONALLY NOT a partition (they can EXCEED the library total). The report
  renderer (rollupReport.ts) carries the explicit note so the tag rollup does not read
  as a double-count bug.
- The ROLLUP UI SURFACE is the lightest that meets the AC: a read-only virtual
  document built from the pure reducer + renderer output, opened by the vscode-thin
  showTokenRollup command. No webview/CSP dependency. The claudeNest.showTokenRollup
  command rides the org panel's view/title menu and the command palette (its tree
  view/title homes retired with their views); claudeNest.exportChat stays gated out
  of the palette (it needs a target) and, since s3a-view-consolidation, waits for
  the in-panel context menu (s3b) to regain a surface. See DECISIONS.md Slice
  s2-export-and-rollup.

## Org panel as the primary view (Sprint 2, slice 6) — binding

Slice 6 promotes the chatsPreview proof-of-concept to the PRIMARY organization
surface: a single CSP-locked, nonce-scripted WebviewView (claudeNest.orgPanel,
"Organize") that renders sections, tag chips, sort, density, per-folder color,
folder rename, and drag-and-drop. The native Folders and Tags TreeViews are
RETIRED. Slice 6 kept the flat Chats TreeView as the accessible fallback, but
Sprint 3 slice s3a-view-consolidation SUPERSEDES that per UI-SPEC.md deviation 5:
the flat Chats and Smart Groups trees are retired and the org panel's own
keyboard + ARIA tree implementation is the accessibility story, making the panel
the SOLE browsing surface. Reviewers must NOT flag that retirement as an
architecture violation. The remaining rules are binding so the re-platform cannot
violate the read-only invariant, the DnD-shell-only contract, or the unit-gate
split.

- THE DnD-SHELL-ONLY CONTRACT. src/dnd/dropReducer.ts is NOT modified by this
  slice (sprint-wide hard rule, SPRINT-2-PLAN:73). The only new code on the drop
  path is the EXTRACTION SHELL src/dnd/webviewDropAdapter.ts (vscode-free): it maps
  the webview's self-describing drop message to the reducer's plain DropInput
  (a 'folder' drop -> targetView 'claudeNest.folders'; a 'tag' drop -> targetView
  'claudeNest.tags'; payloadMime is always NEST_CHAT_MIME), calls the UNCHANGED
  reduceDrop, and applies the returned intents as N synchronous store calls that
  coalesce into ONE pending write, then one flush and one refresh (the same shape
  as dndController.applyIntents, ARCHITECTURE.md "Refresh coalescing"). The drop
  interpretation (folder-move vs tag-add, unfile on the Unsorted sentinel / empty
  space, no-op on the Untagged sentinel) stays entirely in the reducer; the webview
  DnD is covered by the EXISTING dropReducer unit tests plus a small
  webviewDropAdapter extraction test.
- THE WEBVIEW DnD IS FULLY IN-PROCESS, so the cross-tree dragContext stash is NOT
  used on this path. The stash (src/dnd/dragContext.ts) exists ONLY because VSCode
  1.66 will not deliver a controller's custom DataTransferItem to a PEER tree
  controller's handleDrop (the cross-tree TreeView case). A webview drag starts and
  drops inside one webview: the drop message carries sourceChatIds directly, so the
  adapter reads the payload from the message, never from the stash, and
  webviewDropAdapter.ts imports no dragContext (asserted by a unit test that the
  stash stays empty across an adapter drop). The native dndController.ts and the
  stash remain in the tree (still unit-tested) but are no longer wired by
  extension.ts, since the native trees that used them are retired.
- THE SECTION MODEL IS A PURE, vscode-free MODULE (src/views/orgPanelModel.ts,
  buildSections). It takes the scanned records, the ProjectMeta, and a token-badge
  function, and returns the serializable section model (Starred, Questions, the
  folder hierarchy, tag chips); the webview host (orgPanelWebview.ts) scans, reads
  the store, calls it, and posts the result over postMessage. The host never holds
  a body in the snapshot; content search reuses the slice-2 host-side search
  machinery (searchIndex + searchStore) with the same two-phase warm-then-body
  upgrade and the generation guard against a refresh-during-build race (regression
  test re-pointed from the retired chatsPreview to orgPanelWebview).
- THE AWAITING-REPLY ("Questions") SECTION IS A SCAN-TIME HEURISTIC, NOT A LIVE
  SIGNAL. A chat is "awaiting your reply" iff its tier-A lastMessageRole === 'user'
  (slice 0; a tool_result-only user line does not advance the role, so the
  heuristic reflects human intent, not the tool loop). It is LABELLED a heuristic
  in the panel header (a "heuristic" badge with an explanatory title) so it is never
  read as a live conversation state. Starred and Questions are CROSS-CUTTING
  sections: a chat can appear in Starred and/or Questions AND in its single home
  folder. Only the FOLDER placement is single-home (a chat appears under exactly its
  ChatMeta.folderId, or the synthetic Unsorted bucket when unfiled or the folderId
  no longer resolves, mirroring the Folders tree and the rollup counting rule).
- PER-FOLDER COLOR rides each folder section from Folder.color (slice 3); the panel
  renders a color dot on the folder header and the chip color on tag chips.
  Double-click a folder header to rename (an in-place editor posting a renameFolder
  message); right-click for the folder actions menu (rename, set/clear color,
  delete). renameFolder/setFolderColor/deleteFolder route through the EXISTING store
  mutations and the deleteFolder command (modal confirm + descendant cascade that
  unfiles member chats, never deleting a chat); the webview never invents a write
  path. Sort (newest/oldest/name) and density (comfortable/compact) are persisted on
  workspaceState (per-workspace, NOT synced, so the sync surface stays exactly
  nest.meta.v1::<projectKey>).
- ACCESSIBILITY IS AN ACCEPTANCE CRITERION. The list is role="tree" with
  role="treeitem" rows under role="group" sections, a single roving tabindex (one
  focusable row at a time), arrow-key navigation (Up/Down/Home/End), Enter/Space
  activation, and a visible focus ring (CSS). Since s3a-view-consolidation there
  is NO native fallback tree: the org panel's ARIA tree IS the accessibility
  surface (UI-SPEC.md deviation 5), so this criterion is load-bearing.
- THE LINK NESTING TREE IS NOT RENDERED IN THE ORG PANEL (deferred, reversible).
  The Folders tree rendered linked children; the org panel does not yet have a link
  surface. Since s3a-view-consolidation both commands are PALETTE-callable with
  no-arg quick-pick paths (linkCommands.ts linkToChatFromPalette picks the source
  chat; unlinkChatFromPalette picks among the project's current designated-parent
  links, the exact nesting unlinkChat removes), and the pure links model remains
  intact for a future org-panel link surface. See DECISIONS.md Slice
  s2-org-panel-webview and s3a-view-consolidation.

## Read-only invariant (the sacred constraint)

The extension is strictly read-only on Claude's transcript files under
~/.claude/projects/. It never writes, renames, moves, or deletes anything there,
never patches or depends on the Claude Code extension, and its only contact with
Claude beyond reading transcripts and one settings edit is firing the public URI
handler. If the extension fails, Claude must be entirely unaffected.

- Read-only chokepoint: a single fs-writing module is the ONLY code permitted to
  write under ~/.claude, and it hard-asserts the canonicalized absolute target
  equals the one allowed settings.json path, throwing otherwise. The lint half of
  this defense is enforced, not left to review discipline, and it covers every
  write-capable call SHAPE (not just member calls) across every linted src file.
  The only files exempt from the selector bank are the two explicit override
  carve-outs below (the sanctioned settings-IO module and the test tree); there is
  no name-based exemption (an earlier ignorePatterns entry for __probe* scratch
  names was removed once verified to be bypassable, since the probe generator
  writes under the gitignored .claude-working/ tree that `eslint src` never scans,
  and probe-named files are also excluded from tsconfig so they cannot compile into
  out/). A bank of eslint no-restricted-syntax
  selectors bans every write-capable fs call (writeFile/writeFileSync, append,
  write/writeSync, rename, rm/rmdir, unlink, truncate, mkdir/mkdtemp, copyFile/cp,
  createWriteStream, chmod/chown, symlink, link, utimes, open/openSync) across src
  at every entry point a write can take:
  - the member-call form (fs.writeFileSync(...));
  - the computed-access form (fs['writeFileSync'](...));
  - the named/destructured import (import { writeFileSync } from 'fs' |
    'node:fs' | 'fs/promises' | 'node:fs/promises') and the require-destructure
    (const { writeFileSync } = require('fs')), which are the idiomatic entry
    points for a bare or aliased write and are caught at the import itself;
  - the alias (const w = fs.writeFileSync);
  - the bare call of a collision-free write name (writeFileSync(...)) as a
    defense-in-depth backstop once a name is in scope. A namespace import
    (import * as fs from 'fs') stays legal: a literal-named write through it
    (fs.writeFileSync(...)) is the member-call form already covered, and a computed
    write through it (fs[m](...)) is covered by the computed-key ban below. That
    computed-key ban is NOT gated on the holder being named fs: a namespace alias to
    any other name (const zz = fs as unknown as ...; zz[m](...)) would otherwise slip
    a name-gated rule, so EVERY computed member call with a non-literal key is banned
    in src (a variable key cannot be statically proven read-only).
  All selectors have an override carve-out for ONLY the sanctioned settings-IO module
  (src/settings/claudeSettingsIO.ts, which holds the path-asserting chokepoint), the
  narrow export-IO module (src/store/exportIO.ts, Slice 8), and the scratch-fixture
  test tree. The carve-out is staged ahead of the settings
  module so the guard is already in force before any write-capable slice lands.
  Lint is wired into the headless test gate (pretest runs lint before compile and
  mocha), so the chokepoint cannot be bypassed by skipping a separate command.
  Nothing may ever write under ~/.claude/projects/. (Slice 7 LANDED the chokepoint
  module src/settings/claudeSettingsIO.ts: it holds the ONLY write-capable fs calls
  in src, hard-asserts the canonicalized allowed settings.json path via
  path.resolve/normalize with a win32 drive-letter case-fold and NO realpath on the
  possibly-absent target, performs the single-key surgical jsonc byte-range edit
  preserving siblings/comments/order/EOL with create-when-missing, and guards the
  write with an mtimeMs re-stat abort-on-change before an atomic temp-write-rename.
  See DECISIONS.md Slice 7.)
  - Slice 8 export/import write-ban resolution: the lint bank's first selector is
    object-AGNOSTIC (it matches any CallExpression whose callee property name is a
    write verb), so even a vscode.workspace.fs write (vscode.workspace.fs.writeFile)
    trips it exactly as a node fs write does; the slice-patch claim that
    vscode.workspace.fs slips the selectors is FALSE and was disproved by the lint
    gate during the build. The accepted resolution is the patch's first option: all
    export/import and auto-export snapshot file IO is isolated in the narrow,
    carve-out-exempted src/store/exportIO.ts, which does nothing but the
    vscode.workspace.fs read/write/readDirectory/delete/createDirectory primitives
    and imports NO node fs, so the exemption stays auditable and the command module
    (exportImportCommands.ts) and the pure store modules remain under the full ban.
    exportIO.ts NEVER writes under ~/.claude: its targets are a user-chosen export
    path or context.globalStorageUri. See DECISIONS.md Slice 8.
- All transcript-reading tests run against scratch copies, never the real files.

## Tree and VSCode API binding rules

- TreeItem.id must be unique tree-wide. Model each on-screen occurrence of a chat
  as a distinct wrapper node with its own composite id: tag occurrence id
  `${tagId}:${chatId}`, folder member id `${folderId}#${chatId}`, linked-child id
  `${parentChatId}>link>${chatId}`. All wrappers dereference one shared
  ChatRecord. Never return the bare ChatRecord object under two parents.
- Memoize node objects by id across refreshes. VSCode caches tree elements by
  object reference; returning fresh objects with the same ids on every
  getChildren breaks reveal and selection.
- getParent returns exactly one parent per node. reveal-by-chat targets the
  Folders view (the chat's single home); the Tags view reveals a specific
  occurrence only.
- Link cycle detection uses a proper visited-set graph traversal (transitive
  cycles and diamonds), not a two-case check. A linked child renders under only
  its one designated parent link. Cap depth.
- Drag and drop: each view's controller's dropMimeTypes declares BOTH views'
  reserved MIMEs (its own AND the peer view's) plus one shared custom chat MIME;
  dragMimeTypes declares its own reserved MIME plus the shared chat MIME. The peer
  reserved MIME is REQUIRED in dropMimeTypes so the host OFFERS the peer tree as a
  drop target for a cross-view drag (without it the host never accepts the drop and
  handleDrop never runs). It is NOT, however, the cross-view payload carrier: in
  VSCode 1.66 the host delivers a controller's custom DataTransferItem to handleDrop
  only when the drag started in the SAME controller (verified against the pinned
  extHostTreeViews source: the source handleDrag items are re-applied only when
  source view === destination view). So the cross-view PAYLOAD rides an in-process
  shared stash (src/dnd/dragContext.ts) that handleDrag writes and the peer
  handleDrop reads as a fallback; the DataTransfer remains the authoritative carrier
  for a WITHIN-view drop, where the host preserves the custom item. handleDrop reads
  the payload from a recognized MIME when present (within-view), else from the stash
  (cross-view), asserts the payload MIME, and interprets by the TARGET view. Reject
  unrecognized sources (no MIME and no stash) as a no-op. See DECISIONS.md (Slice 3
  dropMimeTypes peer-reserved-MIME, and the Slice 5 correction of the cross-view
  carrier mechanism).
  - The drop INTERPRETATION is a PURE reducer in its own vscode-free module
    (src/dnd/dropReducer.ts), NOT co-located in the controller: the controller
    (src/dnd/dndController.ts) imports vscode (TreeDragAndDropController,
    DataTransfer, DataTransferItem), and the unit test that imports the reducer
    must not transitively require vscode (unit-gate rule; mirrors the occurrence.ts
    vs tagsProvider.ts split). The reducer takes plain data
    {payloadMime, sourceChatIds, targetView, targetId} and returns an ordered list
    of store-mutation intents; the controller extracts that plain data from the
    real DataTransfer and drop target, then applies the intents. dndController.ts
    imports the reducer.
  - The two controllers were constructed in extension.ts and passed to each
    createTreeView's dragAndDropController option (they are NOT self-registering).
    Both the foldersView and tagsView createTreeView calls set canSelectMany:true
    (required so a multi-chat drag carries every selected chat) AND the
    dragAndDropController option. (Historical: those trees, and later the flat
    Chats tree that reused canSelectMany for multi-select tagging, are retired;
    the controllers remain unit-tested but unwired. In-panel DnD goes through
    webviewDropAdapter.)
- Refresh coalescing: batch a multi-select mutation into ONE store write and fire
  onDidChangeTreeData once (targeted to affected parents where possible).
  Implement the batch via the store's EXISTING mutation coalescing, NOT a new batch
  API: apply the reducer's intent list as N synchronous store.setChatFolder /
  store.addChatTag calls (which coalesce into one pending write), then a single
  await store.flush() and a single provider.refresh() (the same shape as
  deleteFolder's cascade).
- Empty state: getChildren(undefined) returns [] and, for the remaining Archive
  tree, a viewsWelcome contribution shows the empty-state message (the org panel
  webview owns its own empty state). Never throw out of getChildren. (Slice 9
  Polish VERIFIED this across the then-four providers and viewsWelcome entries,
  and added the progress/cancellation path WITHOUT making getChildren or
  getParent async: those stay synchronous on the memoized snapshot, and an explicit
  Refresh command primes that snapshot under vscode.window.withProgress with a
  CancellationToken via the ScanPrimable.primeSnapshot seam, then fires
  onDidChangeTreeData once. The scanner stays vscode-free: scanChats takes optional
  plain-callback {onProgress, shouldCancel} that the vscode layer supplies. The scan
  is synchronous, so cancellation takes effect on a re-issued refresh, not mid-scan;
  see DECISIONS.md Slice 9. Since s3a-view-consolidation the palette Refresh primes
  the KEPT FoldersProvider snapshot, then re-posts the org panel's section model,
  so the sole browsing surface re-renders under the same progress UI; the contract
  continues to bind the kept ScanPrimable services and the Archive tree.)
- Separator-namespace discipline: tag, folder, and chat ids are generated free of
  ':', '#', '>'. Enforce in the id factory. The synthetic-node sentinels live in
  the same id-space but are NOT mintable and are excluded from the factory's
  mintable set: '__unfiled__' (Folders), '__untagged__' (Tags), and the four Smart
  Groups signal-group ids '__smart_pr__' / '__smart_ticket__' / '__smart_branch__'
  / '__smart_fork__' (Slice 6). The Smart Groups engine adds a TWO-char '::'
  bucket-id namespace on top of the three single-char composite separators: a
  bucket node is `${groupId}::${bucketKey}` and a chat node under it is
  `${bucketNodeId}::${chatId}`. This namespace is reserved ONLY under a
  '__smart_*__' group prefix that nothing else mints, and smart-group ids are
  never fed to the single-':' tag-occurrence parser, so it does not collide with
  the parsed composite-id grammars. (The Smart Groups TREE was retired in
  s3a-view-consolidation; the sentinel and namespace reservations stay binding on
  the id factory so stored ids can never collide with them.) See DECISIONS.md
  (Slice 6 sentinels and '::' namespace).

## Data integrity, read-only, and settings rules

- settings.json write is surgical (jsonc byte-range edit preserving order,
  whitespace, EOL), single-key, with a pre-rename mtime re-stat and
  abort-on-change. Never parse-then-stringify the whole file.
- Orphan reconcile never hard-deletes on a scan and never mass-archives on a
  transient zero-result: if a scan returns zero (or far fewer than the last
  known count) for a project that had records, treat the scan as suspect and skip
  reconciliation that pass. Records are soft-marked missingSince; permanent
  removal is user-gated, reversible (tombstone), and only after a grace window.
  Orphan state is local only, never synced.
- Durability claim is honest: globalState plus Settings Sync is best-effort and
  conditional. The export JSON is the authoritative backup.
- Import validates a scratch copy and migrates BEFORE touching the live store,
  then swaps in one atomic write, merges additively per project, and never
  deletes projects absent from the file.

## Sync architecture (design-council synthesis)

Primary store: one synced globalState key per project,
`nest.meta.v1::<projectKey>`, holding a self-contained ProjectMeta document:

```
ProjectMeta = {
  schemaVersion,
  folders: { [folderId]: { id, name, parentId|null, order } },
  tags:    { [tagId]:    { id, label, color? } },
  chats:   { [chatId]:   { folderId|null, tags: tagId[], links: Link[],
                           updatedAt, deviceId } },   // per-record stamps
  updatedAt, deviceId                                  // per-project stamps
}
```

All project keys are registered with context.globalState.setKeysForSync,
refreshed when a new project key appears. Tags are stored once and referenced by
id. Rationale and rules:

- Per-project keying bounds the Settings Sync blast radius to one project. The
  verified platform behavior (per-key, local-wins, opaque value, no field merge)
  means a cross-machine conflict can wholesale-replace one project's value, but
  never the whole library.
- Cheap conflict detection and bounded reconcile: per-project and per-record
  updatedAt plus a per-install deviceId let the extension detect a foreign-device
  overwrite on activation and on window focus (there is no Memento change event
  for remote sync writes; detection is best-effort polling). On detection it
  reconciles additively against an on-disk shadow: union tags,
  last-writer-wins per scalar field by updatedAt, union links. The
  irreducible floor is a concurrent same-scalar-field edit, which loses one side
  and is surfaced.
- Per-scalar LWW fields (Sprint 2, slice 3) — binding. mergeProjectMeta is the
  single arbiter both cross-machine paths (import merge and reconcileSync's
  shadow reconcile) share, so any synced curation scalar MUST be arbitrated there
  in the same slice that introduces it, else a foreign sync write wholesale-
  replaces it. The arbitrated per-record chat scalars are folderId, starred,
  userArchived, and archivedAt, each decided by the SINGLE per-record ChatMeta
  updatedAt (there is no per-scalar stamp); archivedAt travels COUPLED to
  userArchived (the winning side supplies both, so the timestamp never desyncs
  from the flag), and a tie keeps the live side. Folder.color is arbitrated at
  the document level by the project updatedAt (folders carry no per-record stamp),
  which requires foldersEqual AND cloneFolder to include color and normalizeFolder
  to carry it (all three, or a color-only edit reads as equal and never merges or
  persists). folderId stays the surfaced conflict floor (folderConflicts); the new
  boolean/number scalars add no new conflict array. These are nested fields on the
  folder and chat records, so the top-level KNOWN_TOP_LEVEL/__unknown forward-compat
  escrow is untouched. No SCHEMA_VERSION bump: the fields are additive-optional and
  default-absent on an older document. See DECISIONS.md Slice s2-schema-scalars-and-lww.
- The export and import JSON is the AUTHORITATIVE backup: human-readable,
  git-committable, survives a PC reset. Import merges additively per project. A
  debounced opt-in auto-export snapshot writes to global storage with retention;
  the user is prompted once to point the canonical export at a synced or
  git-tracked location.
- Scale: at a solo user's realistic library the synced surface stays well under
  the low-MB large-state warning. Documented escape hatch: migrate cold projects'
  bulk to on-disk storage if a library grows.
- Ships with an honest last-writer-wins warning.

## Build and test toolchain contract

- Language: TypeScript compiled with tsc to out/ (commonjs, ES2020, strict).
  main is ./out/extension.js.
- Lint: eslint with @typescript-eslint over src.
- Unit tests (headless gate): node + mocha over out/test/unit/**/*.test.js. Pure
  logic only; unit test files and the modules they import must not require the
  vscode module. `npm test` runs `pretest` (lint then compile) then mocha, so the
  read-only chokepoint lint runs as part of the headless gate and cannot be
  bypassed by skipping a separate command. This is the command the workflow TEST
  gate runs.
- Integration tests (electron host): @vscode/test-electron under
  out/test/integration/**. Needs a VSCode download and a display; deferred to
  TESTING.md and run by a human or CI, never part of the unattended gate.
- Packaging: @vscode/vsce. `npm run package` runs
  `vsce package --no-dependencies -o nest-build-check.vsix`. engines.vscode is
  ^1.66.0 and @types/vscode is pinned to 1.66.0 to satisfy vsce's engine check.
  The .vsix artifact is gitignored.

## Visual-fidelity harness (Sprint 3, slice s3a-visual-harness) — binding

Sprint 3 rebuilds the org panel to the pixel-exact handoff at `media/design/`
(UI-SPEC.md). To give the build and review agents EYES on that redesign, a
standalone screenshot harness renders the real webview asset and the design
prototype headlessly and writes them to disk for a by-eye comparison. This is the
visual-fidelity review lens; every UI slice runs it before its review is dry.

- `npm run fidelity` (`scripts/fidelity/screenshot.js`) drives headless Chrome or
  Edge over the Chrome DevTools Protocol using only Node built-ins (global `fetch`
  and `WebSocket`, Node 20+). It adds NO npm dependency: the extension is
  zero-runtime-dependency and packages with `--no-dependencies`, so a bundled
  puppeteer would either bloat the tree or never ship (and false-pass the install
  proof), exactly like the vendored-MiniSearch reasoning. It discovers the browser
  from the standard install paths or a `NEST_FIDELITY_BROWSER` / `CHROME_PATH`
  override, and FAILS with a clear, actionable message (exit 1) when no browser is
  found.
- `scripts/fidelity/harness.html` hosts the REAL shipped panel asset
  (`media/orgPanel.css` + `media/orgPanel.js`) - never a hand-drawn copy - with a
  stubbed `acquireVsCodeApi`, the exact static DOM shell `orgPanelWebview.renderHtml`
  emits, and synthetic mock data posted in the SAME message shape the host posts
  (`state` then `sections`; see `OrgSections` / `OrgChatRow` in
  `src/views/orgPanelModel.ts`). The mock is fully synthetic (no real transcript
  content is committed) and deliberately carries `starred:true` and
  `awaitingReply:true` rows, per-row `status` (`'question'` -> blinking `?` badge,
  `'done'` -> solid unread dot; design README line 51), plus colored folders and tag
  chips, so re-running the harness surfaces every AC1 visual the shipped asset draws
  (the starred glyph, the done-dot, and the `?` badge from `makeRow` /
  `.nest-status*`) from the flags the mock sets.
- The prototype (`media/design/ChatSidebar.html`) embeds a gzip+base64 React bundle
  behind a full-viewport `#__bundler_thumbnail` unpack placeholder. The driver waits
  for React to mount, removes the placeholder, and clips the capture to the 320px
  sidebar column (UI-SPEC.md deviation 1), so the reference is a clean panel-only
  frame and never the gray unpack screen.
- Outputs land in `.claude-working/fidelity/` (gitignored): `harness.png` (the real
  asset) and `prototype.png` (a fresh prototype render). The frozen baseline is
  committed at `media/design/reference/prototype-320.png` and is what the lens
  compares against. Pixel diffing is a deliberate non-goal; the gate is
  reviewer-eye plus the human check.
- Packaging boundary: the whole `scripts/**` tree and `media/design/**` (which holds
  the reference images) are excluded from the VSIX via `.vscodeignore`, so neither
  the harness nor the baselines ever reach a user. The installCheck package proof
  confirms `scripts/` is absent from the `.vsix`.

## Git landing strategy

PR-per-slice with explicit author and a normalized local committer, both Jake
Mismas <jake@jakemismas.com>. No AI author or co-author trailer, no generated-by
markers. Each tested slice lands on its own branch `slice/<id>`, opens a PR
against the protected main branch, and merges; the engine resumes by scanning
origin/main for the trailer. Each slice commit carries the trailer
`Nest-Slice: <id> (<order>)` plus a `Fixes #<issue>` line so the merge closes its
issue. A slice counts as done only after the merge is verified on origin/main.
The gitignored .nest-build-state.json is never staged or committed. Sprint 1
shipped v0.0.1 and Sprint 2 shipped v0.1.0 this way; SPRINT-2-PLAN.md holds the
engine's landing contract.
