# Claude Code Nest

A read-only organizer for your Claude Code chat history, right in the VS Code sidebar.

Claude Code Nest adds its own Activity Bar panel that turns a sprawling pile of
Claude Code sessions into folders, tags, links, stars, and an archive, so you can
find and revisit any chat without it ever touching Claude's transcripts.

## Features

- **Organize panel.** The primary view, with a Starred section, a Questions
  section (chats whose last turn was yours, a scan-time heuristic labeled as such),
  a single-home folder hierarchy with per-folder color and counts, and an
  always-present Unsorted bucket. Tag filter chips, sort, density modes, folder
  rename, drag-to-unfile, and in-panel drag-and-drop.
- **Full-text content search.** Search across chat content from the Organize
  panel and see a matched-context snippet under each result. Clearing the query
  restores the full list.
- **Rich hover previews.** Hover any chat row for a preview card with its folder,
  age, token total, full tag set, models, files-touched count, and first and last
  message snippets. Every row also shows a token badge beside its relative time.
- **Star and archive.** Star a chat to flag it, or archive one to move it into a
  dedicated Archive view. Archiving keeps a Nest-owned copy of the chat body in
  the extension's own storage, so the chat survives Claude Code's own cleanup of
  the transcript folder. Restore returns it and clears the copy.
- **Per-chat export.** Export one chat to Markdown (a YAML front-matter org layer
  plus the readable transcript) or JSON (a versioned, round-trippable document).
- **Token cost rollups.** Sum each chat's token usage by folder and by tag in a
  read-only report. Tokens only, never dollars.
- **Read-only smart groups.** Auto-computed buckets (pull request, ticket prefix,
  git branch, fork lineage) you can promote to real folders or tags when useful.
- **Settings panel.** Read and edit Claude Code's global `cleanupPeriodDays`
  through a single guarded write.
- **Flat Chats fallback.** A flat, newest-first list of every session, kept as an
  accessible tree alongside the Organize panel.

Clicking a chat opens or resumes it through Claude Code's public URI handler. Your
organization is stored per project and follows you across machines on a
best-effort, last-writer-wins basis, with a JSON export as the authoritative backup.

## Requirements

- VS Code `^1.66.0`
- Claude Code installed, with sessions under `~/.claude/projects/`

## Install

Install the packaged VSIX:

- From a terminal: `code --install-extension claude-code-nest-0.1.0.vsix`
- Or in VS Code: open the Extensions view, use the `...` menu, choose **Install
  from VSIX...**, and select `claude-code-nest-0.1.0.vsix`

Reload the window when prompted, then open a folder that has Claude Code sessions
so the extension has chats to list.

## Getting started

1. Click the Claude Code Nest icon in the Activity Bar to open the panel.
2. In the **Organize** view, create a folder or a tag, then drag chats onto it. A
   chat has one folder home and any number of tags.
3. Star the chats you want to keep handy, and archive the ones you want out of the
   way but still readable.
4. Use the search box to find a chat by its content.
5. Run the **Get Started with Claude Code Nest** walkthrough from the Command
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

All commands live under the **Claude Code Nest** category in the Command Palette.
The most common ones are also surfaced as view-title buttons or row actions:

- **Refresh** re-scans the transcripts under a cancellable progress indicator.
- **Preview Full Chat** and **Preview Archived Copy** open a chat as read-only text.
- **New Folder**, **New Tag**, **Tag Chats...**, and **Link to Chat...** organize chats.
- **Star Chat**, **Archive Chat**, and **Restore Chat** curate them.
- **Export Chat...**, **Export Library to JSON...**, and **Import Library from JSON...**
  move your data in and out.
- **Show Token Cost Rollup** opens the by-folder and by-tag token report.
- **Claude Code Nest Settings** opens the `cleanupPeriodDays` panel.

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
