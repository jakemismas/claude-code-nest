# Architecture

This guide is for people who want to change Claude Code Nest. It explains what
the extension does, where the code lives, how data moves, and the rules that
every change must keep.

## What Nest is

Nest is a VS Code extension that adds an organization layer on top of your
Claude Code chat history. It contributes one Activity Bar view, a webview panel,
where you group chats into folders, tag them, star them, search them, archive
them, and export them. Nest never edits your chats. It reads the transcript files
Claude Code leaves on disk and keeps its own metadata separately.

## Module map

`src/extension.ts` is the only entry point. It wires pure, VS Code-free logic
modules to thin VS Code-bound surfaces. Unit tests import only the VS Code-free
modules.

| Path | Role |
| --- | --- |
| `src/extension.ts` | Activation, dependency wiring, command registration, reconcile triggers. |
| `src/claude/jsonlReader.ts` | The only transcript parser. Reads titles, PR links, timestamps and branch from JSONL lines. |
| `src/claude/chatScanner.ts` | The only code that lists transcript files. Scans `*.jsonl` read-only. |
| `src/claude/bodyReader.ts` | Reads one chat's messages on demand and discards them. |
| `src/claude/projectKeyResolver.ts` | Maps a workspace folder to the project directory name Claude Code uses. |
| `src/model/` | Pure data types and helpers: id minting (`idFactory`), `folderTree`, `occurrence`, `untagged`, `links`, `questionHeuristic`, `types`. |
| `src/store/metadataStore.ts` | Synced per-project metadata document and the per-device local document. |
| `src/store/schema.ts`, `schemaMigrate.ts` | Document shape, migration, and the per-field last-writer-wins merge. |
| `src/store/reconcile.ts`, `reconcileSync.ts` | Re-attach orphaned records, and merge changes written by another machine. |
| `src/store/exportImport.ts`, `autoExport.ts` | Build, validate and merge the JSON backup, plus the optional automatic snapshot. |
| `src/store/exportIO.ts` | Write chokepoint for Nest's own files (global storage and user-chosen export paths). |
| `src/store/exportPathGuard.ts` | Refuses any target under `~/.claude/projects`. |
| `src/store/archiveBodyStore.ts`, `archiveRetention.ts` | Nest's own copy of archived chat bodies, and how long to keep them. |
| `src/store/autoArchiveEngine.ts`, `autoArchivePolicy.ts` | Optional archive of chats that have been idle past a window. |
| `src/store/deviceId.ts` | Stable per-install id used to stamp edits. |
| `src/settings/claudeSettingsIO.ts` | Write chokepoint for Claude Code's `settings.json` (the retention setting only). |
| `src/search/` | Full-text index (`searchIndex`), its persistence (`searchStore`), and the vendored MiniSearch build. |
| `src/smart/` | Signal extraction (PR, ticket, branch, fork lineage) used to suggest groups. |
| `src/export/chatExport.ts` | Renders one chat as Markdown or JSON. |
| `src/rollup/` | Token usage totals and the report built from them. |
| `src/launch/` | Opens or starts a chat in Claude Code through its URI handler and commands. |
| `src/dnd/` | Drag-and-drop interpretation (`dropReducer`) and the adapter for webview drops. |
| `src/commands/` | Thin command handlers (folders, tags, links, curation, export, import, preview, refresh). |
| `src/views/orgPanelWebview.ts` | The webview host: builds the HTML shell, handles messages, pushes data. |
| `src/views/orgPanelModel.ts` | Pure functions that turn records and metadata into the rows the panel draws. |
| `src/views/` (other files) | Panel helpers (`readState`, `chatMeta`, `chatTooltip`, `relativeTime`, `tabFocusMatch`) and service providers for folders and tags. |
| `src/ui/tagQuickPick.ts` | The tag picker shown from commands. |
| `media/orgPanel.js`, `media/orgPanel.css` | The webview UI. Plain JavaScript, no framework. |
| `scripts/fidelity/` | Screenshot harness (development only). |
| `scripts/private-words/` | Maintainer's push check (development only). |

## Data flow

### Discovering chats (read-only)

Claude Code stores each chat as one `<sessionId>.jsonl` file under
`~/.claude/projects/<projectKey>/`. Nest finds the right directory by encoding
the workspace path the same way Claude Code does (`projectKeyResolver`), then
confirms it against the `cwd` recorded inside a transcript.

