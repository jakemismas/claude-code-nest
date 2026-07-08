# Testing Claude Code Nest

This is the human-run install and manual-smoke checklist that the unattended
build cannot run (it needs a person in VSCode). The headless unit gate
(`npm test`: lint, compile, mocha) and the VSIX package proof run automatically
on every slice; the steps below are the things only a human can confirm.

Sprint 3 rebuilt Nest into a SINGLE sidebar panel. This file is the consolidated
smoke checklist for that one-panel surface: it exercises the whole shipped panel,
section by section, drawn from every Sprint 3 slice's smoke steps in
SPRINT-3-PLAN.md. The retired Sprint 1 and Sprint 2 surfaces (the flat Chats tree,
the Folders and Tags trees, the Smart Groups tree, the Archive tree, and the
standalone Settings editor tab) are gone and are not tested here; the underlying
rules they used to exercise (single-home folders, many-to-many tags, the read-only
invariant, export/import, the token rollup) now run through the one panel and are
covered in the sections below.

## The one-panel surface at a glance

The product is ONE VS Code sidebar view, `claudeNest.orgPanel` ("Organize"),
rebuilt to the Claude-design handoff at `media/design/`. Everything lives in that
panel:

- A toolbar (New session pill, gear, sort popover) and a search box with tag chips.
- Sections in order STARRED / QUESTIONS / FOLDERS / UNSORTED, with per-row status
  markers (a blinking `?` for an unread question, a solid dot for an unread reply).
- A rich hover card, a right-click context menu, inline folder rename, a folder
  color picker, a new-folder popover, and in-panel drag-and-drop.
- Two full-panel overlay sub-pages reached from inside the panel: Settings (the
  gear) and Archive (the bottom `Archived (N)` row).

No other Nest view is contributed. The palette still carries the non-view commands
(Refresh, New Folder, New Tag, Link/Unlink, Export/Import Library, Show Token Cost
Rollup, Settings), which reveal or drive the one panel.

## Install the packaged VSIX

