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
| `src/claude/agentsCli.ts` | The only module that imports `child_process`. Runs `claude agents --json` through `execFile` and parses the output. |
| `src/model/types.ts` | Chat record and token total types shared by the pure modules. |
| `src/model/idFactory.ts` | Mints folder, tag and link ids and reserves the sentinel ids. |
| `src/model/folderTree.ts` | Folder tree helpers: paths, depth, ancestors, cycle checks. |
| `src/model/occurrence.ts` | Tracks where a chat appears across folders, tags and smart groups. |
| `src/model/untagged.ts` | Computes the effective tags of a chat and the untagged set. |
| `src/model/links.ts` | Link resolution between chats, including linked children. |
| `src/model/questionHeuristic.ts` | Decides whether the last assistant turn reads as a question. |
| `src/store/metadataStore.ts` | Synced per-project metadata document and the per-device local document. |
| `src/store/schema.ts` | Document shape, validation, clamping and the per-field last-writer-wins merge. |
| `src/store/schemaMigrate.ts` | Upgrades older stored documents to the current schema version. |
| `src/store/reconcile.ts` | Decides how orphaned records re-attach after a fresh scan. |
| `src/store/reconcileSync.ts` | Merges changes written by another machine against the shadow copy. |
| `src/store/exportImport.ts` | Builds, validates and merges the JSON backup. |
| `src/store/autoExport.ts` | Retention policy for the optional automatic snapshot. |
| `src/store/exportIO.ts` | Write chokepoint for Nest's own files (global storage and user-chosen export paths). |
| `src/store/exportPathGuard.ts` | Refuses any target under `~/.claude/projects`. |
| `src/store/archiveBodyStore.ts` | Nest's own copy of archived chat bodies. |
| `src/store/archiveRetention.ts` | How long archived bodies are kept. |
| `src/store/autoArchiveEngine.ts` | Applies the idle-chat archive policy. |
| `src/store/autoArchivePolicy.ts` | Decides which chats have been idle past the archive window. |
| `src/store/deviceId.ts` | Stable per-install id used to stamp edits. |
| `src/settings/claudeSettingsIO.ts` | Write chokepoint for Claude Code's `settings.json` (the retention setting only). |
| `src/fleet/types.ts` | Fleet record version, event names, field limits and the session id grammar, with the record types. |
| `src/fleet/fleetRecord.ts` | Pure parse of one fleet line and fold of records into fleet state. |
| `src/fleet/fleetSource.ts` | The only reader of `dev/fleet.jsonl`. |
| `src/fleet/fleetReloader.ts` | Debounced fleet reload, one load at a time. |
| `src/fleet/fleetWatcher.ts` | File watcher shells for the fleet, layout and queue files. The one fleet file that imports `vscode`. |
| `src/fleet/watchBase.ts` | Picks where to watch a file whose folder may not exist yet: the nearest existing folder. |
| `src/fleet/singleFlight.ts` | Runs a task one at a time and collapses overlapping requests into one follow-up run. |
| `src/fleet/nestConfig.ts` | Pure parse and validation of the layout file. |
| `src/fleet/configSource.ts` | The only reader of `.nest/config.json`, with a debounced reloader. |
| `src/fleet/placement.ts` | Pure group precedence for a chat. |
| `src/fleet/groupByOverride.ts` | Pure key, coercion and inbound gate for the per-workspace Group chats by override. |
| `src/fleet/groupModel.ts` | Pure: turns chats, fleet state, statuses, the queue and the group-by mode into panel sections. |
| `src/fleet/suffix.ts` | Pure: the short text after a chat row's agent tag. |
| `src/fleet/status.ts` | Pure status mapping, rollup and the attachable check. |
| `src/fleet/queueTable.ts` | Pure Markdown table parser for the queue. |
| `src/fleet/queueSource.ts` | The only reader of the queue file, with a debounced reloader that the extension watches. |
| `src/fleet/agentsPoller.ts` | Poll scheduler for the live session list, with an injected clock and runner. |
| `src/fleet/robinState.ts` | Pure state machine for the header robin: inputs, clock and random source in, one state out. |
| `src/fleet/rules.ts` | Pure organize rules: compile, first-match, folder templates, the Preview plan, the hand-filed guard and the Undo plan. |
| `src/commands/organizeCommands.ts` | Preview, Apply and Undo. Imports no `vscode`. Writes only through the metadata store, after the reconcile barrier. |
| `src/commands/openLayoutFile.ts` | Opens the layout file in the editor and writes nothing. |
| `src/commands/openLayoutFileHost.ts` | Wires `openLayoutFile` to the host editor APIs. |
| `src/commands/folderCommands.ts` | Create, rename, recolor and delete folders. |
| `src/commands/tagCommands.ts` | Create, rename, recolor and delete tags. |
| `src/commands/taggingCommands.ts` | Add and remove tags on chats. |
| `src/commands/linkCommands.ts` | Create and remove links between chats. |
| `src/commands/curationCommands.ts` | Star, archive and restore chats. |
| `src/commands/exportChatCommands.ts` | Export one chat to Markdown or JSON. |
| `src/commands/exportImportCommands.ts` | Backup export, import and automatic snapshot commands. |
| `src/commands/previewChatCommand.ts` | Previews a chat or an archived body. |
| `src/commands/promoteSmartGroup.ts` | Turns a smart-group bucket into a real folder or tag. |
| `src/commands/refreshScanCommands.ts` | The cancellable Refresh scan. |
| `src/commands/tokenRollupCommand.ts` | Shows the token usage report. |
| `src/search/searchIndex.ts` | Full-text index over chats. |
| `src/search/searchStore.ts` | Persists the search index in global storage. |
| `src/search/vendor/` | The vendored MiniSearch build. |
| `src/smart/smartGroupEngine.ts` | Combines the signals into suggested groups. |
| `src/smart/signals/` | One extractor each for PR, ticket, branch and fork lineage, plus the shared bucket shape. |
| `src/export/chatExport.ts` | Renders one chat as Markdown or JSON. |
| `src/rollup/tokenRollup.ts`, `rollupReport.ts` | Token usage totals by folder and tag, and the report built from them. |
| `src/launch/uriLauncher.ts` | Opens or resumes a chat through the Claude Code URI handler. |
| `src/launch/newSessionLauncher.ts` | Starts a new Claude Code chat. |
| `src/launch/attachLauncher.ts` | Pure launcher for Open in terminal. Takes an injected terminal factory, checks the session id, and builds a terminal whose shell is `claude` with the arguments `attach <id>`. Imports no `vscode` and no `child_process`. |
| `src/dnd/dropReducer.ts` | Pure interpretation of a drop into store mutations. |
| `src/dnd/dropPayload.ts` | Pure recovery of dragged chat ids from drag data. |
| `src/dnd/dragContext.ts` | In-process carrier for a drag between views. |
| `src/dnd/dndController.ts` | Tree view drag-and-drop controller. |
| `src/dnd/webviewDropAdapter.ts` | Adapter that applies webview drops through the reducer. |
| `src/views/orgPanelWebview.ts` | The webview host: builds the HTML shell, handles messages, pushes data. |
| `src/views/orgPanelModel.ts` | Pure functions that turn records and metadata into the rows the panel draws. |
| `src/views/orgPanelInteractions.ts`, `orgPanelCollapse.ts` | Pure kernels for panel interactions and the collapse-one-level control. |
| `src/views/fleetPanel.ts` | Pure: turns the group model's sections into the display-ready groups and rows the webview draws. |
| `src/views/readState.ts`, `chatMeta.ts`, `chatTooltip.ts`, `relativeTime.ts`, `tabFocusMatch.ts` | Panel helpers: unread markers, per-chat metadata, tooltips, relative times and matching open editor tabs to chats. |
| `src/views/foldersProvider.ts`, `tagsProvider.ts`, `linkDecoration.ts` | Tree providers for folders and tags, and link decorations. |
| `src/ui/tagQuickPick.ts` | The tag picker shown from commands. |
| `media/orgPanel.js` | The webview UI. Plain JavaScript, no framework. |
| `media/orgPanel.css` | Styles for the webview. |
| `media/mascot.js` | The header robin: its pixel art, both palettes and one scene per state. The webview and the README script both draw it. |
| `media/readme/` | README images, including the robin hero and state sheet. |
| `docs/mascot.md`, `docs/mascot/` | The robin style sheet: every state animated, the still poses, the icons and both palettes. |
| `schemas/nest-config.schema.json` | JSON schema for the layout file, shipped in the extension. |
| `src/test/integration/vscodeExecutable.ts` | Finds the VS Code executable in a downloaded build, with an injected file probe so unit tests skip the downloader. |