`chatScanner` lists the files and `jsonlReader` extracts a small summary from
each: title (custom title, then AI title, then first user message), timestamps,
branch, PR link, and whether the last assistant turn looks like a question
(`questionHeuristic`). Unknown line types are skipped. Full message bodies are
read only when you ask for one (preview, export, search indexing) by
`bodyReader`, and are not kept in memory afterwards.

### Building and refreshing the panel

1. The webview posts `ready`. The host scans chats, loads metadata, and posts a
   `sections` message.
2. `orgPanelModel` builds the rows: folder tree, tag chips, starred, unread and
   question markers, the unsorted bucket.
3. `media/orgPanel.js` draws the rows. It holds no data of its own beyond view
   state such as collapsed folders.
4. A refresh runs on `refresh` messages, on the Refresh command, and after any
   change that touches metadata. A reconcile pass also runs on activation and
   whenever the window regains focus, to pick up edits synced from another
   machine.

### Webview message protocol

Messages are plain objects with a `type` field. The host validates every
incoming message before acting on it: unknown types are dropped and each field
is type-checked.

- Webview to host: `ready`, `refresh`, `open`, `search`, `drop`, `toggleStar`,
  `toggleTag`, `createTagWithColor`, `createFolder`, `renameFolder`,
  `setFolderColor`, `deleteFolder`, `exportChat`, `archiveChat`, `restoreChat`,
  `previewArchivedChat`, `newSession`, `setState`, and a few settings messages.
- Host to webview: `sections`, `state`, `searchResults`, `settings`,
  `archivedRows`, `active`, `openSettings`, `openArchive`.

The host owns all state changes. The webview only requests them.

## Persistence

Nest keeps data in three places, chosen by how it should travel.

| Store | Holds | Synced |
| --- | --- | --- |
| Synced `globalState`, key `nest.meta.v1::<projectKey>` | Folders, tags, per-chat folder, tags, links, stars, archive flags. One document per project. | Yes, through VS Code Settings Sync. |
| Per-device state: `nest.local.v1`, `nest.shadow.v1`, `nest.deviceId.v1`, and `workspaceState` | Orphaned records, the shadow copy used to merge remote edits, the device id, sort and layout choices, read markers. | No. |
| `globalStorage` files | The search index and Nest's copies of archived chat bodies. | No. |

Only `nest.meta.v1::*` keys are registered for sync. Keeping one document per
project limits how much a sync conflict can overwrite. Every record carries an
update time and a device id. When another machine's write is detected, Nest
merges it field by field (last writer wins per field, union for tags and links)
against the shadow copy. The JSON export is the authoritative backup.

## Invariants

Keep these true in every change.

1. **Nest never writes under `~/.claude/projects`.** It reads transcripts and
   nothing else there. `exportPathGuard` rejects any such target at runtime.
2. **No network access and no telemetry.** Nest makes no HTTP requests and
   collects nothing. Its only outward action is opening Claude Code through the
   `vscode://` URI handler.
3. **All file writes go through two chokepoints**: `src/store/exportIO.ts` (Nest's
   own files) and `src/settings/claudeSettingsIO.ts` (Claude Code's
   `settings.json`, which asserts the exact allowed path). ESLint bans every other
   write-capable filesystem call shape in `src/` (member calls, computed access,
   destructured imports, aliases). Only those two files and the test tree are
   exempt. `npm run lint` is part of `npm test`, so the rule cannot be skipped.
4. **Zero runtime dependencies.** `package.json` has no `dependencies`. MiniSearch
   is vendored under `src/search/vendor/` and copied to `out/` at compile time.
5. **The webview is locked down.** It runs with a strict Content Security Policy
   (script limited to one nonce, resources limited to the media folder). Data
   reaches the DOM only through `textContent` and attributes set by the code,
   never `innerHTML`, so chat titles and snippets cannot inject markup.

Tests that read transcripts use scratch copies, never real files.

## Test layers

| Layer | Command | What it covers |
| --- | --- | --- |
| Unit | `npm test` | Pure modules and stubbed command handlers, run by Mocha against compiled output. Runs lint and compile first. |
| Extension host | `npm run test:integration` | Activation and drag-and-drop contract inside a real VS Code instance. |
| Screenshot harness | `npm run fidelity` | Renders the real panel assets with made-up data in headless Chrome or Edge and writes PNGs to `.claude-working/fidelity/` for review by eye. |

The harness HTML (`scripts/fidelity/harness.html`) copies the static shell built
in `orgPanelWebview.renderHtml`. If you change the shell, change the harness to
match, or the panel will render nothing there.
