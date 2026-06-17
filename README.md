# Claude Code Nest

A VSCode extension that adds a virtual organization layer over Claude Code chat
sessions for a single project, so that 50+ chats stop overflowing the editor tab
bar.

## What it does

Claude Code Nest contributes its own Activity Bar panel with:

- A Folders view: a single-home, nestable hierarchy for chats.
- A Tags view: many-to-many labels plus an automatic Untagged bucket.
- Organize by drag-and-drop or a multi-select tag picker: drag one or more chats
  onto a folder to set their home or onto a tag to apply it (within a view or
  across the Folders and Tags views), or right-click and "Tag Chats..." for a
  checkbox picker that applies to the whole selection.
- Links between chats, rendered as branch-nested children.
- Read-only, auto-computed Smart Groups the user can promote to real folders or tags.
- A Settings webview to read and edit Claude's global cleanupPeriodDays.
- Export the whole library to a JSON backup and import it back with an additive,
  per-project merge that never deletes a project missing from the file. An
  additive cross-machine reconcile (union tags and links, last-writer-wins per
  folder by edit time) runs on activation and on window focus, with an honest
  warning when two machines set a conflicting folder, plus an opt-in auto-export
  snapshot with retention.

Your organization (folders, tags, links) is stored per project in VSCode's
globalState and registered for Settings Sync one key per project, so it follows
you across machines on a best-effort, last-writer-wins basis. The export JSON is
the authoritative backup. If a chat's transcript disappears, its organization is
soft-marked and archived only after a grace window, never hard-deleted, and a
suspect scan (zero or far fewer chats than last seen) is skipped rather than
mass-archiving.

Clicking a chat opens or resumes it through Claude's documented URI handler.

## The hard constraint

The extension is strictly read-only on Claude's transcript files under
~/.claude/projects/. It never writes, renames, moves, or deletes anything there,
never patches or depends on the Claude Code extension, and its only contact with
Claude is firing the public URI handler. If the extension fails, Claude is
entirely unaffected. The single permitted write to ~/.claude is the surgical,
single-key edit of settings.json (cleanupPeriodDays) through a read-only
chokepoint with an mtime guard.

## Status

Built in ten dependency-ordered vertical slices. See PLAN.md for the slice cut,
ARCHITECTURE.md for the binding design rules and sync architecture, CHANGELOG.md
for the per-slice record, and DECISIONS.md for autonomous design decisions made
during the build. TESTING.md (written at handoff) carries the install steps and
the manual smoke checklist.

## Install

See TESTING.md for how to install the packaged VSIX into a clean VSCode.
