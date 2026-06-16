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

## Integration tests (deferred)

The electron-host integration tests (`npm run test:integration`) need a VSCode
download and a display, so they are not part of the unattended gate. Run them
locally or in CI when validating activation and view registration.
