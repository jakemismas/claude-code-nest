# Testing Claude Code Nest

This is the human-run install and manual-smoke checklist that the unattended
build cannot run (it needs a person in VSCode). The headless unit gate
(`npm test`: lint, compile, mocha) and the VSIX package proof run automatically
on every slice; the steps below are the things only a human can confirm.

Run these on return after a build session. Each slice that has landed adds its
own smoke section; check the ones whose slice is recorded in CHANGELOG.md.

## Install the packaged VSIX

The shipped artifact is `claude-code-nest-0.1.0.vsix` in the repo root.

1. From a terminal, install it directly:
   `code --install-extension claude-code-nest-0.1.0.vsix`. Or in VSCode, open the
   Extensions view, use the `...` menu, choose "Install from VSIX...", and select
   `claude-code-nest-0.1.0.vsix`.
2. If you need to rebuild the artifact from source instead, run
   `npx vsce package --no-dependencies -o claude-code-nest-0.1.0.vsix`, or
   `npm run package` (produces `nest-build-check.vsix`, the build-check name).
3. Reload the window when prompted.
4. Open a folder that has Claude Code sessions under `~/.claude/projects/` (for
   example this repo's own workspace), so the extension has chats to list.

## What to run

This file carries two waves of checks. The 0.0.1 slice sections (Slice 0 through
Slice 9) cover the views, storage, folders, tags, drag-and-drop, links, smart
groups, settings, export/import, and polish that the first release shipped. The
"Sprint 2 (v0.1.0)" section adds the checks for the second release: the tier-A
reader, the lazy body reader and hover preview, full-text search, the curation
scalars, star/archive, per-chat export, the token rollup, and the org panel that
is now the PRIMARY surface. Run both waves on a v0.1.0 install.

Note on the org panel migration: in v0.1.0 the Organize panel (a webview) is the
primary surface and the native Folders and Tags TREES are GONE. The Slice 2
(Folders) and Slice 3 (Tags) sections below still describe the underlying
single-home and many-to-many membership rules, which are unchanged, but you now
exercise them through the Organize panel and the flat Chats fallback rather than
the retired trees. The Chats (Preview) proof-of-concept webview is also gone,
superseded by the org panel.

Note on the one-panel consolidation (Sprint 3, slice s3a, unreleased): on a build
that includes s3a-view-consolidation, the flat Chats and Smart Groups TREES are
GONE too, and the Organize panel is the ONLY browsing surface (only the Archive
view and the Settings tab ride alongside it). Earlier steps that hover a chat row
for the rich preview card, run "Preview Full Chat" or "Export Chat..." from a
chat row, star or archive a LIVE chat, or exercise the flat or Smart Groups views
have no UI surface on such a build until the Sprint 3 part-2 in-panel hover card
and context menu land; skip those steps there (the commands and the card builder
stay registered and unit-tested). The per-row ~token badge still shows on
Organize panel rows, and every Archive view step still applies. See the Sprint 3
checklist below.

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

## Sprint 2 (v0.1.0): consolidated manual smoke checklist

These are the new checks for the v0.1.0 release, drawn from each Sprint 2 slice's
manual-smoke steps. The pure logic behind every item is covered by the headless
unit suite (`npm test`); the steps below are the only verification of the
vscode-bound surfaces. The read-only invariant above applies throughout: nothing
under `~/.claude/projects/` may change mtime or content, and the only sanctioned
write anywhere under `~/.claude` is the single-key `settings.json` edit. Every
other Nest write (archive copies, exports, the search index) lands in the
extension's own global storage through the `exportIO` chokepoint, which refuses
any target under `~/.claude/projects/`.

Pixel-exactness note: the org panel, hover card, and search rows are built to
`UI-SPEC.md`, whose visual target is `media/mockups/sidebar-mockup.html`. Open
that file in a browser (it has a Comfortable and a Compact frame) and compare it
against the rendered panel by eye. This is a human visual check only; there is no
automated pixel gate, because the build agent cannot see its own rendered webview.

### S2-0: Tier-A reader renders unchanged

1. Install v0.1.0 on a workspace with Claude Code sessions. Confirm the views
   render and behave exactly as before: the tier-A summary reader is read-only and
   adds no visible change of its own. No transcript under `~/.claude/projects/`
   changed.

### S2-1: Lazy body reader, token badge, and hover preview

1. Hover a chat row (in the Organize panel or the flat Chats view). Confirm a rich
   preview card appears showing the chat's folder, age, token total, the FULL tag
   set, the models used, the files-touched count, and BOTH a first and a last
   message snippet.
2. Confirm every chat row shows a `~`token badge beside its relative time, and that
   the same summary appears on the Organize panel rows.
3. Run "Preview Full Chat" on a chat row. Confirm it opens that one chat's full
   text in a read-only editor document. The body is read on demand and discarded;
   no transcript is written.

### S2-2: Full-text content search

Note: Sprint 3 (s3a-search-chips) removed the mode toggle. The single search box
now always matches both titles and message bodies; there is no "Search content"
control to switch to. Run the s3a-search-chips section below for the current
behavior. The index invariant below still holds.

1. In the Organize panel search box, type a query that matches some chats' content.
   Confirm matching chats rank by relevance and each body-only match shows a
   matched-context snippet under its title.
2. Clear the query and confirm the full list is restored.
3. The search index lives in the extension's global storage, is never synced, and
   is never written under `~/.claude/projects/`; confirm no transcript changed.

### S2-3: Curation scalars (no UI of its own)

1. This slice is store behavior only and is fully covered headless. It is exercised
   indirectly by the star/archive checks below (the synced starred, userArchived,
   archivedAt, and folder color scalars). No separate manual step.

### S2-4: Star, archive, restore, and the cleaned-up-copy survival case

1. Star a chat from a chat row. Confirm the star badge appears on every surface the
   chat shows on (Organize panel, flat Chats, and the Archive view), not just one.
   Unstar it and confirm the badge clears everywhere.
2. Archive a chat. Confirm it moves into the Archive view, and that a Nest-owned
   body copy is written under the extension's global storage
   (`globalStorage/archive/<sessionId>.json`).
3. Cleaned-up-copy survival (the headline case): with a chat archived, delete its
   underlying transcript from `~/.claude/projects/` out of band, then Refresh.
   Confirm the chat still appears in the Archive view with its stored title, and
   that "Preview Archived Copy" still opens its body from the Nest-owned copy. This
   proves the archived chat survives Claude Code's own cleanup.
4. Restore the chat from the Archive view. Confirm it leaves the Archive view, the
   archived copy is removed, and any star you set survives the restore.
5. Keep window: confirm the `Claude Code Nest > Archive Keep Window Days` setting
   (`7`, `30`, `90`, or `0` for never; default `30`) is present. Starred archived
   chats are always kept regardless of the window.
6. Confirm nothing under `~/.claude/projects/` changed through any of the above.

### S2-5: Per-chat export and the guarded-path refusal

1. Run "Export Chat..." on a chat row and pick Markdown. Confirm the saved file has
   a YAML front-matter org layer (title, folder, full tag set, starred flag, link
   ids, models, counts, and the token totals) followed by the readable transcript
   as labeled You/Claude turns.
2. Export the same chat as JSON. Confirm the file is a single versioned,
   round-trippable document.
3. Guarded-path refusal: in the save dialog, aim the export at a path under
   `~/.claude/projects/`. Confirm the write is REFUSED by the guard rather than
   overwriting a transcript (no transcript file is created or changed).

### S2-6: Token cost rollup

1. Run "Show Token Cost Rollup" from a view-title action. Confirm a read-only
   report opens summing each chat's token total by folder and by tag.
2. Confirm the by-FOLDER totals partition the library (each chat counted once in
   its single home folder or the Unfiled bucket), and that the by-TAG totals count
   a chat once per EACH of its tags, so a multi-tag chat adds its full total to
   every tag bucket and the by-tag sum can exceed the library total. Confirm the
   report carries the note explaining this so it does not read as a double-count
   bug. The report shows tokens only, never dollars.

### S2-7: Org panel as the primary surface

1. Open the Nest panel. Confirm the "Organize" panel is the PRIMARY view, with a
   Starred section, a Questions section (chats whose last turn was yours, LABELED a
   scan-time heuristic, not a live signal), the single-home folder hierarchy with
   per-folder color and counts, and an always-present Unsorted bucket.
2. Tag filter chips: click one or more tag chips and confirm the panel filters to
   chats carrying those tags; clicking again clears the filter.
3. Sort and density: switch sort (newest, oldest, name) and density (comfortable,
   compact) and confirm both take effect; confirm density persists across a reload.
4. Folder color: set a folder's color from its right-click actions menu and confirm
   the row shows the color.
5. Rename: double-click a folder (or press Enter on it) and rename it in place;
   confirm chats under it stay put.
6. Drag-to-unfile: drag a chat onto the Unsorted section (or empty space) and
   confirm it unfiles; drag a chat onto a folder to set its home; drag a chat onto
   a tag chip to apply that tag.
7. Keyboard and screen reader: confirm full keyboard navigation works (arrow keys
   move focus through the ARIA tree, Enter/Space activates a row, a single roving
   tabindex, a visible focus ring on BOTH chat rows and folder headers) and that
   rows carry sensible ARIA labels.
8. Flat Chats fallback: confirm the flat Chats view still lists every session
   newest-first and still works as the accessible fallback.
9. Retired trees gone: confirm the old native Folders and Tags TREES no longer
   appear in the panel (superseded by the Organize panel), and that the Chats
   (Preview) proof-of-concept webview is gone too.
10. Collapsible folders: click a folder's chevron to collapse it and confirm its
    chats and any subfolders hide, then expand it and confirm they return. With a
    folder header focused, press ArrowLeft to collapse (or move to the parent) and
    ArrowRight to expand (or move to the first child). Click "Collapse one level"
    and confirm the deepest open folder level folds. Collapse a folder, reload the
    window, and confirm it stays collapsed (state persists per workspace, not
    synced). Confirm the always-present Unsorted bucket has no collapse chevron.

## Sprint 3 (unreleased): manual smoke checklist

### S3A-0: One-panel view consolidation

1. Open the Nest panel. Confirm exactly TWO views: the Organize panel (the sole
   browsing surface) and the Archive view. The flat Chats and Smart Groups trees
   are gone, and no welcome view, view-title button, or context menu references
   them.
2. Confirm the Organize panel still lists, opens, searches, files, tags, sorts,
   and drags chats exactly as in S2-7 (clicking a row still opens or resumes the
   session through the public URI handler).
3. Run "Link to Chat..." from the Command Palette with nothing selected. Confirm
   it quick-picks the source chat before offering the target. Run "Unlink" the
   same way and confirm it quick-picks a linked child to unlink from its parent.
4. Run "Refresh" from the palette. Confirm it re-scans under a cancellable
   progress indicator and the Organize panel re-renders.
5. Confirm the Archive view still works end to end (the S2-4 steps): archived
   rows list, and Preview Archived Copy, Star/Unstar, and Restore all run from
   the row's context menu.
6. Interim gaps (accepted; they land later in Sprint 3): no hover preview card,
   no Preview Full Chat, no per-chat Export Chat..., and no star/archive of a
   LIVE chat anywhere in the UI. Confirm none of these appear in the palette or
   on any surviving surface, and that the per-row ~token badge still shows.
7. Confirm nothing under `~/.claude/projects/` changed.

### S3A folder-tree: rows, color picker, popovers, depth clamp (issue #82)

1. Folder header. Confirm each folder row shows a chevron, a folder-shape glyph
   filled with the folder color (default warm tan `#C2A56E`), a 13px/600 name that
   ellipsizes when long, and a chat count at the right. Confirm a TOP folder's
   count equals the chats directly in it PLUS the chats in its subfolders (add a
   chat to a subfolder and watch the parent's count rise).
2. Expand/collapse and rename. Click a folder's chevron to toggle it. Double-click
   a folder header to enter the inline rename editor; Enter commits, Escape cancels.
3. Color picker (AC2). Right-click a folder header and choose "Set color". Confirm
   an in-panel picker of EXACTLY eight swatches (the handoff palette) appears under
   the header, the current color is ringed, and there is a "Default" chip. Pick a
   swatch: the folder glyph recolors immediately. Reopen and pick "Default": the
   color clears back to the tan default. Confirm no OS-native color dialog ever
   opens. With the picker open, press Escape: it closes and focus returns to the
   folder header. Arrow keys move between swatches.
4. New-folder popover (AC3). Click the `+` in the FOLDERS header. Confirm an
   in-panel popover with a name input and Create/Cancel appears (no OS input box).
   Type a name and press Enter (or click Create): the folder is created and the
   panel re-renders. Reopen it and press Escape (or Cancel): nothing is created and
   focus returns to the `+` button.
5. One visible sublevel (AC4, creation). Create a folder, then try to create a
   folder UNDER an existing subfolder (via a slash path like `A/B/C` in the palette
   "New Folder", or the programmatic path). Confirm the tree never grows past one
   sublevel: `A/B/C` creates only `A` and its child `B`; `C` is dropped.
6. Legacy deep folder (AC4, render). If a folder tree deeper than two levels exists
   (e.g. synced from an older client), confirm the deeper folders still render,
   clamped at the second indent tier, and that NOTHING under `~/.claude/projects/`
   and no stored folder record changes (their nesting is preserved, just displayed
   clamped).
7. Collapse one level and re-expand all (AC4). Click the `^` in the FOLDERS header
   repeatedly. Confirm it folds the deepest open level first, then folds upward one
   tier per click, and once everything is folded the NEXT click re-expands the whole
   tree.
8. Drag and drop (AC5). Drag a chat row over a folder: confirm the folder shows the
   warm drop highlight (`#FAE6DC`) with an inset accent ring. Drop it: the chat
   moves into that folder. Drag a chat onto the UNSORTED header: the chat's folder
   clears. Confirm nothing under `~/.claude/projects/` changed by any drop.
9. Keyboard and ARIA (AC6). Tab into the tree; confirm a single roving focus, arrow
   Up/Down navigation, ArrowRight/Left to expand/collapse a folder, Enter/Space to
   activate, and a visible focus ring throughout.

### S3A search + chips: flat results, role snippets, tag combine (issue #83)

1. Flat results view. Type a query in the search box that matches some chats.
   Confirm the sectioned tree (Starred, Questions, folders) is replaced by a flat
   list headed `N RESULTS`, where N is the number of matching rows. Clear the box
   and confirm the sectioned tree returns immediately with no flash of stale rows.
2. Title vs body match. Type a word that appears in a chat's TITLE: confirm that row
   shows NO snippet under it. Type a word that appears only in a chat's message BODY
   (not its title): confirm that row shows a matched-context snippet under the title.
3. Role-prefixed snippet. For a body-only match, confirm the snippet begins with
   `You: ` when the matched line was your message, or `Claude: ` when it was the
   assistant's. The snippet must center on the line that actually contains your
   query word (e.g. searching a term that appears only in Claude's reply shows a
   `Claude: ...` snippet of THAT line, not an unrelated `You: ...` line).
4. Role words are not a wildcard (regression). Type `claude` (then also `you`) in a
   workspace where those words do NOT appear in any chat's title or message text.
   Confirm the results list does NOT balloon to every chat: only chats that
   genuinely contain the typed word match. Type a prefix like `cla`, `clau`, `claud`
   and confirm the same (no all-chats false match while typing). A chat that really
   contains the word "you" in a message still matches `you`.
5. Multi-word query. Type two words that appear in the SAME chat (e.g. one in your
   line and one in Claude's). Confirm the chat matches and its snippet is centered
   on the line that contains one of your real query words, regardless of the order
   you typed the two words.
6. Tag chips (AND). Click a tag chip: confirm it toggles active (filled) and the
   list narrows to chats carrying that tag. Select a SECOND chip: confirm the list
   narrows further to chats carrying BOTH tags (AND, not OR). Click a chip again to
   deselect it.
7. Text AND tags combined. With a text query typed AND one or more tag chips active,
   confirm the results are the chats that match the text AND carry every selected
   tag. Removing all chips while keeping the text, or clearing the text while keeping
   chips, each falls back to the single-filter behavior.
8. Sort applies to results. With a filter active, change the sort (Newest, Oldest,
   Name). Confirm the flat results reorder accordingly (the match set is unchanged;
   only the order changes).
9. Archived row persists while filtering. With any chat archived, confirm the bottom
   `Archived (N)` row is present BOTH in the normal sectioned view AND while a text
   or tag filter is active. Clicking it still opens the Archive view.
10. Responsiveness and no transcript write. Type quickly and confirm the box stays
    responsive (the query is debounced; the list fills in as results land). Confirm
    nothing under `~/.claude/projects/` changed by any search.

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
- The contributed `claudeNest` view set and the activitybar container, read from
  the SAME `package.json` the host loaded as the Extension Manifest (since slice
  s3a-view-consolidation, exactly the Organize webview plus the Archive tree,
  asserted as the exact set).
- A `viewsWelcome` empty-state ships for the Archive tree (the only remaining
  TreeView), no welcome targets a retired view id, and no welcome string blames
  Claude for the empty state.
- The raster gallery icon (`media/icon.png`) and the getting-started walkthrough
  (with multiple steps) are contributed and the icon file exists.
- `getChildren(undefined)` returns `[]` and never throws for the kept non-view
  folders/tags services when no project resolves, and `primeSnapshot` (the
  progress-scan entry point) also does not throw on an absent project. This is
  the host-side confirmation of the empty-state contract the headless unit suite
  proves in the pure scan/provider layer.