Scripts (development only):

- `scripts/fidelity/` renders the panel with made-up data and screenshots it.
- `scripts/private-words/` is the maintainer's push check.
- `scripts/readme/robin.js` builds the README robin images and the robin style sheet from `media/mascot.js`.
- `scripts/docs-retired.test.js` checks the docs for dead links and retired surfaces.

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
  `previewArchivedChat`, `newSession`, `setState`, `organizePreview`,
  `organizeApply`, `organizeUndo` (no payload), and a few settings messages.
- Host to webview: `sections`, `state`, `searchResults`, `settings`,
  `archivedRows`, `active`, `openSettings`, `openArchive`, `organize`. The `settings` message
  also carries `groupByOverride` (`auto` when none) and `robinAnimations`.

The host owns all state changes. The webview only requests them.

## Persistence

Nest keeps data in three places, chosen by how it should travel.

| Store | Holds | Synced |
| --- | --- | --- |
| Synced `globalState`, key `nest.meta.v1::<projectKey>` | Folders, tags, per-chat folder, tags, links, stars, archive flags. One document per project. | Yes, through VS Code Settings Sync. |
| Per-device state: `nest.local.v1`, `nest.shadow.v1`, `nest.deviceId.v1`, and `workspaceState` | Orphaned records, the last organize Apply (for Undo), the shadow copy used to merge remote edits, the device id, sort and layout choices, read markers. | No. |
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
  version other than 1, a session id that fails `^[0-9a-fA-F][0-9a-fA-F-]{7,63}$`, or an unknown
  event. It strips control characters from every string, caps names and folders at
  200 characters, tags at 40 characters (20 tags at most) and paths at 1024, then
  folds records in time order into one entry per session. Unknown fields and unknown
  roles are ignored.
