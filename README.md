# Claude Code Nest

A VSCode extension that adds a virtual organization layer over Claude Code chat
sessions for a single project, so that 50+ chats stop overflowing the editor tab
bar.

## What it does

Claude Code Nest contributes its own Activity Bar panel with:

- A Folders view: a single-home, nestable hierarchy for chats.
- A Tags view: many-to-many labels plus an automatic Untagged bucket.
- Links between chats, rendered as branch-nested children.
- Read-only, auto-computed Smart Groups the user can promote to real folders or tags.
- A Settings webview to read and edit Claude's global cleanupPeriodDays.

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
