# Claude Code Nest: Slice Plan

Ten dependency-ordered vertical slices, each leaving the extension installable
and working. This is the build contract. ARCHITECTURE.md holds the binding
design rules and the sync architecture; DECISIONS.md records autonomous design
calls; CHANGELOG.md records the per-slice landing.

## Universal Definition of Done (per slice)

Per-slice notes below list only the deltas. Every slice must also satisfy:

- tsc --noEmit clean.
- eslint clean.
- npm test green (the headless node + mocha unit suite).
- vsce package succeeds (the install proof).
- The three-lens-plus-completeness adversarial review comes back dry (no
  critical or major finding survives).
- README feature section and CHANGELOG entry updated.
- ARCHITECTURE.md updated when the slice changes a binding contract.
- Committed directly to main with Jake Mismas as author and committer, pushed,
  and verified on the remote.
- The read-only invariant re-asserted in review of any slice that touches the
  filesystem.

The manual UI smoke checklist is NOT run during the unattended build (it needs a
human in VSCode). Each slice lists its manual smoke steps below; they are
consolidated into TESTING.md at handoff for the user to run on return.

## Test layering

- Unit tests (headless): node + mocha against compiled out/test/unit/**. Pure
  logic only; these never import the vscode module. This is what `npm test`
  runs and what the workflow TEST gate verifies.
- Integration tests (electron host): @vscode/test-electron under
  out/test/integration/**. These need a VSCode download and a display, so they
  are deferred to TESTING.md and run by the human or CI, not during the
  unattended build.

## Slice 0: Scaffold, read JSONL, flat list

- Ships: namespaced Activity Bar view container claudeNest; one tree view
  claudeNest.flat listing every chat as title plus relative time; click fires
  the URI handler; engines.vscode ^1.66.0.
- Modules: package.json, src/extension.ts, src/claude/projectKeyResolver.ts,
  src/claude/jsonlReader.ts (line-type scan, tolerant), src/claude/chatScanner.ts
  (glob *.jsonl only), src/launch/uriLauncher.ts, src/views/flatProvider.ts,
  src/model/types.ts.
- Tests: unit on jsonlReader (line-type title and timestamp extraction,
  malformed-line tolerance), projectKeyResolver (encoding table plus cwd
  self-verify and scan fallback), uriLauncher with an injected openExternal spy.
- Manual smoke: open the Nest workspace; the claudeNest panel appears in the
  Activity Bar; the flat view lists every chat with a title and a relative time;
  clicking a chat opens or resumes it in Claude.

## Slice 1: Storage (per-project ProjectMeta model, stamps, reconcile scaffolding)

- Ships: MetadataStore backed by globalState with per-project keys and
  setKeysForSync; the full ProjectMeta schema with updatedAt and deviceId stamps;
  debounced serialized writes; orphan reconcile with the zero-result circuit
  breaker (mark archived, never hard-delete).
- Modules: src/store/schema.ts, src/store/metadataStore.ts,
  src/store/reconcile.ts, src/store/deviceId.ts.
- Tests: unit on store CRUD against a fake Memento, schema versioning and
  migration, reconcile transitions and the zero-result guard, last-writer-wins
  serialize guard.
- Manual smoke: create a tag or folder, reload the window, and confirm the
  metadata persists.

## Slice 2: Folders view (single-home hierarchy)

- Ships: claudeNest.folders tree; create, rename, delete folder; assign a chat
  to a folder via context menu; slash-nested folder names; a synthetic Unfiled
  node; chat node id `${folderId}#${chatId}`; getParent returns the one owning
  folder.
- Modules: src/views/foldersProvider.ts, src/model/folderTree.ts,
  src/commands/folderCommands.ts.
- Tests: unit on slash-path expansion, single-home invariant, tree assembly from
  flat records.
- Manual smoke: create a nested folder via a slash name; assign a chat to it;
  the chat appears under exactly one folder; rename and delete behave; unfiled
  chats appear under Unfiled.

## Slice 3: Tags view (many-to-many plus Untagged; composite-id mandate lands here)

- Ships: claudeNest.tags tree; create and delete tag; the ChatOccurrence wrapper
  model with composite id `${tagId}:${chatId}` and getParent returning the single
  owning tag; the synthetic Untagged tag (id __untagged__) recomputed and
  memoized on refresh for every chat with empty tags.
- Modules: src/views/tagsProvider.ts, src/model/occurrence.ts,
  src/model/untagged.ts.
- Tests (highest priority): composite-id round-trip, tree-wide uniqueness across
  a 50-by-8 synthetic set, getParent returns exactly one parent, Untagged
  membership equals the empty-tags set, node-object memoization.
- Manual smoke: tag one chat with two tags; it appears under both; an untagged
  chat appears only under Untagged; removing the last tag moves it to Untagged.

## Slice 4: Drag and drop plus context-menu tagging

- Ships: context menu and QuickPick (canPickMany) as the primary affordance plus
  inline row buttons; TreeDragAndDropController on both views with the per-view
  reserved MIME plus one shared chat MIME; handleDrag sets a DataTransferItem;
  handleDrop asserts MIME and interprets by target view; canSelectMany; batched
  single-fire refresh.
- Modules: src/dnd/dndController.ts, src/commands/taggingCommands.ts,
  src/ui/tagQuickPick.ts.
- Tests: unit on the pure drop reducer (MIME guard, folder-move vs tag-add,
  multi-node batching); one electron test asserting controllers register and
  MIME types match package.json.
- Manual smoke: multi-select chats and drag onto a tag (adds the tag) and onto a
  folder (moves home); the QuickPick canPickMany tagging works; an unrecognized
  drop source is a no-op.

## Slice 5: Links plus branch display

- Ships: link-to-chat and unlink commands; links[] with kind parent or related; a
  linked child renders nested beneath its parent in the Folders tree as a
  distinct linkedChild node with a git-branch ThemeIcon; visited-set cycle and
  diamond guard; broken-target shown muted.
- Modules: src/model/links.ts, src/views/linkDecoration.ts, foldersProvider splice.
- Tests: unit on the link graph builder, transitive-cycle and diamond detection,
  parent-child nesting, broken-target handling, unique ids when a chat is both a
  folder member and a linked child.
- Manual smoke: link chat B under chat A; B renders nested under A with the
  branch icon; a cycle is prevented; a deleted target shows muted; unlink
  removes the nesting.

## Slice 6: Smart Groups (read-only, promotable)

- Ships: a Smart Groups section with read-only buckets: by prNumber/prUrl
  (solid), by ticket-prefix regex (best-effort), by gitBranch (best-effort), by
  fork-lineage shared message-UUID prefix (best-effort, often empty); recompute
  on refresh; never auto-file; idempotent promote-to-folder and promote-to-tag.
- Modules: src/smart/smartGroupEngine.ts,
  src/smart/signals/{pr,ticket,branch,forkLineage}.ts,
  src/commands/promoteSmartGroup.ts, src/views/smartGroupsProvider.ts.
- Tests (high priority): each signal as a pure function; fork-lineage on
  synthetic shared and divergent uuid prefixes; promotion produces correct
  idempotent store mutations; empty groups render cleanly.
- Manual smoke: the PR smart group lists chats with PR links; promote it to a
  tag and confirm the tag is created idempotently; empty best-effort groups
  render without error.

## Slice 7: Settings webview (cleanupPeriodDays, surgical write plus guard)

- Ships: a gear opening a CSP-locked, nonce-scripted WebviewPanel; reads
  settings.json for the key (shows Claude's default when absent) with a prominent
  "this is global" warning; validates an integer; writes back via a jsonc
  byte-range edit preserving formatting and EOL, single-key, with a pre-rename
  mtime re-stat and abort-on-change; routes through the read-only chokepoint
  asserting the target path.
- Modules: src/settings/claudeSettingsIO.ts, src/settings/settingsWebview.ts,
  media/settings.{html,js,css}.
- Tests: unit on claudeSettingsIO against fixtures (preserve siblings and
  formatting, create when missing, reject non-integer, abort on mtime change,
  path-assertion throw); webview protocol via a fake messenger.
- Manual smoke: open the gear; the current cleanupPeriodDays (or Claude's
  default when absent) shows with the global warning; change it to a valid
  integer and confirm settings.json updates with siblings and formatting intact;
  a non-integer is rejected.

## Slice 8: Export and import plus sync hardening

- Ships: export to a chosen JSON (all projects, with stamps); import that
  validates and migrates a scratch copy then atomically swaps and merges
  additively per project; the additive cross-machine reconcile (union tags,
  LWW-per-field, union links) on activation and window focus; the honest LWW
  warning; debounced opt-in auto-export with retention.
- Modules: src/store/exportImport.ts, src/store/reconcileSync.ts,
  src/store/schemaMigrate.ts, src/commands/exportImportCommands.ts.
- Tests: unit on round-trip, schema validation, version migration, additive
  per-project merge and collision identity rule, the reconcile algorithm,
  scratch-validate-before-swap.
- Manual smoke: export the library to JSON; import it on a clean store and
  confirm an additive merge with no project deleted; confirm the LWW warning is
  shown.

## Slice 9: Polish

- Ships: empty-state and welcome views; progress and cancellation on large scans;
  lazy per-project load; icons and walkthrough; telemetry-free; error toasts that
  never blame Claude; marketplace metadata.
- Tests: one electron test for activation and empty-state rendering; the rest is
  in TESTING.md.
- Manual smoke: with no sessions, the welcome view shows the no-sessions message;
  a large scan shows progress and can be cancelled; an induced error shows a
  toast that does not blame Claude.