- The current orchestrator is the newest one that no `rotate` record names as
  `previous` and that has not ended. Every other orchestrator is past, newest first.
  A `backfill` record creates an entry like `launch` but is flagged so it never
  counts as a new pickup.
- `fleetReloader.ts` debounces watcher events by 250 ms, then reloads. Reloads run
  one at a time through `singleFlight.ts`: a request that arrives during a reload
  causes exactly one follow-up reload, so a stalled filesystem call never stacks up
  loads. The clock and the watcher are injected, so unit tests use a fake clock. `fleetWatcher.ts` is
  wired from `extension.ts` and is covered by `npm run test:integration`.
- A file watcher on a missing folder never fires. When a watched file's folder does not
  exist yet (no `dev/` before the first fleet record, no `.nest/` before the layout file),
  `fleetWatcher.ts` watches the nearest existing folder for the next missing one and moves
  down as folders appear. A watcher on a removed folder stays silent too, so while the file
  is watched its folder is also watched from the parent, and the watch starts over when that
  folder is removed or made again. Each new watch reloads once more a second later to catch
  a write that lands while the watcher starts.
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
- The reloader debounces watcher events by 150 ms, then reloads one at a time with
  one follow-up, like the fleet reloader. The clock and the watcher are injected. On a reload, `extension.ts` recomputes linked folders and
  fleet paths, re-creates the fleet watchers only when the resolved path list
  changed, reloads fleet state and refreshes the panel.
