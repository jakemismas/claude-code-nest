# Claude Code Nest

A VSCode extension that adds a virtual organization layer over Claude Code chat
sessions for a single project, so that 50+ chats stop overflowing the editor tab
bar.

## What it does

Claude Code Nest contributes its own Activity Bar panel with:

- An Organize panel: the primary view, with a Starred section, a Questions section
  (chats awaiting your reply, a scan-time heuristic labelled as such), the
  single-home folder hierarchy with per-folder color and counts, and an always-present
  Unsorted bucket. Tag filter chips, sort (newest/oldest/name), density modes, a
  full-text content search, double-click or Enter folder rename, a right-click folder
  actions menu (rename, color, delete), and in-panel drag-and-drop.
- A Chats view: a flat, newest-first list of every session, kept as the accessible
  tree fallback.
- Organize by drag-and-drop or a multi-select tag picker: in the Organize panel,
  drag one or more chats onto a folder to set their home, onto the Unsorted section to
  unfile, or onto a tag chip to apply it; or right-click a Chats row and "Tag Chats..."
  for a checkbox picker that applies to the whole selection (and toggles tags off too).
- Links between chats (created from a Chats row with "Link to Chat...").
- Read-only, auto-computed Smart Groups the user can promote to real folders or tags.
- A Settings webview to read and edit Claude's global cleanupPeriodDays.
- Export a single chat to Markdown or JSON (the "Export Chat..." row action), or
  export the whole library to a JSON backup and import it back with an additive,
  per-project merge that never deletes a project missing from the file. An
  additive cross-machine reconcile (union tags and links, last-writer-wins per
  curation scalar by edit time) runs on activation and on window focus, with an
  honest warning when two machines set a conflicting folder, plus an opt-in
  auto-export snapshot with retention. The reconciled per-scalar fields are a
  chat's folder, star, and archive state and a folder's color.
- A "Show Token Cost Rollup" view action that sums each chat's token usage by
  folder and by tag in a read-only report.

Your organization (folders, tags, links) is stored per project in VSCode's
globalState and registered for Settings Sync one key per project, so it follows
you across machines on a best-effort, last-writer-wins basis. The export JSON is
the authoritative backup. If a chat's transcript disappears, its organization is
soft-marked and archived only after a grace window, never hard-deleted, and a
suspect scan (zero or far fewer chats than last seen) is skipped rather than
mass-archiving.

Clicking a chat opens or resumes it through Claude's documented URI handler. A
Refresh in any view re-scans the transcripts under a cancellable progress
indicator, and a built-in "Get Started with Claude Code Nest" walkthrough covers
the panel, organizing, smart groups, and backup. The extension is telemetry-free.

Each scanned chat also carries a bounded, read-only tier-A summary computed once
during the scan (message count, last-turn snippet and role, summed token usage,
the distinct files referenced, and the models used). Full message bodies are never
held in memory beyond reading one chat on demand.

Every chat row shows a `~`token badge beside its relative time, and hovering a row
opens a rich preview card: the chat's folder, age, `~`token total, full tag set, and
both a first and a last message snippet, with the models and files-touched count as
extra context. The same summary appears on the Organize panel rows. A "Preview
Full Chat" command opens one chat's full text in a read-only editor. The card is a
preview built from the tier-A summary, never a transcript renderer; the on-demand
body reader reads one chat's bodies only when needed and discards them.

The Organize panel search box has a "Search content" mode that ranks chats by
full-text relevance (powered by a vendored copy of MiniSearch, MIT) and shows a
matched-context snippet under each result. The search index lives in the
extension's own globalStorage, is never synced and never written under
~/.claude/projects/, and indexes chat bodies only in memory (read on demand and
discarded); only tier-A fields are ever persisted.

Export a single chat from any chat row with "Export Chat...": pick Markdown (a YAML
front-matter org layer plus the readable transcript) or JSON (a versioned,
round-trippable document). The chat's body is read once on demand and discarded after
rendering, and the file is written only through the same read-only chokepoint as the
backup and search code, which refuses any target under ~/.claude/projects/, so an
export can never overwrite a transcript. "Show Token Cost Rollup", a view action,
sums each chat's token usage by folder (each chat counted once, a true partition) and
by tag (each chat counted once per tag, so the by-tag totals can exceed the library
total when chats are multi-tagged, by design) into a read-only report. Both surfaces
report tokens only, never dollars.

Star a chat to flag it (and exempt its archived copy from pruning), or archive a
chat from any chat view to move it into a dedicated Archive view. Archiving keeps a
Nest-owned copy of the chat's body in the extension's own globalStorage so the chat
survives Claude Code's cleanup of ~/.claude/projects; that copy is local and is
never synced, and it is written only through the same read-only chokepoint as the
export and search code, so nothing under ~/.claude/projects is ever touched. The
`Claude Code Nest > Archive Keep Window Days` setting (7, 30, 90, or 0 for never;
default 30) controls how long a copy is kept; starred chats are always kept. Restore
from the Archive view to clear the flag (your star survives) and remove the copy.



## The hard constraint

The extension is strictly read-only on Claude's transcript files under
~/.claude/projects/. It never writes, renames, moves, or deletes anything there,
never patches or depends on the Claude Code extension, and its only contact with
Claude is firing the public URI handler. If the extension fails, Claude is
entirely unaffected. The single permitted write to ~/.claude is the surgical,
single-key edit of settings.json (cleanupPeriodDays) through a read-only
chokepoint with an mtime guard.

## Status

All ten dependency-ordered vertical slices are complete and packaged as
`claude-code-nest-0.0.1.vsix`. See PLAN.md for the slice cut, ARCHITECTURE.md for
the binding design rules and sync architecture, CHANGELOG.md for the per-slice
record, and DECISIONS.md for autonomous design decisions made during the build.
TESTING.md carries the install steps and the consolidated manual smoke checklist.

## Install

Install the packaged VSIX into VSCode:

- From a terminal: `code --install-extension claude-code-nest-0.0.1.vsix`.
- Or in VSCode: open the Extensions view, use the `...` menu, choose "Install
  from VSIX...", and select `claude-code-nest-0.0.1.vsix`.

See TESTING.md for the full install steps and the manual smoke checklist to run
on the live extension.
