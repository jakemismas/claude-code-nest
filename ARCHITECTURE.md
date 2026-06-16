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
  render empty gracefully. PR grouping is the one to make solid.
- cleanupPeriodDays is currently ABSENT from ~/.claude/settings.json. The present
  top-level keys are permissions, model ("opus[1m]"), and hooks (with absolute
  Windows paths). The webview must handle read-when-missing (show Claude's
  default) and create-on-write without disturbing siblings.

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
  call shape, not just member calls. A bank of eslint no-restricted-syntax
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
    (import * as fs from 'fs') stays legal because every write through it is a
    member or computed call already covered above.
  All selectors have an override carve-out for ONLY the sanctioned settings-IO module
  (src/settings/claudeSettingsIO.ts, which holds the path-asserting chokepoint)
  and the scratch-fixture test tree. The carve-out is staged ahead of the settings
  module so the guard is already in force before any write-capable slice lands.
  Lint is wired into the headless test gate (pretest runs lint before compile and
  mocha), so the chokepoint cannot be bypassed by skipping a separate command.
  Nothing may ever write under ~/.claude/projects/.
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
  reserved MIME is REQUIRED in dropMimeTypes for the cross-view drop to work: in
  VSCode 1.66 the host delivers a custom MIME (the shared chat MIME) to handleDrop
  only when the drag started in the SAME controller, and to be offered as a drop
  target for a peer tree's drag a controller must list that peer tree's reserved
  MIME (application/vnd.code.tree.<viewidlowercase>). handleDrop reads the payload
  from whichever recognized MIME is present, asserts the payload MIME, and
  interprets by the TARGET view. Reject unrecognized sources as a no-op. See
  DECISIONS.md (Slice 3, dropMimeTypes peer-reserved-MIME).
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
    dragAndDropController option.
- Refresh coalescing: batch a multi-select mutation into ONE store write and fire
  onDidChangeTreeData once (targeted to affected parents where possible).
  Implement the batch via the store's EXISTING mutation coalescing, NOT a new batch
  API: apply the reducer's intent list as N synchronous store.setChatFolder /
  store.addChatTag calls (which coalesce into one pending write), then a single
  await store.flush() and a single provider.refresh() (the same shape as
  deleteFolder's cascade).
- Empty state: getChildren(undefined) returns [] and a viewsWelcome contribution
  shows the no-sessions message. Never throw out of getChildren.
- Separator-namespace discipline: tag, folder, and chat ids are generated free of
  ':', '#', '>'. Enforce in the id factory.

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