- `placement.ts` picks a chat's group in this order: a folder you filed it in by
  hand, a fleet organize folder, then automatic grouping by
  `groupBy` (`auto`, `tickets`, `folders`, `date`). A computed group is display
  only. It is not a drop target and writes no metadata, and it stays visible when
  the Unsorted section is hidden. Organize rules do not place chats virtually; they
  file chats into your folders when you press Apply (see Organize rules).
- `schemas/nest-config.schema.json` is contributed through `contributes.jsonValidation`
  for `.nest/config.json` and ships in the VSIX.
- The Settings overlay holds a Group chats by control, a Layout file row, an Organize
  section and a Robin animations toggle. Group chats by is a per-workspace override stored in
  `workspaceState` under `claudeNest.orgPanel.groupByOverride`, never synced. A concrete
  override (`tickets`, `folders` or `date`) takes precedence over the layout file's
  `groupBy`. `auto` clears it, and the layout file's value stands. `groupByOverride.ts`
  is pure and holds the key, the coercion and the inbound gate. The webview sends
  `setGroupBy` (`mode`), `setRobinAnimations` (`on`) and `openLayoutFile`. The host
  drops an unknown mode or a non-boolean `on`, re-applies the layout after a
  `setGroupBy`, and writes `claudeNest.robin.animations` for the toggle.
- Open Layout File opens the existing file with `showTextDocument`, or an untitled
  JSONC editor when the file is missing. It uses no filesystem write.
- Unit tests cover parsing, coercion, expansion, precedence and the reloader with a
  fake clock. The hot reload and the command run in `npm run test:integration`.

## Organize rules

The `rules` array of the layout file files existing chats into your folders and tags. Nest only acts when you press a button: nothing applies on a file change.

A rule is `{ "match": { ... }, "folder"?, "tags"?, "pin"? }`. The `match` object takes `role`, `agent`, `ticket` (`true` or a regular expression), `name` (a regular expression) and `cwd` (a glob where `*` matches any run of characters). Every condition must hold. `folder` is a template with the fields `{ticket}`, `{title}`, `{agent}`, `{role}` and `{subfolder}`; a slash in the template makes one sublevel. `tags` lists tag names, and `pin: true` stars the chat.

- `src/fleet/rules.ts` is pure and clock-free. Rules are evaluated in file order and the first match wins. Each regular expression is capped at 200 characters, compiled once, and limited to a backtracking-safe shape: at most three quantifiers, no repeated groups, lookarounds or backreferences. A pattern whose worst-case match cost over the tested text exceeds a fixed budget (100000 steps) is refused. Only the first 64 characters of a name or ticket are tested, and rules stay off until the workspace is trusted. A rule with an invalid or over-long pattern, an unknown key or field, no condition or no action is turned off and reported, and the other rules stay active.
- A template expands from the coerced fleet fields and the scan only. A field value never adds a level (its slashes become hyphens), the result has at most two levels, and an empty field leaves the chat unfiled by that rule. Names go through the same folder path expansion as a folder created by hand.
- Preview covers every unarchived chat, including chats known only from `backfill` records, and lists each move with the current folder, the target folder, the tags to add and whether the chat is starred. It writes nothing.
- A chat you filed by hand is never moved or retagged. A chat is movable only when it has no folder, or its folder is the one the last Apply chose for it. After Undo, a folder the user kept on a chat Undo skipped counts as filed by hand.
- Apply runs after the reconcile barrier, recomputes the plan, creates missing folders and tags, and writes through the metadata store like a hand move. It stores a per-device record in `nest.local.v1` (never synced, no schema version change): the folder and tags each changed chat had before, the folders and tags Apply created, and the folder chosen for each chat a rule filed.
- Undo restores the last Apply's record. It leaves alone a chat whose folder or star changed since, removes only the tags Apply added, deletes folders and tags Apply created that nothing uses any more, and clears the record.
- The Settings overlay posts `organizePreview`, `organizeApply` and `organizeUndo`. The host drops any other organize message. The commands `claudeNest.organizePreview`, `claudeNest.organizeApply` and `claudeNest.organizeUndo` reach the same code from the Command Palette; Apply and Undo ask for confirmation there.
- Unit tests cover matching, first-match, templates, the hand-filed guard, the Preview plan and Undo. A store-backed test covers Apply then Undo behind a barrier.

