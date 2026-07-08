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
panel webview is the SOLE browsing surface (UI-SPEC.md deviation 5); with the
settings editor tab retired in s3b-settings-overlay and the Archive tree retired
in s3b-archive-overlay, the org panel webview is now the ONLY contributed view
(Settings and Archive render as in-panel overlays inside it).

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
- Launch seams (vscode-free, injected): src/launch/uriLauncher.ts (open/resume a
  chat by session id) and src/launch/newSessionLauncher.ts (launchNewSession, added
  in slice s3a-design-shell). The latter tries the installed Claude Code new-chat
  commands in order (claude-vscode.newConversation, then claude-vscode.sidebar.open
  as a graceful fallback) through an injected executeCommand fn and is unit-tested;
  extension.ts wires it to vscode.commands.executeCommand and shows an info toast
  on total failure. See DECISIONS.md slice s3a-design-shell (a) for the entry-point
  probe.
- Visual-fidelity harness (dev/test only, excluded from the .vsix): scripts/fidelity/
  screenshot.js (headless-Chrome driver) and scripts/fidelity/harness.html. The
  harness's static DOM shell is a BYTE-ALIGNED copy of orgPanelWebview.renderHtml
  and MUST be rewritten in lockstep with the shell (as it was for the
  s3a-design-shell toolbar/search/no-density rewrite): if it drifts, orgPanel.js's
  getElementById wiring finds no nodes and `npm run fidelity` renders nothing. Its
  --vscode-* palette shim became a harmless no-op once orgPanel.css hardcodes the
  handoff palette.
- View surfaces (post s3b-archive-overlay, UI-SPEC.md deviation 5): the org panel
  (src/views/orgPanelWebview.ts plus the pure orgPanelModel.ts) is the ONLY contributed
  view and the SOLE browsing surface. The Archive tree (archiveProvider.ts) is DELETED
  (s3b-archive-overlay); its rows are rebuilt by the pure orgPanelModel.buildArchivedRows
  and rendered in an in-panel overlay, and its membership/sort/fallback-title logic moved
  there. The flat Chats tree (flatProvider.ts) and Smart Groups tree
  (smartGroupsProvider.ts) were DELETED earlier; the OPEN_CHAT_COMMAND id now lives in
  src/launch/uriLauncher.ts.
  FoldersProvider.ts and TagsProvider.ts are KEPT as non-view services
  (project-key resolution, link target pick list, the tokenTotalsByChat rollup
  seam, reveal and home resolution) since slice 6 retired their trees;
  chatTooltip.ts/chatMeta.ts/relativeTime.ts/linkDecoration.ts are vscode-free
  view helpers.