The handoff artifact produced by the engine is `nest-build-check.vsix` in the repo
root (`npm run package`, or `npx vsce package --no-dependencies -o nest-build-check.vsix`,
regenerates it). It is the FEATURE-COMPLETE Sprint 3 one-panel build, carrying all of
Parts 1 through 3 on top of the released 0.1.1 surface. It is the build the human verify
gate installs. It is NOT yet the TAGGED v0.2.0 "One Panel" release: the human verify gate
(#76) and the pre-release security council (#90) gate the release run (#91) that bumps the
version and tags, so this handoff still reports version 0.1.1 and carries no tag.

1. From a terminal, install it directly by path:
   `code --install-extension nest-build-check.vsix` (use the full path to the `.vsix`
   if you are not in the repo root, e.g.
   `code --install-extension /path/to/nest-build-check.vsix`).
2. Or from inside VSCode: open the Command Palette and run
   "Extensions: Install from VSIX...", then select the `.vsix`. (Equivalently, open the
   Extensions view, use the `...` menu at the top, and choose "Install from VSIX...".)
3. To rebuild the artifact from source, run `npm run package` (produces
   `nest-build-check.vsix`).
4. Reload the window when prompted.
5. Open a folder that has Claude Code sessions under `~/.claude/projects/` (for
   example this repo's own workspace), so the extension has chats to list.

## How to run this checklist

Run these on return after a build session, or as the HUMAN VERIFY GATE (#76) with
the design prototype `media/design/ChatSidebar.html` open in a browser beside
VSCode so you can eye-compare the panel to the design as you go.

Work top to bottom. The read-only invariant (next section) is asserted at the start
and end of every session. Each section below maps to a Sprint 3 slice and its issue.
The accessibility section is a full keyboard-and-screen-reader pass over the whole
panel; run it last, after the feature sections have populated the panel with folders,
tags, and chats to navigate.

## The read-only invariant (assert on every session)

Before and after exercising the extension, confirm nothing under
`~/.claude/projects/` was written, renamed, moved, or deleted. The extension's
only sanctioned write anywhere under `~/.claude` is the single-key `settings.json`
edit (`cleanupPeriodDays`) that the Settings overlay performs through the read-only
chokepoint; it never touches `~/.claude/projects/`. Every other file Nest writes
(archive body copies, exports, the search index) lives in the extension's own
storage. If any transcript file changed mtime or content from using the extension,
that is a stop-the-line failure.

A quick way to check: note the newest transcript's mtime before you start, exercise
the panel hard (open chats, hover, search, archive, restore, export), and confirm no
transcript mtime moved afterward.

## Panel shell: tokens, toolbar, sort, search visuals (issue #80)

1. Warm light design on a dark theme. On a DARK VSCode theme, open the Organize
   panel. Confirm it renders the warm light design (panel background `#FCFBF8`,
   accent `#d97757`), NOT the dark theme colors: the hardcoded handoff palette
   drives the panel this sprint.
2. Toolbar layout. Confirm a "New session" pill on the LEFT, a spacer, then a gear
   button, matching the prototype.
3. Sort popover. Open the sort control. Confirm exactly three options, Newest first
   (default) / Oldest first / Name A-Z, with an accent checkmark on the active one
   (not the OS-native dropdown). Pick each and confirm every list, and the flat
   results list, reorders. Confirm the choice persists across a window reload.
4. New session. Click the "New session" pill. Confirm it opens a fresh Claude Code
   chat (via the installed `claude-vscode.*` new-chat command, with a graceful
   fallback), and that when no Claude Code command is available it shows an
   informational toast instead of throwing.
5. Search focus glow. Click into the search box. Confirm the orange focus glow and
   the clear button match the prototype.
6. Sections and Archived row. Confirm the sections render in order STARRED /
   QUESTIONS / FOLDERS / UNSORTED, that Starred and Questions are hidden when empty
   while Unsorted is always present, and that the bottom `Archived (N)` row is
   present and opens the Archive overlay.
7. Font packaging. Confirm the Newsreader serif heading font (used on the overlay
   sub-page headings) is served from the extension, with no network fetch
   (disconnect if unsure and confirm no failed font request).
8. Confirm nothing under `~/.claude/projects/` changed.

## Chat rows: anatomy, read state, question badge, unread dot (issue #81)

1. Row anatomy. Confirm each chat row shows the status slot, title, tag pills, a
   tabular relative time (formats `35m` / `3h` / `1d` / `2w` / `1mo`), and a star
   toggle, with the exact paddings and colors of the prototype. There is no per-row
   token badge (it moved to the hover card).
2. Unread dot. Find (or create) a chat whose last turn is an assistant REPLY that
   does not ask a question and that you have not opened since. Confirm the row shows
   a solid unread dot.
3. Question badge. Find (or create) a chat whose last unread turn is an assistant
   message that ASKS something. Confirm the row shows a blinking `?` badge and a
   folder breadcrumb, and that the chat appears in the QUESTIONS section.
4. Reduced motion. Turn on the OS "reduce motion" setting and confirm the `?` badge
   is static (not blinking) while still present. (See the accessibility section for
   the full reduced-motion sweep.)
5. Clear on open. Open the unread chat from the panel. Confirm both the dot and the
   `?` clear. Repeat but clear by FOCUSING the chat's Claude Code tab instead of
   clicking the row, and confirm the marker clears the same way. Confirm a newer
   USER message in a chat also clears its marker.
6. Per-device, never synced. Confirm the read state is per device: opening a chat on
   this machine clears its marker here only (the marker is workspace-local Memento
   state, never in Settings Sync).
7. Active-row tint and starred row. Confirm the chat whose tab is focused gets a
   subtle active-row tint (`#F6E5DB` with an inset accent border), and that a STARRED
   row is NOT tinted just for being starred (the active tint is the only row tint).
8. Confirm nothing under `~/.claude/projects/` changed.

## Folders: rows, color picker, popovers, depth clamp, drag-and-drop (issue #82)

1. Folder header. Confirm each folder row shows a chevron, a folder-shape glyph
   filled with the folder color (default warm tan `#C2A56E`), a 13px/600 name that
   ellipsizes when long, and a chat count at the right. Confirm a TOP folder's count
   equals the chats directly in it PLUS the chats in its subfolders (add a chat to a
   subfolder and watch the parent's count rise).
2. Expand/collapse and rename. Click a folder's chevron to toggle it. Double-click a
   folder header to enter the inline rename editor; Enter commits, Escape cancels.
3. Color picker. Right-click a folder header and choose "Set color". Confirm an
   in-panel picker of EXACTLY eight swatches (the handoff palette) appears under the
   header, the current color is ringed, and there is a "Default" chip. Pick a swatch:
   the folder glyph recolors immediately. Reopen and pick "Default": the color clears
   back to the tan default. Confirm no OS-native color dialog ever opens. With the
   picker open, press Escape: it closes and focus returns to the folder header. Arrow
   keys move between swatches.
4. New-folder popover. Click the `+` in the FOLDERS header. Confirm an in-panel
   popover with a name input and Create/Cancel appears (no OS input box). Type a name
   and press Enter (or click Create): the folder is created and the panel re-renders.
   Reopen it and press Escape (or Cancel): nothing is created and focus returns to the
   `+` button.
5. One visible sublevel (creation). Try to create a folder UNDER an existing
   subfolder (via a slash path like `A/B/C` in the palette "New Folder", or the
   programmatic path). Confirm the tree never grows past one sublevel: `A/B/C` creates
   only `A` and its child `B`; `C` is dropped.
6. Legacy deep folder (render). If a folder tree deeper than two levels exists (e.g.
   synced from an older client), confirm the deeper folders still render, clamped at
   the second indent tier, and that NOTHING under `~/.claude/projects/` and no stored
   folder record changes (their nesting is preserved, just displayed clamped).
7. Collapse one level and re-expand all. Click the `^` in the FOLDERS header
   repeatedly. Confirm it folds the deepest open level first, then folds upward one
   tier per click, and once everything is folded the NEXT click re-expands the whole
   tree.
8. Drag and drop. Drag a chat row over a folder: confirm the folder shows the warm
   drop highlight (`#FAE6DC`) with an inset accent ring. Drop it: the chat moves into
   that folder. Drag a chat onto the UNSORTED header: the chat's folder clears.
   Confirm nothing under `~/.claude/projects/` changed by any drop.

## Search and tag chips: flat results, role snippets, tag combine (issue #83)

1. Flat results view. Type a query in the search box that matches some chats. Confirm
   the sectioned tree (Starred, Questions, folders) is replaced by a flat list headed
   `N RESULTS`, where N is the number of matching rows. Clear the box and confirm the
   sectioned tree returns immediately with no flash of stale rows.
2. Title vs body match. Type a word that appears in a chat's TITLE: confirm that row
   shows NO snippet under it. Type a word that appears only in a chat's message BODY
   (not its title): confirm that row shows a matched-context snippet under the title.
3. Role-prefixed snippet. For a body-only match, confirm the snippet begins with
   `You: ` when the matched line was your message, or `Claude: ` when it was the
   assistant's. The snippet must center on the line that actually contains your query
   word (e.g. searching a term that appears only in Claude's reply shows a
   `Claude: ...` snippet of THAT line, not an unrelated `You: ...` line).
4. Role words are not a wildcard (regression). Type `claude` (then also `you`) in a
   workspace where those words do NOT appear in any chat's title or message text.
   Confirm the results list does NOT balloon to every chat: only chats that genuinely
   contain the typed word match. Type a prefix like `cla`, `clau`, `claud` and confirm
   the same (no all-chats false match while typing). A chat that really contains the
   word "you" in a message still matches `you`.
5. Multi-word query. Type two words that appear in the SAME chat (e.g. one in your
   line and one in Claude's). Confirm the chat matches and its snippet is centered on
   the line that contains one of your real query words, regardless of the order you
   typed the two words.
6. Tag chips (AND). Click a tag chip: confirm it toggles active (filled) and the list
   narrows to chats carrying that tag. Select a SECOND chip: confirm the list narrows
   further to chats carrying BOTH tags (AND, not OR). Click a chip again to deselect
   it.
7. Text AND tags combined. With a text query typed AND one or more tag chips active,
   confirm the results are the chats that match the text AND carry every selected tag.
   Removing all chips while keeping the text, or clearing the text while keeping chips,
   each falls back to the single-filter behavior.
8. Sort applies to results. With a filter active, change the sort (Newest, Oldest,
   Name). Confirm the flat results reorder accordingly (the match set is unchanged;
   only the order changes).
9. Archived row persists while filtering. With any chat archived, confirm the bottom
   `Archived (N)` row is present BOTH in the normal sectioned view AND while a text or
   tag filter is active. Clicking it still opens the Archive overlay.
10. Responsiveness and no transcript write. Type quickly and confirm the box stays
    responsive (the query is debounced; the list fills in as results land). Confirm
    nothing under `~/.claude/projects/` changed by any search.

## Rich hover preview card (issue #84)

The card is a floating, body-level overlay the panel builds from the row model
already on the client (title, folder, age, tokens, tags); only the two body snippets
are fetched from the host on demand. The read-only invariant applies: the body is
read on demand for one chat and discarded, and nothing under `~/.claude/projects/`
may change.

1. Hover open. Move the pointer onto a chat row. Confirm a floating ~270px card
   appears near the cursor showing the chat's title; a meta line with the folder
   breadcrumb (or `Unsorted`), the relative age, and a `~NNk tok` token label; the
   chat's tag pills; and a two-line body block with a `YOU` first-message snippet and
   a `CLAUDE` last-message snippet. Move the pointer off the row and confirm the card
   closes on its own.
2. Travel onto the card (130ms leave delay). Hover a row to open the card, then move
   the pointer OFF the row and directly ONTO the card within a moment. Confirm the card
   stays up (it does not vanish mid-travel), and that leaving the card then closes it
   after the short delay.
3. Keyboard open with `p`. Tab into the tree, arrow to a chat row so it holds the
   roving focus, and press `p` (or `P`). Confirm the SAME card opens, anchored to the
   focused row's box rather than the cursor. No pointer hover is required.
4. Escape closes and restores focus. With a `p`-opened card showing, press Escape.
   Confirm the card closes AND keyboard focus returns to the chat row it was opened
   from (not dropped to `<body>`), so arrow navigation continues from that row. A card
   opened by hover closes on Escape without moving focus.
5. Suppressed during drag. Start dragging a chat row. Confirm no hover card appears
   while the drag is in progress, and that hovering works again after the drop.
6. On-demand read, no transcript write. Open a card and confirm the body snippets fill
   in a beat after the card appears. Confirm nothing under `~/.claude/projects/`
   changed mtime or content from opening any number of cards.

## Chat-row right-click context menu (issue #85)

The menu is a body-level transient overlay. Its intents reuse the existing store,
export (the exportIO chokepoint with the projects-path guard), and read-only
archive-body paths, so it adds no new scan or write path. The read-only invariant
applies.

1. Open the menu. Right-click a chat row. Confirm a menu appears listing EVERY project
   tag (not just the visible filter chips), each with a checkmark on the chat's current
   tags, plus a Create new tag entry, Export as Markdown, Export as JSON, and
   (conditionally) Archive chat.
2. Toggle a tag. Click a tag row. Confirm it toggles the tag on the chat (checkmark
   appears or clears) and the chat's tag pills update in the list.
3. Create a new tag. Click Create new tag. Confirm the menu switches to a name input
   plus the 8-swatch color picker with Add/Cancel. Enter a name, pick a swatch, click
   Add, and confirm a new tag of that color is minted and applied to the chat.
4. Export. Click Export as Markdown, then repeat with Export as JSON. Confirm each
   opens the save dialog and writes the file; confirm a save under
   `~/.claude/projects/` is refused by the guard.
5. Archive visibility. On an ordinary (not starred, not archived) chat, confirm the
   Archive chat entry appears and archives the chat. On a STARRED chat, confirm Archive
   chat is replaced by the note that starred chats are kept and never archived. On an
   already-archived chat, confirm no Archive entry shows.
6. Dismissal and keyboard. Confirm Escape and an outside click both dismiss the menu.
   Open it via the keyboard path, confirm Arrow keys rove the entries and Enter/Space
   activate the focused one, and that Escape restores focus to the row.

## Settings overlay and auto-archive engine (issue #86)

Settings render as a full-panel overlay inside the Organize panel; the standalone
Settings editor tab is retired. The keep window and the section toggles persist on
workspaceState (never on the synced ProjectMeta). The auto-archive decision is a pure
module reusing the existing store and archive-body paths, so it adds no new fs write
path. The read-only invariant applies.

1. Open the overlay. Click the gear. Confirm a full-panel Settings overlay opens with
   a back chevron, a Newsreader-serif heading, a "Keep chats for" window select (7 /
   14 / 30 / 90 days, 1 year, or Never), and four section-visibility pill switches
   (Starred, Questions, Folders, Unsorted). Confirm the back chevron returns to the
   list.
2. Window default. On a fresh workspace confirm the window select defaults to the
   effective Claude `cleanupPeriodDays` (30 when unset). Change it and reopen the
   overlay to confirm the choice persisted.
3. Section toggles. Turn a section pill off and confirm that section stops rendering in
   the list; turn it back on and confirm it returns. Turn Unsorted OFF and confirm an
   unfiled chat is STILL reachable via search and the tag chips (disabling Unsorted must
   never strand a chat; the Unsorted section still renders when every other section that
   could hold it is hidden).
4. Editor tab retired. Run "Claude Code Nest: Settings" from the Command Palette and
   confirm it reveals the Organize panel and opens THIS overlay, not a separate editor
   tab. Confirm no standalone Settings WebviewPanel opens anywhere.
5. Auto-archive (unstarred). With unstarred chats older than the chosen window, reload
   the window (or trigger a scan refresh) and confirm those chats become archived (they
   leave the visible sections, the `Archived (N)` count rises, and a Nest-owned body
   copy exists). Confirm a first-run notice appears once.
6. Starred exemption and protective copy. Confirm a STARRED chat past the window is NOT
   archived. Confirm that choosing "Never" for the keep window still leaves a protective
   body copy for a starred chat past the effective Claude cleanup age, so the starred
   chat survives Claude's own transcript cleanup.
7. Read-only. Confirm nothing under `~/.claude/projects/` changed from any of the above:
   every body copy lands in the extension's own storage.

## Archive overlay (issue #87)

The `Archived (N)` bottom row opens a full-panel Archive overlay (reusing the Settings
overlay chrome). The Archive TREE is retired, so this is the change that leaves exactly
ONE contributed view. The read-only invariant applies.

1. Open the overlay. Click the bottom `Archived (N)` row. Confirm a full-panel Archive
   overlay opens (back chevron, Newsreader heading) listing the archived chats, each
   with a title over a folder-and-age meta line, an export button, a Restore button, and
   a star.
2. Gray focus glow. Focus the overlay's "Search archived" box and confirm its focus glow
   is deliberately GRAY (distinct from the main orange search glow). Type a query and
   confirm it filters the archived rows by title client-side.
3. Restore. Click Restore on a row. Confirm the chat leaves the archive, returns to its
   section in the list, and the `Archived (N)` count drops. Confirm a star click on an
   archived row un-archives it too (star-and-restore) while keeping the star.
4. Copy-only survivor. For a chat whose transcript Claude already cleaned up, confirm it
   still lists (title from the Nest-owned body copy, shown as "copy only") and its row
   previews the saved copy.
5. Empty state. With no archived chats, confirm the overlay shows its empty state.
6. One view only. Open the Views/Command Palette and confirm there is no separate Archive
   tree view anymore: the Organize panel is the only Claude Code Nest view.
7. Dismissal. Confirm Escape closes the overlay and restores focus to the `Archived (N)`
   row.

## Palette commands and library export/import

These commands have no dedicated view; they run from the Command Palette under the
"Claude Code Nest" category (Refresh is also a view-title button).

1. Refresh. Run "Claude Code Nest: Refresh". Confirm it re-scans the transcripts under a
   cancellable progress indicator and the Organize panel re-renders.
2. Link / Unlink. Run "Link to Chat..." with nothing selected. Confirm it quick-picks the
   source chat before offering the target. Run "Unlink" the same way and confirm it
   quick-picks a linked child to unlink from its parent. (The link nesting has no panel
   surface yet; these are palette-only.)
3. Export / import library. Run "Export Library to JSON..." and confirm it writes a
   human-readable JSON of every project through the save dialog. Run "Import Library from
   JSON..." and confirm it merges additively (it never deletes a project absent from the
   file). Confirm a save under `~/.claude/projects/` is refused by the guard.
4. Token rollup. Run "Show Token Cost Rollup" and confirm it opens the by-folder and
   by-tag token report (tokens only, never dollars).
5. Walkthrough. Run "Get Started with Claude Code Nest" and confirm the three-step
   walkthrough (the panel, folders and tags, backup) opens and its buttons run.

## Visual fidelity (issues #79 and #88)

This is a build-and-review aid, run from the repo rather than the installed extension,
but the human gate should spot-check it against the prototype.

1. From the repo root, run `npm run fidelity`. Confirm it writes the harness and
   prototype screenshot sets under `.claude-working/fidelity/` (gitignored) at the 320px
   reference width, and that it FAILS LOUDLY when no headless Chrome or Edge is installed
   rather than passing silently.
2. Open the harness captures beside `media/design/ChatSidebar.html`. Eye-compare every
   captured state (default, filtered results, hover card, context menu in both modes, drag
   highlight, both overlays, both popovers, inline rename) and confirm no visible mismatch
   against the handoff tokens and metrics, except the agreed deviations recorded in
   UI-SPEC.md (which reviews do not flag).
3. Confirm the committed reference set under `media/design/reference/` exists and the
   harness, scripts, and reference images are excluded from the packaged extension (they
   do not appear in `vsce ls`).

## Accessibility: full keyboard and screen-reader pass (issue #89)

The Organize panel is Nest's ONLY surface, so its own keyboard and ARIA tree is the whole
accessibility story (UI-SPEC.md deviation 5). Run this pass last, with folders, tags, and
several chats present, and ideally with a screen reader active (NVDA or Narrator on
Windows, VoiceOver on macOS).

1. Reach everything with the keyboard. With the pointer untouched, Tab from the top of
   the panel. Confirm every interactive element is reachable in a sensible order: New
   session pill, gear, sort button, search box, search clear (when a query is present),
   each tag chip, the tree, and the bottom `Archived (N)` row. Confirm nothing interactive
   is skipped and no keyboard trap holds you on one control.
2. Tree navigation (roving tabindex). Tab into the list. Confirm exactly ONE row is in the
   tab order at a time (the roving tabindex), and that Up/Down move between rows, Home/End
   jump to the first/last row, ArrowRight/ArrowLeft expand/collapse a focused folder (or
   move to its first child / parent), and Enter/Space activate a row (open a chat, or begin
   rename on a folder). Confirm a visible focus ring is present on the focused row
   throughout.
3. Sort popover as a menu. Open the sort popover from the keyboard (focus the sort button,
   press Enter/Space). Confirm it is announced as a menu, that focus moves into it, Arrow
   keys move between the three radio items, Enter/Space selects, and Escape closes it and
   returns focus to the sort button. Confirm the button's `aria-expanded` reflects the open
   state.
4. Context menu and pickers. Open the chat context menu, the folder color picker, and the
   tag-create swatch picker from the keyboard. Confirm each is announced as a menu with the
   right item roles (menuitem / menuitemcheckbox / menuitemradio), that Arrow keys rove the
   items, Enter/Space activate, and Escape closes and restores focus to the trigger.
5. Modal dialogs trap focus. Open, in turn, the Settings overlay (the gear), the Archive
   overlay (the `Archived (N)` row), and the New-folder popover (the `+` in the FOLDERS
   header). For EACH, confirm a screen reader announces a dialog (role="dialog", aria-modal),
   that initial focus lands inside it (the back chevron for the overlays, the name input for
   the New-folder popover), and that Tab and Shift+Tab CYCLE WITHIN the dialog only. You must
   NOT be able to Tab out of an open dialog into the tree behind it. Confirm Escape (and the
   back chevron or Cancel) closes the dialog and returns focus to the control that opened it
   (the gear, the `Archived (N)` row, or the `+` button).
6. Labels and roles. With a screen reader, move through the panel and confirm each control
   announces a meaningful name: the New session, gear, sort, and search-clear buttons; the
   star toggle (announced as pressed/not pressed for starred/unstarred); the tag chips
   (name and count); folder headers (name, level, expanded/collapsed); and chat rows (the
   row's title plus its status, since the visual status glyph is aria-hidden and its meaning
   rides the row's accessible name). Confirm the sections are announced as groups with their
   headings.
7. Prefers-reduced-motion. Turn on the OS "reduce motion" setting and reload the panel.
   Confirm the question `?` badge is static (not blinking), and that the Settings section
   switches toggle WITHOUT the thumb sliding and the search-box focus glow appears WITHOUT
   an eased transition (no motion plays anywhere for a reduced-motion user). Turn the setting
   off and confirm the motion returns.
8. Confirm nothing under `~/.claude/projects/` changed during the whole pass.

## The human verify gate (#76)

Part 3 is now complete on main, so this whole checklist is the HUMAN VERIFY GATE. Install
the current `nest-build-check.vsix` (or a fresh package), run every section above next to
the open prototype `media/design/ChatSidebar.html`, and comment the pass (or any findings)
on issue #76. Findings become ordinary fix issues/PRs and the gate repeats. THE v0.2.0
RELEASE RUN (#91) MUST NOT BE INVOKED WITHOUT THE RECORDED PASS.

## Integration tests (deferred)

The electron-host integration tests (`npm run test:integration`) need a VSCode download and
a display, so they are not part of the unattended gate. Run them locally or in CI when
validating activation and view registration.

How to run: `npm run test:integration`. The script runs
`node ./out/test/integration/runTest.js`, which downloads a VSCode build (cached under
`.vscode-test/` after the first run) and launches an Extension Development Host. The launcher
points the host at a mocha runner that globs only `out/test/integration/**/*.test.js` (never
the headless `out/test/unit/**`, so an integration spec can never be pulled into `npm test`).
A network-restricted or headless-display machine cannot download/launch VSCode; that is the
deferral, not a missing artifact.

The DnD-contract integration test (`src/test/integration/dndContract.test.ts`, run only by
the command above) asserts the drag-and-drop MIME contract and a real cross-tree drag store
mutation through real `vscode.DataTransfer` objects. It predates the tree retirement and is
kept as the host-level record of the DnD payload contract that the in-panel webview drag now
rides in-process; the headless `dropReducer` / `webviewDropAdapter` unit tests cover the
current panel drag path.

The activation integration test (`src/test/integration/activation.test.ts`, run only by the
command above) asserts:

- The extension is present as a loaded extension in the host
  (`vscode.extensions.getExtension('jakemismas.claude-code-nest')`), proving the host loaded
  this manifest.
- The contributed `claudeNest` view set is exactly the Organize webview as the SOLE
  contributed view (the trees were all retired), read from the SAME `package.json` the host
  loaded as the Extension Manifest.
- No `viewsWelcome` ships now that every tree view is retired: the array is empty, so no
  welcome targets a retired view id.
- The raster gallery icon (`media/icon.png`) and the getting-started walkthrough (with
  multiple steps) are contributed and the icon file exists.
- `getChildren(undefined)` returns `[]` and never throws for the kept non-view folders/tags
  services when no project resolves, and `primeSnapshot` (the progress-scan entry point) also
  does not throw on an absent project.