## Live status

Each chat gets one status: `working`, `needs`, `queued`, `done` or `idle`. A group
shows the most urgent status of its chats, in the order needs, working, queued, done,
idle. The panel draws them as the dots described under Fleet panel.

- `src/claude/agentsCli.ts` runs `claude agents --json` with `execFile`, a fixed binary
  name, fixed arguments, no shell, a 5 second timeout and a 4 MB output cap. The
  runner is injected, so unit tests never start a process. The parser accepts an array
  of objects, keeps `sessionId`, `kind`, `state`, `status`, `cwd`, `name`, `startedAt`
  and `pid` after coercion, drops any entry whose session id fails
  `^[0-9a-fA-F][0-9a-fA-F-]{7,63}$`, and returns an empty list for anything else.
- The command runs with the home directory as its working directory, and a hard
  SIGKILL ends it at the timeout. It does not run in an untrusted workspace: the
  poller reports live status as off and does not start the process.
- `status.ts` is pure. An interactive session with `status: busy`, or a background
  session in state `running`, `working` or `busy`, is working. A background session in
  state `blocked`, `waiting`, `needs-input` or `needs_input`, or an unread assistant
  question, needs you. A session in state `done` or `stopped`, or a fleet `end`, is
  done. A fleet `launch` with no live session and no transcript yet is queued. Anything
  else is idle. Only sessions whose id matches a chat or fleet entry in the panel
  affect status.
- `agentsPoller.ts` polls every 10 seconds while the panel is visible and every 60
  seconds otherwise. It never runs two polls at once and stops on dispose. A transient
  failure (a timeout or a non-zero exit) keeps the last good
  sessions and retries at the normal cadence. When the `claude` binary is missing, or
  the workspace is untrusted, Nest logs once, shows no message, derives status from
  transcripts and fleet records only, and backs off to one retry every 5 minutes.
- `queueTable.ts` reads the first Markdown table whose header has the configured key
  and stage columns. It keeps row order, caps rows at 500 and cells at 200
  characters, and returns an empty list when the table or columns are missing.
- `queueSource.ts` is the only reader of the queue file named by `queue.file` in
  `.nest/config.json`. It resolves `~` and relative paths against the first workspace
  folder, skips a file over 256 KB, drops a path that resolves into
  `~/.claude/projects` (by path or realpath), and is ignored in an untrusted
  workspace. Nest never writes the queue. The extension watches the file, and a
  create, change or delete reloads it after a 250 ms debounce, one load at a time with
  one follow-up. A change to `queue.file` in the layout file moves the watch.
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
   id matches `^[0-9a-fA-F][0-9a-fA-F-]{7,63}$`.
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
- The webview posts `openInTerminal` with a session id that passes the safe id check and `^[0-9a-fA-F][0-9a-fA-F-]{7,63}$` when you click an attachable row or choose Open in terminal from its menu. The webview never creates a terminal itself; see Open in terminal under Live status.
- The webview keeps the open state of each group and saves it with the webview `setState`. The Active projection forces live groups open without changing that state, so turning Active off restores it.
- A stage pill takes its color from the layout file's `tags` by stage name. Otherwise stages that match `fail` are orange, `doneStages` are green, stages that match `uat`, `review` or `test` are teal, and the rest are blue. Only a `#rrggbb` color reaches a style.
- Fleet, layout, queue and CLI strings reach the page through `textContent`. The webview builds no HTML from data.
- With a fleet message, the panel draws Starred and Questions when they are not empty, then the fleet layout, then your folders. Active shows only the fleet groups that hold a working or needs chat.
- Group open and close, new rows, the dot to check change and the stage color change are animated. Each has a `prefers-reduced-motion` rule that removes the motion.
- The header shows a pixel-art robin beside the "Nest" wordmark.

