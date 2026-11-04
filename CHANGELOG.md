# Changelog

All notable changes to Claude Code Nest are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Fleet view. If you run several Claude Code sessions at once, the panel shows them as a
  live fleet: a pinned orchestrator, past orchestrators, ticket or folder groups with
  status dots, stage pills and agent tags.
- Fleet records. Nest reads `dev/fleet.jsonl` in each workspace folder, read-only, and
  refreshes the panel when it changes. `docs/fleet-record.md` is the contract an
  orchestrator writes against.
- Live status for each chat (working, needs you, queued, done or idle) from running
  sessions (`claude agents --json`), fleet records and an optional queue file. A group
  shows its most urgent dot.
- Grouping by ticket, folder or date, with an automatic mode that picks the best fit.
  A chat you filed by hand stays where you put it, and so does a chat you moved back
  to Unsorted.
- Layout file `.nest/config.json` (JSON with comments, read-only) for grouping, tag
  colors, linked folders, extra fleet files, a queue table and done stages, with a JSON
  schema, hot reload and an Open Layout File command.
- Active filter for working and waiting chats, and a read-only Queue list that follows
  the queue table and marks tickets with a live chat.
- Open in terminal for a running background session, which runs `claude attach` in a
  new terminal. Every other chat opens through Claude Code as before.
- Organize rules in the layout file file existing chats into folders and tags. Preview
  lists every move and writes nothing, Apply never moves a chat you filed by hand, and
  Undo restores the state before the last Apply.
- Settings gains Group chats by, Layout file, Organize and Robin animations.
- The header robin reacts to the fleet: it taps along while chats work (faster with
  more of them) and sings a pixel note for each, hops when one needs you, jumps and
  sings when work finishes, squawks on a failure, catches a worm for a new chat, flies
  when the orchestrator rotates and sleeps when nothing runs. It is drawn in square
  pixels with light and dark palettes, keeps its feet on the branch unless it hops,
  jumps or flies, pauses while the panel is hidden, and stays still with
  `claudeNest.robin.animations` off or with the editor's reduced motion preference.
- A robin style sheet, `docs/mascot.md`, shows every state animated, the still poses,
  the icons and both palettes.

### Changed

- The listing icon and the Activity Bar icon show the robin.

### Security

- The live session lookup runs one fixed command with no shell, from the home
  directory, with a hard kill and an output cap. A watchdog keeps a hung command from
  stalling status updates.
- Organize rule patterns are checked for worst-case cost, and a pattern that could run
  slowly turns off only its own rule.

### Development

- The screenshot harness takes `--theme light|dark` and `--out <dir>`.
- Integration tests run from deep checkout paths.
- `node scripts/readme/robin.js` redraws the README robin and the robin style sheet from
  the panel's art, and a unit test fails when they are out of date.

## [0.2.0] - 2026-07-10

Nest is now a single sidebar panel.

### Added

- One panel for everything: sections, full-text search with tag chips, a chat context menu, Settings and Archive all open inside the Claude Code Nest panel.
- Starred chats section, with a star toggle on every row.
- Unread and question markers: a solid dot for an unread assistant reply, and a blinking question mark when the reply asks you something. Markers clear when you open the chat in Claude Code.
- Full-text search across chat messages, with matching snippets in the results.
- Per-chat export to Markdown or JSON, and a token usage rollup.
- Archive overlay with restore, plus a Nest-owned copy of archived chats so they survive Claude Code's own cleanup. A setting controls how long copies are kept.
- Optional auto-archive of idle chats, configured in the in-panel Settings.
- New session button that starts a fresh Claude Code chat.
- Folder colors, collapsible folders with keyboard navigation, and a sort popover (newest, oldest, name).
- Tag colors, shown on each chat row.
- Screenshot harness (`npm run fidelity`) for reviewing the panel with made-up data.

### Changed

- The sidebar view is now titled "Claude Code Nest".
- The panel follows the active VS Code theme in light and dark.
- The flat chat list, the smart groups list and the Settings tab are removed in favor of the panel.
- Row density is removed. Tag pills and the last-message snippet are always shown.

### Fixed

- Existing chats no longer all show the unread dot after install.
- Search icons are centered in their inputs, and the Unsorted heading no longer crowds the Folders heading.

### Security

- A sync reconcile step now prevents a lossy write from another machine from silently dropping local folders and tags.
- Input from the webview is length-capped and validated before it is stored.
- Imported backup files are bounds-checked.
- The bundled Newsreader font ships with its license text, and third-party notices are listed in `THIRD-PARTY-NOTICES.md`.

## [0.1.0] - 2026-06-28

First public release.

### Added

- Folders with a single home per chat, and tags with many per chat.
- Links between related chats.
- Drag and drop to file chats into folders and tags.
- Read-only discovery of chats from `~/.claude/projects`, with titles, timestamps, branch and pull request details.
- Open or resume a chat in Claude Code from Nest.
- JSON export and import of your library, with an optional automatic snapshot.
- Sync of folders and tags across machines through VS Code Settings Sync, with a merge step for edits made on two machines.
- Getting started walkthrough.

### Changed

- Collapsible folders in the panel.
- Command palette titles are shorter.

### Fixed

- Folder headers show the same keyboard focus ring as chat rows.

### Security

- Nest never writes under `~/.claude/projects`. Lint rules and a runtime guard enforce this.
- The webview runs with a strict Content Security Policy.
