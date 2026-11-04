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
| `src/fleet/` | Read-only fleet input: `types`, `fleetRecord` (pure parse and fold), `fleetSource` (the only reader of `dev/fleet.jsonl`), `fleetReloader` (debounce), `fleetWatcher` (the one file that imports `vscode`). |
| `src/fleet/` (layout file) | `nestConfig` (pure parse and validate), `configSource` (the only reader of `.nest/config.json`, with a debounced reloader), `placement` (pure group precedence). |
| `src/claude/agentsCli.ts` | The only module that imports `child_process`. Runs `claude agents --json` through `execFile` and parses the output. |
| `src/fleet/` (group model) | `groupModel` (pure: turns chats, fleet state, statuses, the queue and the group-by mode into panel sections), `suffix` (pure: the short text after a chat row's agent tag). |
| `src/fleet/` (live status) | `status` (pure status mapping and rollup), `queueTable` (pure Markdown table parser), `queueSource` (the only reader of the queue file), `agentsPoller` (poll scheduler with an injected clock and runner). |
| `src/commands/openLayoutFile.ts` | Opens the layout file in the editor. Writes nothing. |
| `schemas/nest-config.schema.json` | JSON schema for the layout file, shipped in the extension. |
| `src/search/` | Full-text index (`searchIndex`), its persistence (`searchStore`), and the vendored MiniSearch build. |
| `src/smart/` | Signal extraction (PR, ticket, branch, fork lineage) used to suggest groups. |
| `src/export/chatExport.ts` | Renders one chat as Markdown or JSON. |
| `src/rollup/` | Token usage totals and the report built from them. |
| `src/launch/` | Opens or starts a chat in Claude Code through its URI handler and commands. |
| `src/launch/attachLauncher.ts` | Pure launcher for Open in terminal. Takes an injected terminal factory, checks the session id, and builds a terminal whose shell is `claude` with the arguments `attach <id>`. Imports no `vscode` and no `child_process`. |
| `src/dnd/` | Drag-and-drop interpretation (`dropReducer`) and the adapter for webview drops. |
| `src/commands/` | Thin command handlers (folders, tags, links, curation, export, import, preview, refresh). |
| `src/views/orgPanelWebview.ts` | The webview host: builds the HTML shell, handles messages, pushes data. |
| `src/views/orgPanelModel.ts` | Pure functions that turn records and metadata into the rows the panel draws. |
| `src/views/` (other files) | Panel helpers (`readState`, `chatMeta`, `chatTooltip`, `relativeTime`, `tabFocusMatch`) and service providers for folders and tags. |
| `src/ui/tagQuickPick.ts` | The tag picker shown from commands. |
| `media/orgPanel.js`, `media/orgPanel.css` | The webview UI. Plain JavaScript, no framework. |
| `src/test/integration/vscodeExecutable.ts` | Finds the VS Code executable in a downloaded build, with an injected file probe so unit tests skip the downloader. |
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

## Fleet record (read-only input)

Nest reads `dev/fleet.jsonl` from each workspace folder and folds it into a fleet
state. Nest never writes a fleet record.

- `src/fleet/fleetSource.ts` is the only reader of `dev/fleet.jsonl`. It imports no
  write API and uses the same read style as the chat scanner, so the lint write ban
  needs no exception. Transcripts under `~/.claude/projects` stay with the scanner.
- A file over 8 MB is skipped with one logged warning. A line over 16 KB is dropped.
  A missing or unreadable file contributes nothing.
- `fleetSource` takes a list of file paths, so more folders can be added without
  changing the reader.
- `fleetRecord.ts` parses one line. It returns null for non-JSON, a non-object, a
  version other than 1, a session id that fails `^[0-9a-fA-F-]{8,64}$`, or an unknown
  event. It strips control characters from every string, caps names and folders at
  200 characters, tags at 40 characters (20 tags at most) and paths at 1024, then
  folds records in time order into one entry per session. Unknown fields and unknown
  roles are ignored.
- The current orchestrator is the newest one that no `rotate` record names as
  `previous` and that has not ended. Every other orchestrator is past, newest first.
  A `backfill` record creates an entry like `launch` but is flagged so it never
  counts as a new pickup.
- `fleetReloader.ts` debounces watcher events by 250 ms, then reloads. The clock and
  the watcher are injected, so unit tests use a fake clock. `fleetWatcher.ts` is
  wired from `extension.ts` and is covered by `npm run test:integration`.
- The panel renders the fleet record through the fleet message described under Fleet panel.

## Layout file (.nest/config.json)

Nest reads an optional `.nest/config.json` from the first workspace folder. Nest
never writes, creates, renames or deletes it. You edit it in the editor.

- `src/fleet/configSource.ts` is the only reader of `.nest/config.json`. Like
  `fleetSource`, it imports no write API and reads with `fs.promises.stat` and
  `fs.promises.readFile`, so the lint write ban needs no exception. A file over
  256 KB is skipped.
- `nestConfig.ts` parses JSON with comments. A missing or unparsable file yields
  defaults. An invalid field falls back to its default and adds one readable problem;
  valid sibling fields are kept. Strings are stripped of control characters and
  capped (paths 1024, names 200). Colors that are not hex are dropped. Arrays are
  capped (rules 200, linked folders 50, tags 100, fleet files 50).
- Linked folders expand `~`, allow `*` in the last path segment only, keep existing
  directories and stop at 50 matches. A folder or fleet file that resolves into
  `~/.claude/projects`, by path or by realpath, is dropped, so a symlink cannot
  escape the exclusion. Expansion only reads (stat, readdir, realpath).
- Linked folders and `fleet.files` are ignored in an untrusted workspace.
- Chats in linked folders go through the same `scanChats` and `resolveProjectDir`
  path, one scan per folder, merged by session id (the workspace copy wins).
  Metadata stays under the window's project key. The `dev/fleet.jsonl` file of each
  linked folder and every `fleet.files` entry feed the same `fleetSource` list.
- The reloader debounces watcher events by 150 ms, then reloads. The clock and the
  watcher are injected. On a reload, `extension.ts` recomputes linked folders and
  fleet paths, re-creates the fleet watchers only when the resolved path list
  changed, reloads fleet state and refreshes the panel.
- `placement.ts` picks a chat's group in this order: a folder you filed it in by
  hand, a fleet organize folder, rules (not used yet), then automatic grouping by
  `groupBy` (`auto`, `tickets`, `folders`, `date`). A computed group is display
  only. It is not a drop target and writes no metadata, and it stays visible when
  the Unsorted section is hidden.
- `schemas/nest-config.schema.json` is contributed through `contributes.jsonValidation`
  for `.nest/config.json` and ships in the VSIX.
- Open Layout File opens the existing file with `showTextDocument`, or an untitled
  JSONC editor when the file is missing. It uses no filesystem write.
- Unit tests cover parsing, coercion, expansion, precedence and the reloader with a
  fake clock. The hot reload and the command run in `npm run test:integration`.

## Live status

Each chat gets one status: `working`, `needs`, `queued`, `done` or `idle`. A group
shows the most urgent status of its chats, in the order needs, working, queued, done,
idle. The panel draws them as the dots described under Fleet panel.

- `src/claude/agentsCli.ts` runs `claude agents --json` with `execFile`, a fixed binary
  name, fixed arguments, no shell, a 5 second timeout and a 4 MB output cap. The
  runner is injected, so unit tests never start a process. The parser accepts an array
  of objects, keeps `sessionId`, `kind`, `state`, `status`, `cwd`, `name`, `startedAt`
  and `pid` after coercion, drops any entry whose session id fails
  `^[0-9a-fA-F-]{8,64}$`, and returns an empty list for anything else.
- The command runs with the first workspace folder as its working directory. It does
  not run in an untrusted workspace: Nest treats the command as missing and logs once.
- `status.ts` is pure. An interactive session with `status: busy`, or a background
  session in state `running`, `working` or `busy`, is working. A background session in
  state `blocked`, `waiting`, `needs-input` or `needs_input`, or an unread assistant
  question, needs you. A session in state `done` or `stopped`, or a fleet `end`, is
  done. A fleet `launch` with no live session and no transcript yet is queued. Anything
  else is idle. Only sessions whose id matches a chat or fleet entry in the panel
  affect status.
- `agentsPoller.ts` polls every 10 seconds while the panel is visible and every 60
  seconds otherwise. It never runs two polls at once and stops on dispose. When the
  command is missing or fails, Nest logs once, shows no message, derives status from
  transcripts and fleet records only, and retries every 5 minutes.
- `queueTable.ts` reads the first Markdown table whose header has the configured key
  and stage columns. It keeps row order, caps rows at 500 and cells at 200
  characters, and returns an empty list when the table or columns are missing.
- `queueSource.ts` is the only reader of the queue file named by `queue.file` in
  `.nest/config.json`. It resolves `~` and relative paths against the first workspace
  folder, skips a file over 256 KB, drops a path that resolves into
  `~/.claude/projects` (by path or realpath), and is ignored in an untrusted
  workspace. Nest never writes the queue.
- ESLint restricts `child_process` imports to `src/claude/agentsCli.ts`. The test tree
  is exempt.

### Open in terminal

A chat whose live session is a background session in a working or needs state can be
attached from a terminal.

- `isAttachable` in `status.ts` is true only when the matched session has kind
  `background` and a working or needs state. The status alone is not enough, because
  needs also covers an unread question on a chat that has no background session.
  The group model copies the result to each row as `attachable`, and the fleet message
  passes it to the webview.
- A click on an attachable row posts `openInTerminal`. The host shows a notification
  with an Open in terminal button. Pressing it creates the terminal. Dismissing the
  notification opens the chat through the URI handler like any other click. The chat
  context menu shows Open in terminal for attachable rows only.
- The host checks the live session list again before it offers the terminal, so a
  stale or forged message falls back to the plain open.
- `attachLauncher.ts` creates the terminal with `shellPath: 'claude'` and
  `shellArgs: ['attach', id]`, named after the chat (control characters removed, 60
  characters at most). It never calls `sendText` and never builds a shell string. It
  uses `vscode.window.createTerminal` through an injected factory, so the
  `child_process` restriction is unchanged.
- In an untrusted workspace the terminal is not created and the click opens the chat
  through the URI handler.
- When the terminal closes with a non-zero exit code, which is what a missing `claude`
  command produces, Nest shows one warning that names `claude`.

## Invariants

Keep these true in every change.

1. **Nest never writes under `~/.claude/projects`.** It reads transcripts and
   nothing else there. `exportPathGuard` rejects any such target at runtime.
2. **No network access and no telemetry.** Nest makes no HTTP requests and
   collects nothing. Its only outward actions are opening Claude Code through the
   `vscode://` URI handler, one local subprocess, `claude agents --json`, started
   by `src/claude/agentsCli.ts` with a fixed command and no shell, and the attach
   terminal, a VS Code terminal whose shell is `claude` with the arguments
   `attach <id>`, created by `src/launch/attachLauncher.ts` only after the session
   id matches `^[0-9a-fA-F-]{8,64}$`.
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
| Extension host | `npm run test:integration` | Activation and drag-and-drop contract inside a real VS Code instance. Needs a VS Code download and a display. |
| Screenshot harness | `npm run fidelity` | Renders the real panel assets with made-up data in headless Chrome or Edge and writes `<state>-<theme>.png` files to `.claude-working/screens/` for review by eye. |

Pass `--theme light|dark` (default `light`) and `--out <dir>` to the harness, as in
`npm run fidelity -- --theme dark`. The dark theme sets `data-theme="dark"` on the
harness root, which turns on a small block of dark `--vscode-*` variables. Light adds
nothing. Colors that the panel hardcodes do not change by theme.

The harness HTML (`scripts/fidelity/harness.html`) copies the static shell built
in `orgPanelWebview.renderHtml`. If you change the shell, change the harness to
match, or the panel will render nothing there.

## Group model

`src/fleet/groupModel.ts` is pure and clock-free. `buildFleetSections` takes the chats, the user folders, the fleet state, the statuses, the queue rows, the group-by mode, the workspace root and the current time, and returns the sections the panel shows. It writes nothing. The webview host exposes it through `getFleetSections` and posts it as the fleet message.

- Tickets mode returns the pinned current orchestrator, past orchestrators newest first, one group per ticket (id, title, stage, chats, rollup status), your folders, Unsorted and the archived count. A ticket title comes from the queue title column, else the newest chat name with the ticket id removed. A ticket stage comes from the queue, else the newest fleet organize stage.
- Folders mode groups by the working subfolder relative to the workspace root, from the fleet `cwd`, else the live session `cwd`, else the `cwd` read from the transcript and carried on the chat record. A chat launched by another chat in the same group nests one level under its parent. A launch cycle leaves its members unnested.
- Date mode groups by last activity into Today, Earlier this week and Older. The local calendar week starts on Monday.
- Auto mode resolves to tickets when any fleet entry has a ticket, else folders when chats span more than one working subfolder, else date.
- A chat you filed by hand stays in its folder in every mode. A fleet organize folder is a virtual group and never writes to the store.
- The Active projection keeps working and needs chats, forces open every group that holds one, and hides the rest. The Active count includes the orchestrator.
- The queue projection lists queue rows in file order and marks rows whose ticket has a working or needs chat.
- Group ids use a kind prefix and replace `:`, `#` and `>`, so they never collide with the reserved sentinels in `idFactory`.
- `suffix.ts` removes the ticket id, the ticket title words and the agent word from a chat name and trims the result to 24 characters.

## Fleet panel

The host posts one `fleet` message that the webview only draws. `src/views/fleetPanel.ts` is pure: it turns the group model's sections into display-ready groups and rows, including the ARIA level, position, set size and label of every treeitem, the stage pill color family and the agent tag color key.

- The host posts `fleet` after each `sections` post, and again when live sessions, queue rows or the layout file's stage colors change. It skips a post whose text equals the last one, so the 10 second poll does not redraw an unchanged panel.
- The webview posts `setActive` with a strict boolean when you press Active. The host recomputes the sections with the Active projection and posts them back. The Active state is not stored.
- The webview posts `openInTerminal` with a session id that passes the safe id check and `^[0-9a-fA-F-]{8,64}$` when you click an attachable row or choose Open in terminal from its menu. The webview never creates a terminal itself; see Open in terminal under Live status.
- The webview keeps the open state of each group and saves it with the webview `setState`. The Active projection forces live groups open without changing that state, so turning Active off restores it.
- A stage pill takes its color from the layout file's `tags` by stage name. Otherwise stages that match `fail` are orange, `doneStages` are green, stages that match `uat`, `review` or `test` are teal, and the rest are blue. Only a `#rrggbb` color reaches a style.
- Fleet, layout, queue and CLI strings reach the page through `textContent`. The webview builds no HTML from data.
- With a fleet message, the panel draws Starred and Questions when they are not empty, then the fleet layout, then your folders. Active shows only the fleet groups that hold a working or needs chat.
- Group open and close, new rows, the dot to check change and the stage color change are animated. Each has a `prefers-reduced-motion` rule that removes the motion.
- The header has an empty robin slot beside the "Nest" wordmark.