## Header robin

`src/fleet/robinState.ts` is pure: it takes the inputs, the clock and an injected random source and returns one state. The host runs it and posts a small `robin` message (`state`, `speed`, `workingCount`, `noteBudget`, `noteDelaysMs`, `noteMinMs`, `noteSpreadMs`, `animations`, `reducedHint`, `liveText`). `media/mascot.js` draws and animates the robin. `media/orgPanel.js` only picks the theme and the motion and tells it when to draw.

- States, highest priority first: hatch, rotate, error, needs, worm, done, milestone, working, sleep, night and idle. Hatch, rotate, error, worm, done and milestone are transient and play once (5.3, 4.4, 6, 4, 3.5 and 4.5 seconds), then the robin falls back to the next state that holds. Each one-shot scene (hatch, rotate, worm, done and milestone) runs exactly as long as the host holds its state, and a unit test checks that the two agree. One-shots play whole: one that starts while another plays waits for it, only one of each kind waits at a time, and one that a higher state outranks is dropped instead of showing part way through later. Finishing the last ticket plays done, then milestone.
- The host feeds the machine from existing inputs: fleet entries (a new launch that is not a backfill and carries a ticket, and an `end` outcome), the rotate chain, the per-chat statuses and live session states, and queue rows against `doneStages`. The first step only seeds what it has seen, so existing history never replays as a transient.
- The robin sleeps after 10 minutes with no working or needs chat, and shows night when it sleeps between 22:00 and 06:00 local time. The host sets one timer for the next transient end or sleep point and stops it while the panel is hidden.
- While working, each working chat gets its own note lane, up to six, and a note leaves the beak at most once every 2.5 seconds per chat at a random moment. Three or more working chats tap faster, six or more faster still.
- The hatch plays on the first run on a device. The flag lives in `globalState` under a key that is not registered for sync.
- `claudeNest.robin.animations` (default on) turns every animation and note off and leaves a still robin. `prefers-reduced-motion` does the same. A still pose keeps the robin perched and shows one marker: a question mark, exclamation mark, z, moon, check, note, worm, plus or sparkle burst, or, for hatch, the cracked egg alone.
- `media/mascot.js` holds the art as pixel rows, one character per pixel, and two palettes: one for light themes, one for dark and high contrast themes. Each state is a scene, a pure function of time that returns sprite placements (which sprite, where, how opaque). `frame(state, t, opts)` returns the placements at one moment with seeded notes, for tests and captures. `render()` draws them as square SVG rects with `fill` attributes, 3 CSS pixels per art pixel, and redraws about 30 times a second, only when a placement moved. No CSS animation runs, and no color reaches a style.
- The whole bird leaves the branch only in a hop, jump or flight (needs, done, milestone, rotate and hatch). In every other state the legs and body stay at rest and only the head and chest move: breathing lifts the head one pixel and swells the chest, and the error squawk shakes the head and raises its crest. A unit test samples every planted scene every 50 ms over the 14 second idle cycle at every tap speed and allows only head, chest, legs, body and sign sprites, and the screenshot run checks the drawn legs and body against the rest pose.
- The webview reads dark from the body theme class (`vscode-dark`, or high contrast that is not light) and watches it, so a theme change redraws at once. It stops the animation while the panel is hidden and resumes the scene where it stopped, and it skips an identical robin message so a scene in flight keeps playing.
- Rotate flies the robin off to the right, leaves the branch empty, and lands a fresh one from the left. The header keeps 39 pixels of top padding (13 art pixels), so the highest jump, note and burst stay inside it; only the robin flying away and the egg's cap leave through the top, and a unit test holds every scene to that. The wordmark sits above the robin's layer.
- `scripts/readme/robin.js` builds the README images and the robin style sheet (`docs/mascot.md`) from the same scenes. A unit test fails when they are out of date.
- The robin is `aria-hidden`. A separate polite live region announces only a change to needs or error.
