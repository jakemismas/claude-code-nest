# Claude Code Nest: Architecture and Binding Design Rules

This document is the living contract for the build. The fit review and the
adversarial review lenses check each slice against it. Build agents must honor
the binding rules below. Keep this file updated as slices land.

## Overview

Claude Code Nest is a VSCode extension that overlays a virtual organization
layer (folders, tags, links, smart groups, and a settings editor) on Claude Code
chat transcripts for a single project. It contributes its own Activity Bar view
container (claudeNest) and never modifies Claude's data beyond one sanctioned,
guarded settings write.

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
  - The two controllers are constructed in extension.ts and passed to each
    createTreeView's dragAndDropController option (they are NOT self-registering).
    Both the foldersView and tagsView createTreeView calls set canSelectMany:true
    (required so a multi-chat drag carries every selected chat) AND the
    dragAndDropController option. The flat (Chats) view ALSO sets canSelectMany:true
    but has NO dragAndDropController: there it only enables ctrl/shift multi-select
    for the contributed "Tag Chats..." command (the multi-select batching TESTING.md
    Slice 4 step 3 verifies), not a drag path.
- Refresh coalescing: batch a multi-select mutation into ONE store write and fire
  onDidChangeTreeData once (targeted to affected parents where possible).
  Implement the batch via the store's EXISTING mutation coalescing, NOT a new batch
  API: apply the reducer's intent list as N synchronous store.setChatFolder /
  store.addChatTag calls (which coalesce into one pending write), then a single
  await store.flush() and a single provider.refresh() (the same shape as
  deleteFolder's cascade).
- Empty state: getChildren(undefined) returns [] and a viewsWelcome contribution
  shows the no-sessions message. Never throw out of getChildren. (Slice 9 Polish
  VERIFIED this unchanged across all four providers and the four viewsWelcome
  entries, and added the progress/cancellation path WITHOUT making getChildren or
  getParent async: those stay synchronous on the memoized snapshot, and an explicit
  Refresh command primes that snapshot under vscode.window.withProgress with a
  CancellationToken via the ScanPrimable.primeSnapshot seam, then fires
  onDidChangeTreeData once. The scanner stays vscode-free: scanChats takes optional
  plain-callback {onProgress, shouldCancel} that the vscode layer supplies. The scan
  is synchronous, so cancellation takes effect on a re-issued refresh, not mid-scan;
  see DECISIONS.md Slice 9. FlatProvider gained the same memoized-snapshot shape the
  other three providers already had so priming it caches the scan.)
- Separator-namespace discipline: tag, folder, and chat ids are generated free of
  ':', '#', '>'. Enforce in the id factory. The synthetic-node sentinels live in
  the same id-space but are NOT mintable and are excluded from the factory's
  mintable set: '__unfiled__' (Folders), '__untagged__' (Tags), and the four Smart
  Groups signal-group ids '__smart_pr__' / '__smart_ticket__' / '__smart_branch__'
  / '__smart_fork__' (Slice 6). The Smart Groups view adds a TWO-char '::' bucket-id
  namespace on top of the three single-char composite separators: a bucket row is
  `${groupId}::${bucketKey}` and a chat row under it is `${bucketNodeId}::${chatId}`.
  This namespace is reserved ONLY under a '__smart_*__' group prefix that no other
  view mints, and smart-group ids are never fed to the single-':' tag-occurrence
  parser (the view treats a bucket key as opaque and stores memberChatIds directly
  rather than splitting the id), so it does not collide with the parsed
  composite-id grammars. See DECISIONS.md (Slice 6 sentinels and '::' namespace).

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
  last-writer-wins per scalar field (folderId) by updatedAt, union links. The
  irreducible floor is a concurrent same-scalar-field edit, which loses one side
  and is surfaced.
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

## Git landing strategy

Direct-to-main with explicit author and a normalized local committer, both Jake
Mismas <jake@jakemismas.com>. No AI author or co-author trailer, no generated-by
markers. Each tested slice commits straight to main and pushes, carrying the
trailer `Nest-Slice: <id> (<order>)`. A slice counts as done only after a
confirmed push verified on the remote. The gitignored .nest-build-state.json is
never staged or committed.