- Commands: src/commands/* are vscode-thin orchestrators over the pure modules above
  (folders, tags, tagging, links, curation, export, rollup, export-import,
  promote-smart-group, preview, refresh-scan). The standalone
  src/settings/settingsWebview.ts panel is RETIRED (slice s3b-settings-overlay);
  Settings now render as an in-panel overlay inside the org-panel webview.

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
  the LAST GENUINE user/assistant turn, for the read-state row status (the question
  badge and the unread dot; see "Row status and read state" below) and previews. A
  textless assistant turn (pure tool_use) is a real assistant action and DOES advance
  the role to 'assistant', keeping the prior snippet text. A tool_result-only user
  line, however, is the harness feeding a tool output back into an assistant loop (the
  dominant real user-line shape) and is NOT a human turn: it does not advance the role
  to 'user' and does not overwrite the snippet, so the row-status derivation (which
  keys the unread signal on lastMessageRole === 'assistant') reflects real assistant
  output rather than the tool loop.
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

## Org-panel hover card and the previewBody contract (Sprint 3, slice s3b-hover-card) — binding

Slice s3b-hover-card (issue #84) lands the org panel's own rich preview card. It does
NOT reuse the Sprint-2 buildChatTooltip MarkdownString path: a WebviewView cannot host
a vscode.MarkdownString, so the card is a webview DOM node (media/orgPanel.js, a
body-level position:fixed `.nest-preview-card`) whose every content sink is textContent
only (no innerHTML), keeping the security render-site class the s3a slices established.
buildChatTooltip and its vscode.MarkdownString wrap stay INTACT in the retired-view
services (foldersProvider.ts, tagsProvider.ts) for a future consumer; the panel simply
never imports it (it imports only tokenBadge from chatTooltip.ts). These rules are
binding so the card cannot violate the "full body never on the snapshot" tier-A rule or
the webview textContent-only render discipline.

- THE CARD BODY LINES RIDE A HOVER-SCOPED previewBody ROUND-TRIP, read on demand and
  retained NOWHERE but the open card's DOM. The row model (OrgChatRow, the sectioned
  post) carries the card's title, folder breadcrumb, token label, and tag pills, so the
  card's chrome renders with NO host read; only the two body lines need the transcript.
  The client posts `{ type:'previewBody', sessionId }` for the ONE hovered (or
  keyboard-previewed) chat; the host (orgPanelWebview.ts postPreviewBody) scans, finds
  that record, reads its bodies ONCE on demand via bodyReader.readTranscriptBodies,
  selects the FIRST role==='user' body and the LAST role==='assistant' body through the
  vscode-free bodyReader.selectPreviewBodies, posts them back as
  `{ type:'previewBody', sessionId, firstUser, lastAssistant }`, and DISCARDS the bodies
  (they are locals that die when the method returns). Bodies never enter the scan
  snapshot; the host holds nothing after the reply. This is the SAME on-demand-read /
  discard shape as the search body feed and the Preview Full Chat command.
- THE REPLY IS sessionId-ECHOED AND STALE-DROPPED. The host echoes the requested
  sessionId; the client (applyPreviewBody) renders the lines ONLY when the card is still
  open for that same chat (previewSessionId match), so a late reply for a chat the
  pointer has already left is ignored. A missing/unknown id or an unreadable transcript
  posts null lines and the card renders its title/meta with no body block rather than the
  host throwing (the never-throw tolerance carried from the Sprint-2 card).
- THE INBOUND previewBody MESSAGE IS COERCED like every other webview message: coerce()
  in orgPanelWebview.ts accepts it only when `type === 'previewBody'` and sessionId is a
  string; postPreviewBody additionally no-ops on an empty id. The sessionId is used only
  to find a scanned record and is never a CSS/HTML sink.

## Org-panel chat-row context menu (Sprint 3, slice s3b-context-menu) — binding

Slice s3b-context-menu (issue #85) lands the chat row's right-click menu: the full tag
list with checkmarks that toggle a tag on the chat, an in-panel create-tag flow (name
input plus the 8-swatch color picker), Export as Markdown / JSON, and Archive (or the
starred-kept note). Like the folder actions menu and the sort popover it is a body-level
`position:fixed` transient overlay (media/orgPanel.js) torn down on Escape, outside
click, or any tree re-render, so it can never post a mutation for a row a refresh
removed. Every label sink is textContent only, keeping the webview render-site security
class the s3a/s3b slices established. These rules are binding so the menu cannot widen
the write surface, escape the read-only invariant, or regress the ARIA story.

- THE MENU LISTS EVERY PROJECT TAG, NOT THE FILTER-CHIP SET. The row model gains an
  additive `allTags` field on OrgSections (orgPanelModel.ts buildAllTags, a TagChip[]
  with id, label, color-or-null, and count built from meta.tags), posted alongside the
  visible-chat-only chip set. buildTagChips is UNCHANGED and still drives the filter row;
  the menu reads allTags so it can list a zero-chat tag the filter row omits (AC #1's
  all-tags-with-checkmarks menu). The checkmark on each item reflects the chat's current
  ChatMeta.tags membership.
- THE MENU INTENTS ROUTE THROUGH THIN OrgPanelActions SEAMS, NEVER A NEW WRITE PATH.
  toggleChatTag(sessionId, tagId, on) adds/removes via the existing store tag mutation.
  createTagWithColor(label, color) is a NEW seam that mints via mintTagId, upserts a Tag
  with an isValidColor-validated color, applies it to the chat, and returns the new tag
  id so the menu can immediately reflect it. It deliberately does NOT reuse the existing
  claudeNest.createTag command, which opens a modal ui.prompt and mints a COLORLESS tag
  and so cannot satisfy AC #2's in-panel name + 8-swatch create-with-color flow.
  exportChat(sessionId, format) and archiveChat(sessionId) resolve the transcript record
  from the panel's scan cache and route to the EXISTING exportIO-guarded export pipeline
  (save dialog + projects-path guard) and the read-only archive-body pipeline, so the
  chat's real filePath is used and no new scan or write path is added. Archive is shown
  only when the chat is neither starred nor archived; a starred chat shows the
  starred-are-kept note instead (AC #4).
- EVERY OUTBOUND MENU FIELD IS COERCED AT THE HOST BOUNDARY. coerce() in
  orgPanelWebview.ts validates the new inbound types exactly like setFolderColor:
  sessionId and tagId as strings, the create-tag color via isValidColor-or-null, and the
  export format as a closed 'markdown' | 'json' union. A color that fails isValidColor is
  rejected before it can reach the store or a CSS sink, matching the folder-color
  boundary rule.
- THE MENU IS FULLY KEYBOARD OPERABLE (AC #5). Each menu overlay is a role="menu" of
  `.nest-menu-item` buttons; wireMenuRoving (media/orgPanel.js) wires cyclic
  ArrowUp/ArrowDown roving focus and Enter/Space activation across the items, mirroring
  wireSortPopover so every ARIA menu in the panel honors the same pattern it advertises.
  It is called after all items are appended and before the first item is focused, on both
  the folder actions menu and the chat context menu. Escape and outside click dismiss;
  the menu shadow follows the token (0 12px 32px rgba(40,33,20,0.18)).

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
  machinery (DECISIONS.md 2026-06-15). The archived-row membership lists chats by
  store.getProjectMeta(projectKey).chats[id].userArchived === true and NEVER reads
  LocalChatState.archived. Restore calls store.setChatArchived(false) (clearing
  archivedAt); star/unstar (store.setChatStarred) is INDEPENDENT of the archive flag,
  so a restored chat keeps its star. (Since s3b-archive-overlay this membership rule
  lives in the pure orgPanelModel.buildArchivedRows, unit-tested in orgPanelModel.test.ts;
  the retired archiveProvider carried it before.)
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
- The Archive TREE view was RETIRED in s3b-archive-overlay (see that slice's binding
  section below); the archived rows now render in an in-panel overlay. The
  cleanup-survival read path is UNCHANGED and still binding: an archived chat whose
  transcript was cleaned up out of band still lists (membership comes from the synced
  flag, not the scan); its title falls back to the body copy's stored title (loaded
  asynchronously), and the overlay row previews the Nest-owned body copy instead of the
  live transcript (claudeNest.previewArchivedChat), so a cleaned-up row stays openable
  (the whole point of the copy). previewArchivedBody reads the copy by sessionId and
  routes through the SAME pure formatter as the live preview (formatPreviewLines), so the
  two renderings are byte-identical; a missing or empty copy surfaces an info notice,
  never a blank document.
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

## In-panel Settings overlay and auto-archive engine (Sprint 3, slice s3b-settings-overlay) — binding

The Settings sub-page is an in-panel OVERLAY inside the org-panel webview, not a
standalone WebviewPanel; a separate batched engine AUTO-ARCHIVES live chats on a
window that is DISTINCT from the copy-pruning keep-window above. These rules are
binding so reviewers never read the two windows as a conflation bug, no new synced
scalar leaks onto ProjectMeta, and the auto-archive write adds no new fs path.

- TWO DISTINCT WINDOWS, kept structurally apart. The keep-window documented above,
  claudeNest.archiveKeepWindowDays (enum 7/30/90/0), still drives PRUNING of the
  Nest-owned body COPIES via the unchanged archiveRetention.ts decideRetention. This
  slice's AUTO-ARCHIVE window (7/14/30/90/1yr/Never) drives AUTO-ARCHIVING of LIVE
  chats and lives in its OWN pure module, src/store/autoArchivePolicy.ts, with an
  injected now. archiveRetention.ts is NOT extended and archiveKeepWindowDays is NOT
  overloaded: pruning a stale copy and auto-archiving a live chat are separate
  policies over separate inputs. Choosing "Never" for auto-archiving still keeps
  starred chats safe from Claude cleanup, because the protective-copy pass below is
  keyed to the Claude cleanup age, not to the auto-archive window.
- NO NEW SYNCED SCALARS. The auto-archive window AND the four section-visibility
  toggles (Starred, Questions, Folders, Unsorted) persist on workspaceState through
  the EXISTING OrgPanelStateStore get/set with new _KEY constants
  (AUTO_ARCHIVE_WINDOW_KEY, SECTIONS_VISIBLE_KEY), exactly like SORT_KEY /
  COLLAPSED_KEY. They are NEVER written to ProjectMeta; the synced surface stays
  exactly nest.meta.v1::<projectKey>, and autoArchivePolicy.ts never calls
  setKeysForSync. The section-visibility toggles are CLIENT-SIDE render gates only
  (they never touch membership or the store), so an unfiled chat stays reachable via
  the search box and tag chips regardless of the Unsorted toggle, and the Unsorted
  section still renders when every other section that could hold a given unfiled
  chat is hidden.
- RETENTION-CONVENTION REUSE for the pure policy. autoArchivePolicy.decideAutoArchive
  is pure with an injected now and matches decideRetention's conventions:
  keepWindowDays <= 0 is the Never sentinel (never auto-archive), STARRED is exempt
  (never auto-archived), a null last-activity keeps, and the boundary is inclusive
  (age exactly == window is kept; STRICTLY GREATER triggers the archive). The
  auto-archive window's default feeds from the effective cleanupPeriodDays via
  readCleanupPeriodDays (usingDefault -> CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30).
  decideAutoArchive takes TWO windows: archiveWindowDays (the user's chosen window,
  0 = disabled) governs the UNSTARRED 'archive' decision, and protectiveWindowDays
  (the effective Claude cleanup age) INDEPENDENTLY governs a STARRED 'copy' decision,
  so a starred chat older than the cleanup age receives a protective body copy even
  when auto-archiving is Never. The engine returns early only when BOTH windows are
  disabled.
- THE AUTO-ARCHIVE WRITE reuses the existing seams: store.setChatArchived (the synced
  userArchived flag) plus archiveBodyStore.writeArchivedBody (the Nest-owned body
  copy with archivedAt), BATCHED (N setChatArchived mutations coalesced into ONE
  flush, then one refresh), running on activation and after a scan refresh. It adds
  NO new fs write path and stays under the same read-only invariant as the rest of
  archiveBodyStore. The starred protective-copy branch uses the SAME writeArchivedBody
  seam (starred:true on the envelope) WITHOUT flipping userArchived, and skips any
  chat that already has a copy, so the pass is idempotent. src/store/autoArchiveEngine.ts
  is the vscode-thin orchestrator; the decision is unit-tested in
  src/test/unit/autoArchivePolicy.test.ts and the engine in autoArchiveEngine.test.ts.
- THE SETTINGS OVERLAY replaces the retired standalone panel. src/settings/settingsWebview.ts
  and media/settings.{html,css,js} are DELETED. Settings render as a position:absolute
  full-panel .nest-overlay DOM node inside the org-panel webview (media/orgPanel.js /
  orgPanel.css) with a back chevron, a Newsreader heading, a "Keep chats for" window
  select, and the four section-visibility pill switches. The gear opens it client-side;
  OPEN_SETTINGS_COMMAND is REPOINTED at the overlay (it focuses the org panel and posts
  an { type:'openSettings' } message the client handles) rather than opening a WebviewPanel,
  keeping the palette and the view/title menu homes working. Unlike the click-dismiss
  popovers, the overlay is a persistent sub-page tracked apart from
  closeAllTransientOverlays and closed only by the back chevron or Escape. Every label
  sink is textContent; the window select value and toggle states are coerced at the host
  boundary before reaching workspaceState. See DECISIONS.md Slice s3b-settings-overlay.

## In-panel Archive overlay and the Archive-tree retirement (Sprint 3, slice s3b-archive-overlay) — binding

Slice s3b-archive-overlay (issue #87) retires the claudeNest.archive TREE view and moves the
archived chats into an in-panel OVERLAY inside the org-panel webview, making the org panel
Nest's ONLY contributed view. These rules are binding so the retirement keeps the read-only
invariant, adds no new write path or synced scalar, and preserves the cleanup-survival read.

- ARCHIVED ROWS ARE A PURE BUILDER, POSTED ON DEMAND. orgPanelModel.buildArchivedRows
  (vscode-free, unit-tested) projects the SYNCED userArchived membership into
  JSON-serializable ArchivedRow[] {sessionId, title, folder, relativeTime, starred, present},
  mirroring buildSections -> postSections. It ports the membership + sort + fallback-title
  logic OUT of the deleted archiveProvider.ts: membership is ChatMeta.userArchived === true
  (NEVER the local orphan flag), present chats sort newest-first with gone chats after (then
  by sessionId), and a missing-transcript chat's title falls back to the injected body-copy
  title map, else the sessionId. The host posts { type:'archivedRows', rows } in response to
  the client's openArchive message (repointed from focusing the tree); the client renders the
  overlay from that post. A relativeTimeCompact seam keeps the builder clock-free and matches
  the tree rows' age.
- THE OVERLAY REUSES THE SETTINGS-OVERLAY CHROME. It is the SAME .nest-overlay
  (position:fixed;inset:0) persistent sub-page as Settings: a back chevron, a Newsreader
  heading, and the closeAllTransientOverlays-exempt teardown (closed only by the back chevron
  or Escape, with focus restored to the Archived (N) row). Two persistent sub-pages never
  stack (opening one closes the other). Its "Search archived" box uses a DISTINCT GRAY focus
  glow (#A6A294 ring, rgba(120,114,102,0.30) bloom), NOT the orange search glow (AC #2), and
  Restore hover fills #d97757 (AC #3). The search filters the posted rows CLIENT-SIDE by title
  substring (the prototype's c.title.includes(aq)); it does NOT touch the host MiniSearch index
  (which deliberately excludes archived chats), so no host round-trip and no parallel index.
- ROW INTENTS ROUTE THROUGH THE EXISTING COERCED SEAMS ONLY. Restore = restoreChat
  (setChatArchived(false), keeps the star), resolved to a record from the scan cache (real
  filePath when present so the copy is deleted; empty filePath when the transcript is gone so
  the copy is KEPT). Star-unarchive (AC #4) = setStarred(true) + restoreChat as a client
  intent (setChatStarred does NOT itself clear userArchived). Export = the exportIO-guarded
  exportChat seam. Preview = previewArchivedChat (the archived-copy read path, unchanged). Every
  inbound message is coerced at the coerce() boundary (sessionId as string) and every label is
  rendered as textContent, so no new write path, no new synced scalar, and the read-only
  invariant are introduced. The overlay is keyboard-operable (ARIA dialog, focusable rows and
  buttons, Escape closes; the search box's Escape clears first).
- THE TREE-RETIREMENT SURFACE IS SWEPT. package.json drops the claudeNest.archive view, its
  onView activation event, its viewsWelcome, its view/title and view/item/context menu entries,
  and the claudeNest.refreshArchive command; extension.ts drops the ArchiveProvider construction,
  createTreeView, the fallback-title loader, and the refreshArchive command, repointing the two
  claudeNest.archive.focus call sites (the auto-archive toast opens the overlay via
  orgPanelProvider.openArchiveOverlay; the org-panel openArchive posts the overlay). Exactly one
  view (claudeNest.orgPanel) remains contributed (AC #6). star/unstar/restore/archiveChat/
  previewArchivedChat stay registered for programmatic/overlay callers but have no menu surface
  (commandSurfaces regression gate). See DECISIONS.md Slice s3b-archive-overlay.

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
"Organize") that renders sections, tag chips, sort, per-folder color, folder
rename, and drag-and-drop. (Row density was removed in slice s3a-design-shell; see
that slice's rule below.) The native Folders and Tags TreeViews are
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
- ROW STATUS AND READ STATE (slice s3a-row-anatomy; supersedes the slice-6
  lastMessageRole === 'user' "awaiting-reply" rule). Each row carries a scan-time
  `status` in `{'question','done','none'}` (`src/views/orgPanelModel.ts` rowStatus),
  and the Questions section membership is now EXACTLY `status === 'question'`
  (awaitingReply is kept only as an alias of that). Both non-empty states are gated on
  the last turn being an UNREAD assistant turn:
  `unread = lastMessageRole === 'assistant' && (timestamp === null || timestamp > lastSeenAt)`;
  then `'question'` when unread and the tier-A last text asks something
  (`src/model/questionHeuristic.ts` asksSomething, a pure tail-window heuristic that
  replaced the inline trailing-'?' check), `'done'` when unread and it does not (a
  plain unread reply -> the solid unread dot), and `'none'` otherwise. A newer USER
  turn STRUCTURALLY clears the signal (lastMessageRole !== 'assistant' -> 'none'), so
  there is no transcript-watching write path. It is still a SCAN-TIME signal, not a
  live conversation state, and the panel keeps the heuristic framing.
- READ STATE IS PER-DEVICE, NEVER SYNCED. lastSeenAt is a per-chat epoch-ms map held
  by `src/views/readState.ts` (ReadStateStore), a vscode-thin adapter over an injected
  Memento backed in the host by `context.workspaceState`, which is structurally never
  part of Settings Sync, so the unread signal CANNOT widen the synced surface (which
  stays exactly `nest.meta.v1::<projectKey>`). The whole map persists under ONE JSON
  key (`claudeNest.orgPanel.lastSeenAt`), mirroring the collapsed-folder set, and this
  module NEVER calls setKeysForSync. markSeen is MONOTONIC (never regresses to an older
  stamp). The pure orgPanelModel imports no store and no vscode: lastSeenAt is threaded
  into buildSections as a plain `ReadonlyMap<sessionId, epochMs>` (default empty =
  nothing seen), so the unit gate never requires a store. A chat is marked seen by two
  paths: opening it via Nest, and the named-tab-focus clear trigger
  (`src/views/tabFocusMatch.ts` matchTabLabelToChat resolves the focused tab's label to
  the UNIQUE scanned title through the feature-detected 1.67 Tabs API shim; unnamed or
  duplicate-title tabs yield null, the accepted gap).
- Starred and Questions are CROSS-CUTTING sections: a chat can appear in Starred
  and/or Questions AND in its single home folder. Only the FOLDER placement is
  single-home (a chat appears under exactly its ChatMeta.folderId, or the synthetic
  Unsorted bucket when unfiled or the folderId no longer resolves, mirroring the
  Folders tree and the rollup counting rule).
- PER-FOLDER COLOR rides each folder section from Folder.color (slice 3); the panel
  renders a color dot on the folder header and the chip color on tag chips.
  Double-click a folder header to rename (an in-place editor posting a renameFolder
  message); right-click for the folder actions menu (rename, set/clear color,
  delete). renameFolder/setFolderColor/deleteFolder route through the EXISTING store
  mutations and the deleteFolder command (modal confirm + descendant cascade that
  unfiles member chats, never deleting a chat); the webview never invents a write
  path. Sort (newest/oldest/name) is persisted on workspaceState (per-workspace, NOT
  synced, so the sync surface stays exactly nest.meta.v1::<projectKey>). Row density
  was removed in slice s3a-design-shell (the handoff has a single row density) across
  all five coupled sites: orgPanel.css body[data-density] rules; orgPanel.js
  (densityEl, densityMode, and the comfortable branch in makeRow that held the tag
  pills + snippet); orgPanelWebview.ts (DENSITY_KEY, onSetState, postState, the
  inbound coercer, and the renderHtml select); and the fidelity harness mock. The tag
  pills and the last-message snippet, which previously rendered only in the
  comfortable branch, are now the SINGLE unconditional row behavior.
- ACCESSIBILITY IS AN ACCEPTANCE CRITERION. The list is role="tree" with
  role="treeitem" rows under role="group" sections, a single roving tabindex (one
  focusable row at a time), arrow-key navigation (Up/Down/Home/End), Enter/Space
  activation, and a visible focus ring (CSS). Since s3a-view-consolidation there
  is NO native fallback tree: the org panel's ARIA tree IS the accessibility
  surface (UI-SPEC.md deviation 5), so this criterion is load-bearing. Slice
  s3a-design-shell keeps it from regressing as chrome grows: the new sort popover
  (which replaces the native <select>) is a role=menu with menuitemradio items,
  fully keyboard operable (Enter/Space/Arrow keys, Escape closes and restores focus
  to the trigger, aria-expanded on the trigger), and the gear and New session
  buttons carry aria-labels and are keyboard-focusable. The Settings section-toggle
  UI is deliberately NOT in this slice (it lands in s3b).
- THE LINK NESTING TREE IS NOT RENDERED IN THE ORG PANEL (deferred, reversible).
  The Folders tree rendered linked children; the org panel does not yet have a link
  surface. Since s3a-view-consolidation both commands are PALETTE-callable with
  no-arg quick-pick paths (linkCommands.ts linkToChatFromPalette picks the source
  chat; unlinkChatFromPalette picks among the project's current designated-parent
  links, the exact nesting unlinkChat removes), and the pure links model remains
  intact for a future org-panel link surface. See DECISIONS.md Slice
  s2-org-panel-webview and s3a-view-consolidation.

## Design shell re-skin (Sprint 3, slice s3a-design-shell) — binding

Slice s3a-design-shell re-skins the org panel chrome to the pixel-exact handoff
(media/design/, UI-SPEC.md): the design-token palette, the New session pill, the
gear, the sort popover (replacing the native select), and the search-box visuals.
Full rationale and the reversible-fork record are in DECISIONS.md slice
s3a-design-shell; the binding structural facts:

- NEW SESSION uses a BUILD-TIME-PROBED entry point, not the URI /open path. The
  probe read the INSTALLED anthropic.claude-code package.json contributes (2.1.197
  and 2.1.198): it contributes claude-vscode.newConversation ("New Conversation"),
  the real new-chat command. The public URI /open?session=<id> path only RESUMES an
  existing chat and CANNOT start a fresh one, so it is not used here. The mechanism
  is src/launch/newSessionLauncher.ts (an injected, vscode-free, unit-tested seam
  mirroring uriLauncher.ts) tried through OrgPanelActions.newSession, with a graceful
  info toast on total failure (UI-SPEC.md deviation 6).
- THE NEWSREADER SERIF FONT IS BUNDLED, not fetched. media/fonts/
  newsreader-600-latin.woff2 (a wOF2-magic-verified subset) loads via an @font-face
  in orgPanel.css whose relative url('fonts/newsreader-600-latin.woff2') resolves
  against the stylesheet's webview URI under the pinned media localResourceRoots;
  CSP font-src cspSource already permits it, and a local serif stack (Georgia, serif)
  is the fallback. .vscodeignore excludes media/design/** and media/mockups/** but
  NOT media/fonts/**, so the font ships. No heading consumes the serif THIS slice
  (the Settings/Archive sub-page headings land in s3b), so the PACKAGING proof
  (vsce ls shows media/fonts/*.woff2 in the .vsix) is the gate, not the fidelity
  screenshot.
- THE "ARCHIVED (N)" ROW COUNTS ARCHIVED CHATS THAT ARE OTHERWISE HIDDEN. The pure
  buildSections/OrgSections now returns a unit-tested archivedCount, and it EXCLUDES
  userArchived chats (the synced flag) from every visible section AND the tag-chip
  counts, matching the handoff (archived chats live behind the Archive sub-page, the
  panel shows only a bottom "Archived (N)" row). Before this slice the model rendered
  every scanned record regardless of the archived flag; the DECISIONS.md fork note
  (f)/(e) records this as an intentional behavior correction, not a regression. The
  row opens the existing claudeNest.archive view until the s3b in-panel Archive
  overlay ships.
- TAG PILLS CARRY PER-TAG COLOR. OrgChatRow gains tagColors (parallel to tags,
  color-or-null per resolved tag) so the webview paints each pill in its handoff hue;
  the chip active state and the pill background use CSS color-mix for the handoff's
  alpha treatments.

## Folder tree rows and interactions (Sprint 3, slice s3a-folder-tree) — binding

Slice s3a-folder-tree rebuilt the folder rows and their interactions to the handoff
(issue #82). Full rationale and the reversible-fork record are in DECISIONS.md slice
s3a-folder-tree; the binding structural facts:

- ONE VISIBLE SUBLEVEL, TWO DEPTH FIELDS. FolderSection carries depth (CLAMPED to
  MAX_FOLDER_RENDER_DEPTH = 2 via the pure clampFolderDepth in folderTree.ts; the
  value the webview indent 11 + depth*18 and aria-level read) AND treeDepth (the true
  uncapped stored depth). The webview's collapse/hide bookkeeping keys on treeDepth,
  never the clamped depth, so two legacy folders that both clamp to render depth 2 keep
  distinct treeDepths and a collapsed clamped-deep folder still hides its clamped-deep
  descendants. The clamp affects ONLY the emitted depth; buildSections NEVER mutates the
  stored folders (the parentId chain and every record are untouched; a chat homed in a
  clamped-deep folder is still placed). Deeper legacy folders render at depth 2, never
  destroyed (UI-SPEC.md Folders data-mapping row).
- CREATE CAP (1) < RENDER CAP (2). MAX_FOLDER_CREATE_DEPTH = 1 governs new folder
  minting; MAX_FOLDER_RENDER_DEPTH = 2 governs display. createFolder enforces the create
  cap at the WRITE source: it refuses (with a message) to create under a parent already
  at the cap and passes maxDepth to expandFolderPath so a deep slash path is clamped to
  the allowed segments. Reused existing (legacy) segments are never blocked, only new
  minting, so a legacy grandchild is never disturbed. The org panel only ever creates at
  the top level (the + popover supplies no parent), so the refuse branch is defense in
  depth for the palette/programmatic path.
- ROLLED-UP HEADER COUNT. FolderSection.rolledUpCount is the folder's own directly-homed
  chats plus every descendant folder's, computed over the STORED hierarchy in the pure
  model (a visited-guarded memoized sum). The webview renders it in the folder header
  (not the post-filter visible.length). It is a stable structural count, independent of
  the render clamp and of any active filter (folder headers render only in the unfiltered
  tree; filtering swaps to the flat results list). Archived chats are excluded from the
  rollup, matching their exclusion from every visible section. This supersedes the interim
  direct-home count (s3a-row-anatomy DECISIONS (h)).
- IN-PANEL COLOR-SWATCH PICKER AND NEW-FOLDER POPOVER. The native <input type=color> is
  retired for an in-panel 8-swatch picker over the exact handoff palette (README line 98);
  the FOLDERS-header + button opens an in-panel new-folder popover (name + Create/Cancel)
  instead of the native input box. Both post through the existing message paths
  (setFolderColor with a palette literal or null; createFolder with an optional name that
  the host coerce trims and routes to createFolder's presetName). The picker sends only
  palette literals or null and the host re-validates every color via isValidColor before
  it reaches the store or a CSS sink; the folder name is rendered as textContent only and
  funnels into the same depth-capped expandFolderPath as the prompt path. Both popovers are
  keyboard-operable and restore focus to their anchor on close (the ARIA story does not
  regress; UI-SPEC.md deviation 5). The dropReducer stays frozen and the DnD drop highlight
  / Unsorted-header unfile / keyboard-and-ARIA tree are preserved from prior slices, not
  rebuilt.

## Search and tag chips in the org panel (Sprint 3, slice s3a-search-chips) — binding

Slice s3a-search-chips wires the org panel's search box to the EXISTING host
content-search seam and merges its full-text hits with the client-side tag-chip
filter, and delivers the role-prefixed body snippet (issue #83). Full rationale
and the reversible-fork records are in DECISIONS.md slice s3a-search-chips (the
fit review and the review+fix pass); the binding structural facts:

- RE-WIRE THE HOST SEAM, NEVER A PARALLEL CLIENT INDEX. Text search is HOST-ONLY
  (this file's "Search-index location" rules bind: the index lives in globalStorage
  or memory, is never synced, never under ~/.claude/projects, and the persisted
  index is TIER-A-ONLY). `media/orgPanel.js` onFilterInput posts a DEBOUNCED
  `{ type:'search', query }` and a new client `searchResults` handler stores the
  host-ranked `{ sessionId -> snippet }` join map plus the ranked-id order; the
  client NEVER re-implements a text index (the pre-slice title-only substring
  filter is gone from the text path). The host already carried the machinery
  (`orgPanelWebview.ts` postSearch/postSearchResults/rankRows, the SearchRow shape,
  the `search` inbound coercion); this slice only connects the client to it.
- THE FLAT "N RESULTS" VIEW MERGES HOST TEXT HITS WITH THE CLIENT TAG AND-FILTER
  BY sessionId. renderFiltered() intersects the host text hits with the client-side
  tag AND-filter (rowMatches): row content (tags, status, breadcrumb, star, time)
  comes from the client sections row; the body snippet comes from the host result.
  Tags stay CLIENT-SIDE, text stays HOST-ONLY, and the combined result is one flat
  list. The existing tag-only flat view (chips selected, no text) is PRESERVED
  EXACTLY as a pure client-side path with no host round-trip, and clearing the box
  restores the sectioned view unchanged.
- STALE-QUERY GUARD ON THE ASYNC REPLY. Because the query post is debounced and the
  host reply is async, the client trusts a `searchResults` payload ONLY when its
  query still equals the current normalized filter text (isFreshSearchReply); a late
  reply for a superseded query is dropped. Emptying the box drops any stale host map.
- THE ROLE-PREFIXED SNIPPET RIDES A STORE-ONLY BODY FEED, NOT A CHANGED buildSnippet.
  AC #1 requires a body-only match to render a "You: " / "Claude: " prefixed snippet.
  The pure, already-unit-tested `buildSnippet(source, term)` is kept BYTE-FOR-BYTE
  (its single-source tests, including the lone-'\n'-to-space collapse, must still
  hold). Instead: (a) the host `readBodyText` (orgPanelWebview.ts) reads one chat's
  bodies on demand, COLLAPSES each message's own internal whitespace to single spaces
  so every message is exactly one newline-free segment, PREFIXES each with its role
  label (ROLE_LABEL_USER "You: " / ROLE_LABEL_ASSISTANT "Claude: " from searchIndex.ts,
  threaded from ChatMessageBody.role in bodyReader.ts), and joins messages with '\n';
  (b) a NEW sibling pure function `buildRoleSnippet(bodyText, term)` in searchIndex.ts
  splits the stored body on newlines, snippets the matched segment via the unchanged
  buildSnippet, and re-prepends that segment's detected role label. search() uses
  buildRoleSnippet. FAITHFUL DEGRADATION: a marker-less source (a plain-text test
  feed, or the tier-A last-message/title feeds, which carry no role marker) yields no
  prefix, so every prior searchIndex test still passes. The per-message
  whitespace-collapse is load-bearing: without it a wrapped continuation line of a
  multi-line message would become an unlabelled segment and lose its role prefix
  (the review+fix-pass defect).
- THE INDEXED TEXT HAS ROLE LABELS STRIPPED; THE LABEL RIDES ONLY THE SNIPPET SOURCE.
  docFromRecord derives TWO fields from the role-labeled body: `bodyText` (label WORDS
  stripped per segment via stripRoleLabels) is the searchable field, and
  `bodySnippetSource` (labeled verbatim) is STORE-ONLY. FIELDS omits bodySnippetSource
  so no label word ("you"/"claude") is ever tokenized into a searchable term (otherwise
  a search for "claude" would match every chat); STORE_FIELDS includes it so the snippet
  can carry the label the index never saw. Both are exported and REUSED by searchStore's
  load-time options so the build-side and load-side field shapes cannot drift. This does
  NOT weaken the TIER-A-ONLY persisted invariant: a PERSISTED document is built without a
  body, so bodyText and bodySnippetSource are both empty on disk; the role-labeled body
  is an IN-MEMORY-only concern read on demand and discarded, exactly like the slice-2
  body feed.
- SNIPPET ONLY ON A BODY-ONLY MATCH (AC #1). rankRows SUPPRESSES the snippet (sends
  null) when the query is a case-insensitive substring of the record title (matching the
  prototype's `q && !c.title.toLowerCase().includes(q)` gate); otherwise it sends the
  role-prefixed snippet. The client renders the snippet row only when the joined row
  carries one, so a title match shows no snippet and a body-only match does.
- DEBOUNCE THE QUERY POST, NOT THE CHIP TOGGLE (AC #4). onFilterInput debounces the
  `{ type:'search' }` post so a fast typist does not fire a query per keystroke; a chip
  toggle stays IMMEDIATE (it is a pure client-side re-render). The host body-index build
  already yields to the event loop (BODY_READ_CHUNK) so the UI thread stays responsive.
- THE ARCHIVED (N) ROW RENDERS IN THE FILTERED VIEW TOO. The design authority
  (media/design/ChatSidebar.dc.html: the hasArchived block is a sibling after both the
  filtering and not-filtering blocks) shows the bottom "Archived (N)" row DURING
  filtering; renderFiltered() renders it at the end, so the sectioned and flat views both
  match the handoff. This does not change the archived-exclusion rule (archived chats stay
  out of every visible section and the tag-chip counts; only the summary count row shows).
- EVERY NEW RENDER SITE STAYS ON textContent/createElement (the security render-site
  class). orgPanel.js uses ZERO innerHTML/insertAdjacentHTML; the snippet and breadcrumb
  sinks are UNTRUSTED transcript text and are written as textContent only. The
  `.nest-row-snippet` / `.nest-row-breadcrumb` CSS, the chip active states, and the
  hexToRgba alpha helper already exist from s3a-design-shell and are reused, not rebuilt.
- NO SCHEMA/SCHEMA_VERSION CHANGE, NO NEW fs PATH, NO WIDENING OF THE SYNCED SURFACE.
  searchStore.ts adds no fs write path (it still persists only through exportIO behind
  assertNotUnderClaudeProjects); the change is the FIELDS/STORE_FIELDS reuse only. The
  synced surface stays exactly nest.meta.v1::<projectKey>. See DECISIONS.md Slice
  s3a-search-chips.
- THE FIDELITY HARNESS CAPTURES THE RESULTS STATE, not only the default. The
  visual-fidelity lens (this file's "Visual-fidelity harness" rules) is extended so
  scripts/fidelity/screenshot.js uses renderAndCapture's afterLoad hook to drive the
  filter input (and/or a chip) into the flat "N RESULTS" state, capture it, and compare
  against a matching filtered prototype capture; the default harness.png capture is
  unchanged.

## Accessibility closeout: the overlay modal-dialog contract (Sprint 3, slice s3c-docs-a11y) — binding

Slice s3c-docs-a11y (issue #89) is the docs and accessibility closeout. Beyond the
doc reconciliation (README, this file, CHANGELOG, TESTING rewritten for the one-panel
surface, walkthrough media updated), it hardens the two full-panel overlay sub-pages
into proper ARIA modal dialogs and completes the reduced-motion contract. These rules
are binding so the panel's ARIA story (UI-SPEC.md deviation 5, this panel is Nest's only
surface) is complete.

- EVERY role="dialog" SURFACE IS A MODAL DIALOG WITH A FOCUS TRAP. The CLASS is all three
  role="dialog" nodes in media/orgPanel.js: the full-panel Settings overlay
  (openSettingsOverlay), the full-panel Archive overlay (openArchiveOverlay), and the
  anchored New-folder popover dialog (openNewFolderPopover). Each now carries aria-modal="true"
  AND is wired at build time to the SHARED focus-trap helper wireDialogFocusTrap(node). The
  trap is a Tab keydown handler on the dialog node: Tab past the last focusable wraps to the
  first, Shift+Tab before the first wraps to the last, and a Tab while focus is somehow
  outside the dialog snaps back to the first focusable. This closes the gap where a keyboard
  or screen-reader user could Tab out of an open dialog into the org-panel tree still in the
  DOM behind or around it (the two overlays are position:fixed/absolute;inset:0 but do not
  remove the tree; the New-folder popover is a small anchored box over the same tree). The
  trap only manages Tab; Escape stays owned by the single document-level keydown handler and
  each dialog's own Escape wiring, which close the surface and restore focus to its trigger
  (the gear, the Archived (N) row, or the FOLDERS-header + button). The helper resolves
  focusables live on each Tab (querySelectorAll over the standard focusable set, skipping
  offsetParent-null hidden nodes), so the Archive overlay's per-keystroke body re-render does
  not stale the trap: the listener lives on the dialog node, which persists across those body
  rebuilds, and dies with the removed dialog. The transient menus and popovers that are NOT
  role="dialog" (the sort popover, the chat context menu, the folder color picker, the
  create-tag swatch picker) keep their arrow-key menu navigation and are deliberately not
  Tab-trapped: a role="menu" is driven by arrow keys, not Tab.
- PREFERS-REDUCED-MOTION IS HONORED PANEL-WIDE, not only on the question badge. The
  orgPanel.css @media (prefers-reduced-motion: reduce) block now neutralizes every panel
  transition and animation a reduced-motion user could perceive: the question `?` badge
  animation (already present, UI-SPEC.md deviation 3), the Settings section-switch thumb
  slide (transform transition) and its track-color fade, and the focus-glow border/shadow
  eases on the main and archive search inputs. It is a targeted rule list (the exact set
  of animated surfaces), not a global *{} reset, so the shipped panel and the fidelity
  harness neutralize the identical set. See DECISIONS.md Slice s3c-docs-a11y.

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
