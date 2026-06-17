# Testing Claude Code Nest

This is the human-run install and manual-smoke checklist that the unattended
build cannot run (it needs a person in VSCode). The headless unit gate
(`npm test`: lint, compile, mocha) and the VSIX package proof run automatically
on every slice; the steps below are the things only a human can confirm.

Run these on return after a build session. Each slice that has landed adds its
own smoke section; check the ones whose slice is recorded in CHANGELOG.md.

## Install the packaged VSIX

The shipped artifact is `claude-code-nest-0.0.1.vsix` in the repo root.

1. From a terminal, install it directly:
   `code --install-extension claude-code-nest-0.0.1.vsix`. Or in VSCode, open the
   Extensions view, use the `...` menu, choose "Install from VSIX...", and select
   `claude-code-nest-0.0.1.vsix`.
2. If you need to rebuild the artifact from source instead, run
   `npx vsce package --no-dependencies` (produces `claude-code-nest-0.0.1.vsix`),
   or `npm run package` (produces `nest-build-check.vsix`, the build-check name).
3. Reload the window when prompted.
4. Open a folder that has Claude Code sessions under `~/.claude/projects/` (for
   example this repo's own workspace), so the extension has chats to list.

## The read-only invariant (assert on every session)

Before and after exercising the extension, confirm nothing under
`~/.claude/projects/` was written, renamed, moved, or deleted. The extension's
only sanctioned write anywhere under `~/.claude` is the single-key
`settings.json` edit (cleanupPeriodDays) that the Slice 7 Settings webview
performs through the read-only chokepoint (see the Slice 7 section below); it
never touches `~/.claude/projects/`. If any transcript file changed mtime or
content from using the extension, that is a stop-the-line failure.

## Slice 0: Scaffold, read JSONL, flat list

1. Open the Nest workspace. The "Claude Code Nest" panel appears in the Activity
   Bar with its nest icon.
2. The Chats (flat) view lists every chat for the active workspace, each showing
   a title and a relative time (for example "3 hours ago").
3. A workspace with no Claude Code sessions shows the welcome view ("No Claude
   Code chats found for this workspace yet.") with a Refresh action.
4. Click a chat. It opens or resumes that session in Claude Code through the
   public URI handler. Confirm the correct session opens.
5. The Refresh action in the view title re-scans and updates the list.

## Slice 1: Storage (persistence across a window reload)

1. With the extension active on a workspace, create a tag or a folder (via the
   slice that exposes the affordance; until the Folders/Tags views land you can
   exercise this indirectly once those slices are installed).
2. Reload the window (Developer: Reload Window).
3. Confirm the metadata persists: the tag or folder you created is still present
   after the reload.
4. Cross-machine (best effort, optional): with Settings Sync enabled and signed
   in on a second machine, confirm a folder/tag created on machine A appears on
   machine B after sync settles. This is last-writer-wins per the documented
   honest warning; a concurrent edit to the same field on both machines may lose
   one side, which is expected and surfaced.
5. Orphan handling (optional, advanced): if a chat's transcript is removed from
   disk, its organization is not hard-deleted; it is soft-marked and archived
   only after the grace window. A scan that returns zero or far fewer chats than
   last seen is treated as suspect and skipped rather than mass-archiving.

## Slice 2: Folders view (single-home hierarchy)

This is also the slice that lets you finish the Slice 1 reload-persistence check
above: the Folders view is the affordance Slice 1 said could only be exercised
"once those slices are installed."

1. Open the Nest workspace. The Folders view appears in the claudeNest panel
   alongside the flat Chats view.
2. Create a nested folder via a slash name: run "New Folder" and enter
   `Work/ClientA`. Confirm two folders appear, ClientA nested under Work, and
   that neither folder's displayed name contains a literal slash.
3. Create a child under an existing folder: right-click `Work`, choose
   "New Folder", and enter `ClientB`. Confirm ClientB appears under Work (not at
   the top level), and that Work was reused rather than duplicated.
4. Assign a chat to a folder: right-click a chat (in either view) and choose the
   assign-to-folder action, then pick `Work/ClientA`. Confirm the chat now
   appears under ClientA and under NO other folder (exactly one home). Re-assign
   it to `Unfiled` ("Move out of folder") and confirm it moves to the Unfiled
   bucket.
5. Unfiled bucket: confirm every chat with no folder appears under the Unfiled
   node (inbox icon), and that the Unfiled node has no rename/delete menu items.
6. Rename: rename `ClientA` to `ClientA-Renamed` and confirm the label updates in
   place and any chat under it stays put. Confirm a rename to a name a sibling
   already uses is rejected, and that typing a slash in a rename is rejected.
7. Delete with cascade: create `Work/ClientA/Q1`, assign a chat to `Q1`, then
   delete `Work`. Confirm the confirmation names the folder and the nested-folder
   count, that Work and all descendants disappear, and that the chat that was in
   `Q1` is NOT deleted but moves to Unfiled.
8. Reveal/selection stability (Slice 1 + binding rules): with a chat assigned to
   a folder, reload the window (Developer: Reload Window). Confirm the folders,
   the chat's folder assignment, and the Unfiled membership all persist exactly
   as before the reload (this is the deferred Slice 1 persistence verification),
   and that selecting a chat keeps its selection across a Refresh.

## Slice 3: Tags view (many-to-many membership plus Untagged)

1. Open the Nest workspace. The Tags view appears in the claudeNest panel
   alongside the Chats and Folders views.
2. Create two tags via "New Tag" (for example `urgent` and `review`). Confirm both
   appear in the Tags view.
3. Many-to-many: tag one chat with BOTH tags (use the tagging affordance from
   Slice 4, or assign the tags individually). Confirm the SAME chat appears under
   `urgent` AND under `review` at the same time (one occurrence per tag), proving
   the many-to-many membership.
4. Untagged bucket: confirm a chat with no tags appears ONLY under the synthetic
   Untagged node and under no real tag. Confirm Untagged is synthetic (it has no
   delete menu) and sorts last after the real tags.
5. Last-tag removal: remove tags from the chat in step 3 one at a time. Confirm it
   leaves each tag's bucket as that tag is removed, and that removing its LAST
   remaining tag moves it into Untagged.
6. Single owning parent: confirm selecting an occurrence under one tag and
   revealing it stays within that one tag's subtree (each occurrence resolves to
   exactly one owning tag), and that the same chat under two tags is two distinct
   rows, never a duplicated or merged single row.

## Slice 4: Drag and drop plus context-menu tagging

1. Multi-select tag QuickPick (primary affordance): right-click a chat in any
   view and choose "Tag Chats...". Confirm a checkbox QuickPick (canPickMany)
   lists every tag with the chat's current tags pre-checked. Toggle some on and
   off, confirm with Enter, and verify the Tags view reflects exactly the
   confirmed set (added tags gain an occurrence, unchecked tags lose theirs).
   Confirming without changes makes no edit; pressing Escape cancels with no
   change.
2. Inline tag button: confirm a chat row in the Chats, Folders, and Tags views
   shows an inline tag button that opens the same multi-select picker.
3. Multi-select batching: in the Chats view, ctrl/shift-select several chats,
   right-click, choose "Tag Chats...", and confirm a tag checked ON is applied to
   EVERY selected chat in one action (the picker pre-checks only the tags common
   to all of them). Unchecking a common tag removes it from all of them.
4. Drag a chat onto a folder (Folders view): drag a chat row and drop it on a
   folder. Confirm the chat moves to that folder (single home), and dropping it on
   the Unfiled bucket (or empty space) unfiles it.
5. Drag a chat onto a tag (Tags view): drag a chat occurrence and drop it on a
   different tag row. Confirm the chat gains that tag (a new occurrence appears
   under the target tag) while keeping its other tags. Dropping on the Untagged
   bucket does nothing.
6. Multi-drag: select several chats and drag them onto a folder (or a tag).
   Confirm all of them move (or gain the tag) and the view refreshes once.
7. Cross-view drag (the headline feature): drag a chat FROM the Folders view and
   drop it onto a tag in the Tags view; confirm the chat gains that tag (a new
   occurrence appears under the tag) without losing its folder home. Then drag a
   chat occurrence FROM the Tags view and drop it onto a folder in the Folders
   view; confirm its single home moves to that folder. This exercises the
   cross-tree carrier path: VSCode strips the custom chat MIME on a cross-tree
   drop, so the payload rides the source tree's reserved MIME, which each
   controller now lists in dropMimeTypes.
8. Cross-view interpretation: confirm the SAME drag is interpreted by the target
   view, not the source: dropping on the Folders view moves the home; dropping on
   the Tags view adds a tag. An unrecognized drag source (a file, another
   extension's tree) is a no-op.

## Slice 5: Links plus branch display

These exercise the parts of the slice that cannot run headless: all of the
vscode-side rendering (the branch icon, the muted broken-target styling, the
nested splice in the Folders tree) and the link/unlink commands against the real
window.

1. Link a chat under another (parent nesting): in the Folders view, right-click a
   chat row (chat A) and choose "Link to Chat...". Choose a target chat (chat B).
   Confirm chat B now renders NESTED beneath chat A in the Folders tree as a child
   row with a git-branch icon, while chat B also still appears in its own folder
   home (the link adds a nested appearance, it does not move B).
2. Only the parent kind is offered: confirm the link flow does NOT prompt for a
   link "kind" and never creates a "related" link (the related kind is deferred
   this slice; the only effect of linking is the parent nesting).
3. Cycle / self-link prevented: link B under A, then try to link A under B. Confirm
   the tree does not enter an infinite expansion (the visited-set guard prevents a
   cycle); the nesting renders only one way and expanding the nested rows
   terminates. Also confirm a chat cannot be linked to itself (the source chat is
   not offered as its own target).
4. Broken target shows muted: link a target chat, then remove that target chat's
   transcript from disk (or pick a target that is later deleted) and Refresh.
   Confirm the linked child still appears but renders MUTED/label-only (the link is
   still visible and unlink-able) and does not expand into children.
5. Unlink removes the nesting: right-click the nested linked-child row under chat A
   and choose "Unlink". Confirm the nested row disappears (chat B no longer renders
   under A) and the view refreshes once. Chat B itself is not deleted and still
   appears in its folder home.
6. Multiple parents resolve deterministically (optional): link the same child B
   under two different source chats. Confirm B nests under exactly ONE of them (the
   one with the smaller chat id) on every refresh, never under both at once;
   unlinking that visible nesting makes B nest under the other source on the next
   refresh.
7. Drop onto a linked-child row files alongside (regression): drag a chat and drop
   it directly onto a nested linked-child row. Confirm the dragged chat is filed
   into the SAME folder as that linked child (alongside it) and is NOT unfiled.

## Slice 6: Smart Groups (read-only, promotable)

These exercise the parts of the slice that cannot run headless: the Smart Groups
view rendering, the four signal groups, the promote context menu, and empty-group
rendering against the real window. The bucketing logic itself is covered by the
headless unit suite; this checklist is the only verification of the vscode-bound
view.

1. The view appears: open the Nest workspace. A Smart Groups view appears in the
   claudeNest panel alongside Chats, Folders, and Tags. It lists four signal-group
   rows in fixed order: By Pull Request, By Ticket Prefix, By Git Branch, By Fork
   Lineage.
2. Read-only invariant: nothing in this view ever moves or files a chat on its own.
   Expanding a group or a bucket never changes a chat's folder home or tags; the
   only write is the explicit promote command in step 5. Re-confirm no transcript
   under `~/.claude/projects/` changed.
3. The PR group lists chats with PR links (the solid signal): expand By Pull
   Request. Confirm there is one bucket per distinct PR (labeled "PR #<n> (<repo>)"
   or the url) and that expanding a bucket lists every chat that worked that PR.
   A chat that worked two different surfaces can appear under more than one signal
   group (e.g. a PR bucket and a branch bucket) without error.
4. Empty best-effort groups render cleanly: expand By Ticket Prefix, By Git Branch,
   and By Fork Lineage. On this user's real data these are typically empty. Confirm
   each shows as a childless row marked "best-effort, none" (not an error, not a
   spinner, not a missing row). The detached-HEAD branch is deliberately suppressed,
   so a workspace whose sessions all report branch "HEAD" shows an empty Git Branch
   group.
5. Promote a bucket to a tag, idempotently: right-click a PR bucket row and choose
   the promote-to-tag action. Confirm a tag named like the bucket label is created
   in the Tags view and every member chat now carries it. Right-click the SAME
   bucket and promote-to-tag AGAIN: confirm NO duplicate tag is created (the
   existing tag is reused by label) and no chat gains a second copy. Repeat the
   same check with promote-to-folder on a bucket: the members file into one
   top-level folder, and a second promote reuses that folder by name rather than
   creating a duplicate.
6. Promote does not disturb the read-only buckets: after promoting, confirm the
   Smart Groups view still shows the same buckets (promotion creates a folder/tag,
   it does not consume or remove the smart group), and that the promoted chats kept
   any folder/tag they already had (promote-to-tag is additive; promote-to-folder
   sets the single home).

## Slice 7: Settings webview (cleanupPeriodDays, surgical write plus guard)

These exercise the parts of the slice that cannot run headless: the WebviewPanel
rendering and CSP/nonce assembly, the gear affordance on the view titles, and a
real edit landing on `~/.claude/settings.json` through the chokepoint. The
surgical-edit, path-assertion, validation, and mtime-guard logic itself is
covered by the headless unit suite (`claudeSettingsIO.test.ts`,
`settingsProtocol.test.ts`); this checklist is the only verification of the
vscode-bound webview. The read-only invariant above applies: `settings.json` is
the ONE file the extension may write, and nothing under `~/.claude/projects/`
may change.

1. Open the gear: in any claudeNest view (Chats, Folders, Tags, Smart Groups),
   click the gear button in the view title bar (or run "Claude Code Nest
   Settings" from the command palette). Confirm a "Claude Code Nest Settings"
   webview panel opens. Re-opening the gear reveals the SAME panel rather than
   stacking duplicates.
2. Current value and the global warning: confirm the panel shows the current
   `cleanupPeriodDays`. If the key is absent from `~/.claude/settings.json`, the
   panel shows Claude's default (30) flagged as the default, not as an explicit
   setting. Confirm the panel carries a prominent warning that this is a GLOBAL
   setting (it affects Claude Code in every workspace, not just this project).
3. Edit to a valid integer: change the value to a valid whole number (for
   example 14) and save. Confirm the panel reports success and re-reads the new
   value. Then open `~/.claude/settings.json` in an editor and confirm: the
   `cleanupPeriodDays` value is the new integer; every OTHER key, comment,
   whitespace, key order, and the file's EOL style are intact (the edit is a
   surgical byte-range splice, not a reformat). If the key was absent before,
   confirm it was inserted (as the first member) without disturbing the existing
   members. Saving the same value again rewrites nothing.
4. Non-integer is rejected: enter a decimal (`14.5`), an expression, an empty
   value, or a negative number and save. Confirm the panel shows a validation
   error and `settings.json` is NOT modified (no write occurs on a rejected
   value).
5. The read-only invariant holds: after editing, re-confirm nothing under
   `~/.claude/projects/` changed mtime or content. The only file the extension
   wrote is `~/.claude/settings.json`. (If you want to confirm the chokepoint
   itself, note that the headless unit suite already proves a write aimed at any
   path other than the one allowed `settings.json` throws.)

## Slice 8: Export and import plus cross-machine sync hardening

These exercise the parts of the slice that cannot run headless: the real save and
open dialogs, a JSON file landing on disk, the merge applied through the live
store, the LWW warning toast, the activation/window-focus reconcile poll, and the
opt-in auto-export snapshot with retention. The pure logic itself (the additive
per-project merge and collision identity rule, schema validation and version
migration, the reconcile algorithm, scratch-validate-before-swap, the retention
prune) is covered by the headless unit suite (`exportImport.test.ts`,
`exportImportStore.test.ts`, `reconcileSync.test.ts`, `schemaMigrate.test.ts`,
`autoExport.test.ts`); this checklist is the only verification of the vscode-bound
file IO and toasts. The read-only invariant above applies: every export/import and
snapshot write goes through `src/store/exportIO.ts`, which runtime-asserts the
target is NOT under `~/.claude/projects/`; nothing there may change.

1. Export the library: create some organization first (a folder, a tag on a chat,
   a parent link). Run "Claude Code Nest: Export Library" (command palette).
   Confirm a save dialog opens defaulting to `claude-code-nest-export.json`. Save
   it to a scratch location (for example your Desktop). Confirm the success toast
   reports the project count and the file path, and that the file exists and is
   pretty-printed JSON containing your projects with their folders, tags, chats,
   links, and stamps.
2. Import on a clean store: simulate a fresh machine by clearing the extension's
   stored organization (uninstall/reinstall the VSIX, or use a clean VSCode
   profile), then run "Claude Code Nest: Import Library" and pick the JSON from
   step 1. Confirm the open dialog appears, the success toast reports the merged
   project count, and the Folders/Tags views re-render with the imported
   organization. Confirm NO project that existed only on the clean store was
   deleted (the merge is additive; a project absent from the file is untouched).
3. Additive merge, never-delete-absent: on a store that ALREADY has organization,
   import a JSON that carries a DIFFERENT folder/tag for the same project. Confirm
   the result is the UNION (the live folder/tag AND the imported one both survive;
   chat tags and links are unioned), and no live-only project or record was
   dropped.
4. LWW warning on a real conflict: prepare a JSON whose copy of a chat sets a
   DIFFERENT non-null home folder than the live store's copy, with a newer chat
   `updatedAt`. Import it. Confirm the warning toast appears once ("merged
   organization across machines ... the most recent edit won and the other was
   dropped"), the chat's home is the newer side, and tags/links were still kept
   from both. Then re-focus the window (click away and back) and confirm the
   warning does NOT re-fire and the views do not re-merge (the import finalized the
   reconcile shadow, so the next focus poll reports unchanged).
5. Cross-machine reconcile on focus: with Settings Sync enabled on two machines
   (or simulated by editing the synced globalState from a second profile), make a
   foreign organization change on the other machine. Return focus to this window
   and confirm the change is merged additively (your local-only records survive),
   the views refresh, and any genuine same-folder conflict surfaces the LWW
   warning exactly once per focus-gain, not repeatedly.
6. Opt-in auto-export and retention: on first activation confirm the one-time
   prompt offers "Enable auto-export" / "Export now..."; it must not nag again
   after a choice. Enable auto-export, then make several organization edits
   (create folders, tag chats) spaced a few seconds apart. Confirm snapshot JSON
   files accumulate under the extension's global storage `auto-export/` directory
   (a debounced burst coalesces into one snapshot), and that old snapshots are
   pruned to the retention count rather than growing without bound. Confirm a
   single rapid burst of edits produces ONE snapshot, not one per edit.
7. The read-only invariant holds: after every step above, confirm nothing under
   `~/.claude/projects/` changed mtime or content. The export, import-source, and
   auto-export snapshot files are all OUTSIDE `~/.claude/projects/`. (The headless
   suite proves `exportIO` throws on any target under `~/.claude/projects/`, so a
   save dialog pointed there is refused rather than overwriting a transcript.)

## Slice 9: Polish (empty state, progress, icons, walkthrough, marketplace metadata)

These exercise the parts of the Polish slice that cannot run headless: the
viewsWelcome rendering, the cancellable progress notification on a Refresh, the
gallery icon and walkthrough, and the marketplace metadata in a real install. The
pure logic is covered by the headless unit suite (`scanProgress.test.ts` for the
scanner progress/cancellation seam, `refreshScanCommands.test.ts` for the
progress-command orchestration); this checklist is the only verification of the
vscode-bound surfaces. The read-only invariant above applies: the scan reads
transcripts read-only and writes nothing.

1. Empty-state welcome: open a workspace that has NO Claude Code sessions under
   `~/.claude/projects/` (or a brand-new folder). Confirm each of the four views
   (Chats, Folders, Tags, Smart Groups) shows its viewsWelcome message rather than
   an error, a spinner, or a blank pane, and that the welcome text never says
   Claude failed. The Chats/Folders/Tags welcomes read "No Claude Code chats found
   for this workspace yet."; the Smart Groups welcome explains the read-only
   buckets. Each welcome carries an action button (Refresh / New Folder / New Tag).
2. getChildren never throws: with the empty workspace above, confirm no error
   notification fires from the views themselves (a failed or absent scan renders
   empty, it does not throw). Open the Output/Developer Tools console and confirm
   no unhandled exception from a `getChildren` call.
3. Cancellable progress on a large scan: open a workspace whose project dir holds
   many transcripts. Run Refresh in any view (the refresh button in the view
   title). Confirm a progress notification appears titled "Scanning <view>..." with
   a Cancel affordance. On a very large library the notification is visible while
   the scan runs. Note: the scan is synchronous per the design (getChildren and
   getParent stay synchronous), so the Cancel button takes effect for a re-issued
   refresh rather than interrupting an in-flight synchronous scan; the progress
   indicator and the cancellation plumbing are present and the scan completes and
   re-renders the view.
4. Scan-failure toast wording: if a scan ever fails, confirm the error toast reads
   "Claude Code Nest could not finish scanning <view>. Your chats and organization
   are unchanged; try Refresh again." and never attributes the failure to Claude.
5. Gallery icon and metadata: in the Extensions view, confirm the installed
   "Claude Code Nest" tile shows the raster gallery icon (`media/icon.png`, the
   nest motif on a deep indigo tile) rather than a default placeholder, and that
   the details page shows the description, keywords, repository, homepage, and
   issues links from `package.json`.
6. Walkthrough: open the Command Palette and run "Welcome: Open Walkthrough...",
   then choose "Get Started with Claude Code Nest". Confirm the four steps render
   (Open the Nest panel, Organize with folders and tags, Explore smart groups, Back
   up your library), each with its markdown body and a working command button.
7. Telemetry-free: confirm the extension sends no telemetry. There is no telemetry
   reporter in the codebase (no `@vscode/extension-telemetry` dependency, no
   `createTelemetryLogger` call); the only user-visible output is the in-window
   toasts and the views.

## Integration tests (deferred)

The electron-host integration tests (`npm run test:integration`) need a VSCode
download and a display, so they are not part of the unattended gate. Run them
locally or in CI when validating activation and view registration.

How to run: `npm run test:integration`. The script runs
`node ./out/test/integration/runTest.js`, which downloads a VSCode build (cached
under `.vscode-test/` after the first run) and launches an Extension Development
Host. The launcher (`src/test/integration/runTest.ts`) points the host at
`src/test/integration/index.ts`, a mocha runner that globs only
`out/test/integration/**/*.test.js` (never the headless `out/test/unit/**`, so an
integration spec can never be pulled into `npm test`). A network-restricted or
headless-display machine cannot download/launch VSCode; that is the deferral, not
a missing artifact.

Slice 4 integration test (authored, under `src/test/integration/dndContract.test.ts`,
run only by the command above, never in the headless gate). It asserts:

- Both views construct a real `TreeDragAndDropController` (a `createTreeView` with
  each controller succeeds in the host).
- Each controller's `dragMimeTypes` is its own reserved MIME plus the shared chat
  MIME (`application/vnd.code.tree.claudenest.chat`).
- Each controller's `dropMimeTypes` lists BOTH reserved MIMEs
  (`application/vnd.code.tree.claudenest.folders` and
  `application/vnd.code.tree.claudenest.tags`) plus the shared chat MIME, so a
  cross-view drag is offered the peer tree as a drop target.
- Those reserved MIME strings equal the auto-derived
  `application/vnd.code.tree.<viewidlowercase>` value VSCode computes from the
  contributed view ids, read from the SAME package.json the host loaded as the
  Extension Manifest (the package.json<->reserved-MIME contract).
- A real cross-tree drag lands the store mutation, exercised through real
  `vscode.DataTransfer` / `vscode.DataTransferItem` objects: a Folders
  `ChatMemberItem` dragged onto a Tags `TagItem` adds the tag and KEEPS the folder
  home, and a Tags `ChatOccurrenceItem` dragged onto a Folders `FolderItem` moves
  the single home and KEEPS the tags. The cross-tree carrier (the host strips the
  custom chat MIME and the payload rides only the source reserved MIME) is
  reproduced by copying only the source reserved-MIME item into the drop transfer,
  and a within-view drop (full transfer preserved) plus a foreign-source no-op are
  also covered. This is the one behavior the headless `dropPayload` / `dropReducer`
  unit tests cannot exercise without the host, and the controller's node-dispatch
  helpers (`chatIdsFromSource`, `targetIdFor`) using `instanceof` against the
  `vscode.TreeItem` subclasses are verified only here.

Slice 9 (Polish) integration test (authored, under
`src/test/integration/activation.test.ts`, run only by the command above, never in
the headless gate). It asserts:

- The extension is present as a loaded extension in the host
  (`vscode.extensions.getExtension('jakemismas.claude-code-nest')`), proving the
  host loaded this manifest.
- The four `claudeNest` views and the activitybar container are contributed, read
  from the SAME `package.json` the host loaded as the Extension Manifest.
- A `viewsWelcome` empty-state ships for every one of the four views and none of
  the welcome strings blames Claude for the empty state.
- The raster gallery icon (`media/icon.png`) and the getting-started walkthrough
  (with multiple steps) are contributed and the icon file exists.
- `getChildren(undefined)` returns `[]` and never throws for all four providers
  when no project resolves, and `primeSnapshot` (the progress-scan entry point)
  also does not throw on an absent project. This is the host-side confirmation of
  the empty-state contract the headless unit suite proves in the pure scan/provider
  layer.
