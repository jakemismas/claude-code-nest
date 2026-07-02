# Claude Code Nest

A read-only organizer for your Claude Code chat history, right in the VS Code sidebar.

Claude Code Nest adds its own Activity Bar panel that turns a sprawling pile of
Claude Code sessions into folders, tags, links, stars, and an archive, so you can
find and revisit any chat without it ever touching Claude's transcripts.

## Features

- **Organize panel.** The primary view, with a Starred section, a Questions
  section (chats whose last turn was yours, a scan-time heuristic labeled as such),
  a single-home folder hierarchy with per-folder color and counts, and an
  always-present Unsorted bucket. Folders are collapsible (with a collapse-one-level
  control and full keyboard navigation). Tag filter chips, sort, density modes,
  folder rename, drag-to-unfile, and in-panel drag-and-drop.
- **Full-text content search.** Search across chat content from the Organize
  panel and see a matched-context snippet under each result. Clearing the query
  restores the full list.
- **Token badges.** Every chat row shows a token badge beside its relative time.
  (The rich hover preview card, with a chat's folder, age, token total, full tag
  set, models, files-touched count, and first and last message snippets, returns
  as an in-panel card later in Sprint 3.)
- **Star and archive.** Starred chats surface in the Starred section; archived
  chats move into a dedicated Archive view. Archiving keeps a Nest-owned copy of
  the chat body in the extension's own storage, so the chat survives Claude
  Code's own cleanup of the transcript folder. Restore returns it and clears the
  copy. (In-panel star and archive controls for live chats land with the panel's
  row actions and context menu later in Sprint 3.)
- **Per-chat export.** One chat to Markdown (a YAML front-matter org layer plus
  the readable transcript) or JSON (a versioned, round-trippable document). (The
  Export Chat... action lands back on chat rows with the panel's context menu
  later in Sprint 3; whole-library export and import work today.)
- **Token cost rollups.** Sum each chat's token usage by folder and by tag in a
  read-only report. Tokens only, never dollars.
- **Settings panel.** Read and edit Claude Code's global `cleanupPeriodDays`
  through a single guarded write.
- **One panel.** The Organize panel is the single browsing surface, with full
  keyboard navigation and ARIA tree semantics built in. Only the Archive view
  rides alongside it, until its in-panel replacement ships.

Clicking a chat opens or resumes it through Claude Code's public URI handler. Your
organization is stored per project and follows you across machines on a
best-effort, last-writer-wins basis, with a JSON export as the authoritative backup.

## Requirements

- VS Code `^1.66.0`
- Claude Code installed, with sessions under `~/.claude/projects/`

## Install

Install the packaged VSIX:

- From a terminal: `code --install-extension claude-code-nest-0.1.1.vsix`
- Or in VS Code: open the Extensions view, use the `...` menu, choose **Install
  from VSIX...**, and select `claude-code-nest-0.1.0.vsix`

Reload the window when prompted, then open a folder that has Claude Code sessions
so the extension has chats to list.

## Getting started

1. Click the Claude Code Nest icon in the Activity Bar to open the panel.
2. In the **Organize** view, create a folder or a tag, then drag chats onto it. A
   chat has one folder home and any number of tags.
3. Use the search box to find a chat by its content.
4. Run the **Get Started with Claude Code Nest** walkthrough from the Command
   Palette for a guided tour.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeNest.archiveKeepWindowDays` | `30` | How long Nest keeps its own copy of an archived chat body before pruning it (`7`, `30`, `90`, or `0` for never). Starred archived chats are always kept. The copy is local and is never synced. |

A separate Settings panel (the gear icon on any Nest view) reads and edits Claude
Code's global `cleanupPeriodDays` in `~/.claude/settings.json`. This is a global
Claude Code setting, not a Nest setting, so the panel warns you that it affects
every workspace.

## Commands

Commands live under the **Claude Code Nest** category in the Command Palette, as
view-title buttons, or as row actions in the Archive view:

- **Refresh** re-scans the transcripts under a cancellable progress indicator.
- **Preview Archived Copy** opens an archived chat's saved body as read-only text.
- **New Folder**, **New Tag**, **Link to Chat...**, and **Unlink** organize chats
  (the link commands quick-pick their chats when run from the palette).
- **Star Chat** and **Restore Chat** curate archived rows from the Archive view.
- **Export Library to JSON...** and **Import Library from JSON...** move your
  library in and out.
- **Show Token Cost Rollup** opens the by-folder and by-tag token report.
- **Settings** (shown as "Claude Code Nest: Settings") opens the `cleanupPeriodDays` panel.

## Data and privacy

Privacy is the point of this extension, not a footnote.

- **Strictly read-only over your transcripts.** Nest never writes, renames, moves,
  or deletes anything under `~/.claude/projects/`. It reads the JSONL transcripts
  and nothing more. If Nest fails, Claude Code is entirely unaffected.
- **One sanctioned write, behind a guard.** The only write anywhere under
  `~/.claude` is the surgical, single-key edit of `cleanupPeriodDays` in
  `settings.json`, routed through a guarded chokepoint that refuses any target
  except that one file. Every other file Nest writes (the archive copies, exports,
  and the search index) lives in the extension's own storage, never under
  `~/.claude/projects/`.
- **No telemetry, no network.** Nest sends no telemetry and makes no network calls.
  Your chat content stays on your machine. Full message bodies are read on demand
  for one chat at a time and discarded; only bounded per-chat summaries are kept.
- **The search index never syncs.** It lives in the extension's local storage,
  is never registered for Settings Sync, and is never written under
  `~/.claude/projects/`.

## More

- [TESTING.md](./TESTING.md): install steps and the manual smoke checklist.
- [CHANGELOG.md](./CHANGELOG.md): the per-release and per-slice record.

Licensed under MIT.
