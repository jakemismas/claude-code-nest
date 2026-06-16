# Changelog

All notable changes to Claude Code Nest are recorded here. The format follows
Keep a Changelog, and the project adheres to semantic versioning.

## [Unreleased]

### Added

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
