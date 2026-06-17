# Testing Claude Code Nest

This is the human-run install and manual-smoke checklist that the unattended
build cannot run (it needs a person in VSCode). The headless unit gate
(`npm test`: lint, compile, mocha) and the VSIX package proof run automatically
on every slice; the steps below are the things only a human can confirm.

Run these on return after a build session. Each slice that has landed adds its
own smoke section; check the ones whose slice is recorded in CHANGELOG.md.

## Install the packaged VSIX

1. Build the artifact (if not already present):
   `npm run package` produces `nest-build-check.vsix` in the repo root.
2. In a clean VSCode, open the Extensions view, use the `...` menu, choose
   "Install from VSIX...", and select `nest-build-check.vsix`. Or from a
   terminal: `code --install-extension nest-build-check.vsix`.
3. Reload the window when prompted.
4. Open a folder that has Claude Code sessions under `~/.claude/projects/` (for
   example this repo's own workspace), so the extension has chats to list.

## The read-only invariant (assert on every session)

Before and after exercising the extension, confirm nothing under
`~/.claude/projects/` was written, renamed, moved, or deleted. The extension's
only sanctioned write anywhere under `~/.claude` is the future single-key
`settings.json` edit (cleanupPeriodDays), which is not part of the built slices
yet. If any transcript file changed mtime or content from using the extension,
that is a stop-the-line failure.

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
