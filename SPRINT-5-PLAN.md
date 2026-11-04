# Claude Code Nest: Sprint 5 Slice Plan, "Fleet View"

This file is the single authoritative build contract for Sprint 5. It turns the
approved fleet-view design (phase P1 of the owner's loops design, decisions D6,
D7, D11, D13 to D20) into dependency-ordered vertical slices that the slice engine
(`.claude/workflows/nest-slice-build.js`) builds unattended. Sibling docs and their
roles:

| Doc | Role this sprint |
|---|---|
| SPRINT-5-PLAN.md | The contract. Never edited mid-build except to back-fill issue numbers. |
| UI-SPEC.md | Binding UI contract. Its new "Sprint 5 fleet view" section is the visual authority for every UI slice. |
| ARCHITECTURE.md | Binding, living. Fit-review patches only. |
| DECISIONS.md | Append-only log of autonomous forks. |
| CHANGELOG.md | One entry per slice under Unreleased. |
| TESTING.md | Regenerated at handoff from the Manual smoke sections below. |
| SPRINT-4-PLAN.md | Planned, not built. See "Sprint 4 relationship". |

Issues: parent #153; private-word check #154; slices #155 to #165; security council #166.

Approval: the owner approved this plan in advance on 2026-11-03, in these words:
"I approve in advance a Sprint 5 plan that stays inside that starter's scope;
anything outside it waits for me." Everything below stays inside that scope.
Anything outside it is listed under "Waits for the owner" and is not built.

## What ships

A Nest panel that shows a fleet of Claude Code chats at a glance:

1. Nest reads a strict per-folder fleet record (`dev/fleet.jsonl`, append-only,
   written by an orchestrator, never by Nest), including `organize` events and the
   `agent` field.
2. A `.nest/config.json` layout file with a published JSON schema and hot reload.
   A move the user makes by hand in Nest always wins over the file and over rules.
3. "Auto" grouping for any folder: tickets when fleet records exist; otherwise the
   working subfolder; chats launched by another chat nest under their parent; the
   rest under date headings (Today, Earlier this week, Older).
4. Live status from `claude agents --json`: blinking green working dot, blinking
   amber "?" when the user is needed, steady blue queued dot, a check when done, a
   hollow idle dot. A folder shows its most urgent chat's dot. Many chats can work
   at once.
5. Ticket view: newest orchestrator pinned on top, Past orchestrators, one folder
   per ticket with a stage tag, chat rows as an agent tag plus a short suffix, an
   Active button, and a Queue button that opens a read-only queue. Nest never
   queues anything.
6. An animated block-character robin in the panel header, driven by live fleet
   state, with a reduced-motion version of every state and an off switch.
7. Opening chats: finished chats through
   `vscode://Anthropic.claude-code/open?session=<id>`; running background chats
   through "Open in terminal" (`claude attach <id>`).
8. Organize rules with a backfill Preview over existing chats, then Apply and Undo.

Everything stays general: no client setup ships in the repo. A user configures Nest
through their own workspace's `.nest/config.json`.

## Sprint shape: three build parts plus a release-prep run

| Part | Prefix | Orders | Theme |
|---|---|---|---|
| A | `s5a-` | 0..3 | Test host, fleet record, layout file, live status |
| B | `s5b-` | 0..2 | Grouping model, fleet panel, open running chats |
| C | `s5c-` | 0..2 | Robin, settings, organize rules |
| R | `s5r-` | 0 | Security council, docs closeout, handoff (no version, tag or release) |

Parts are strictly serial, one engine run at a time. Orders restart at 0 per part;
ids are unique across the sprint.

### Landing model this sprint (owner rule: never merge to main)

The owner is away and the rule is: GitHub writes (issues, pushes, pull requests)
only inside a posting window the owner opens; never merge to main. So:

- The engine runs with `localLanding: true` and `integrationBranch: "sprint-5"`.
  Each slice commits on `slice/<id>` (branched from the `sprint-5` tip) with its
  `Nest-Slice` trailer, then merges into the local `sprint-5` branch with a merge
  commit. The engine never pushes, never opens a pull request, never touches main.
- Resume and done-ness are judged by trailers on the local `sprint-5` branch.
- The driver pushes branches and opens pull requests by hand, only while a posting
  window is open, after `npm run check:private -- <range>` passes. Pull requests
  are stacked: each `slice/<id>` targets the previous slice's branch (the first
  targets `sprint-5-plan`, which targets main). When the owner merges one into
  main and deletes its branch, GitHub retargets the next to main.
- Outside a window, every push and pull request waits in
  `.claude-working/outbox.md` with its diff summary and the exact command.
- `Fixes #<issue>` goes in each pull request body, never in the commit.

### Sprint 4 relationship

Sprint 4 (`SPRINT-4-PLAN.md`, issues #137 to #151) is planned and unbuilt. It is a
no-feature sweep over the same files this sprint touches most (`orgPanel.js`,
`orgPanelWebview.ts`, `extension.ts`). Folding it in would double this sprint's
size and is outside the approved scope, so it waits. What this sprint takes from
it, as patterns only (no Sprint 4 checkbox is claimed):

- s4a-input-hardening's rules (strip control characters, length caps, coerce at the
  boundary) apply to every new untrusted input here: fleet records, the layout
  file, the queue table, and `claude agents --json` output.
- s4b-retire-smart-groups deletes `src/smart/`. Ticket grouping here is built
  fresh in `src/fleet/` and never imports `src/smart/`, so that retirement stays
  clean.
- s4a-scan-perf's rescan cadence is untouched; live status polls the CLI on its
  own timer and never triggers a transcript rescan.

After this sprint lands, Sprint 4's slices need a rebase onto the new panel; its
planner re-reads this plan first.

## Review upgrades in force this sprint (from the Sprint 3 and 4 retrospectives)

1. TRAILER INTEGRITY GATE (Sprint 3). The slice commit carries `Nest-Slice:
   <id> (<order>)` as the sole final paragraph; no `Fixes` line in the commit.
   The landing verifies `git log -1 --format=%(trailers:key=Nest-Slice,valueonly)`
   on the slice commit returns the id. A parse failure is a halt.
2. FORMALIZED HALT SALVAGE (Sprint 3). On any resume, inspect git status, branch
   and trailers first; salvage only through an independent five-lens verify.
3. FINDINGS-BASED ACCEPTANCE CRITERIA (Sprint 4). Every checkbox below is
   verifiable from the diff or a command's output; the completeness critic audits
   each one.
4. UNTRUSTED-INPUT LENS, WIDENED (new). Four new inputs come from files and a
   process Nest does not control. Every value that reaches the webview passes a
   coerce step with a length cap and control-character strip, and is rendered with
   `textContent` only. A session id that reaches a terminal or a URI must match
   the session-id grammar first.
5. PUBLIC-REPO LENS (new). No client names, people names, real ticket numbers or
   client paths anywhere in code, tests, fixtures, docs or screenshots. All
   fixtures use made-up data (ticket ids like `T-101`, folders like
   `~/work/sample-app`). A real-looking client name is a major finding.

## Sprint-wide hard rules

- The read-only line on `~/.claude/projects/` is unchanged and re-asserted on
  every fs-touching slice.
- Nest never writes a fleet record, a queue file, or `.nest/config.json`. It only
  reads them. "Open layout file" on a missing file opens an untitled editor at that
  path with a starter template; the user decides whether to save it.
- The write-ban lint in `.eslintrc.json` stays as it is. No new fs-write carve-out.
  Organize Apply and Undo write only through the existing metadata store, behind
  the reconcile barrier, like a hand move.
- The one new process spawn, `claude agents --json`, lives in a single module
  (`src/claude/agentsCli.ts`) using `execFile` with a fixed binary name and fixed
  arguments, no shell, a 5 second timeout and a 4 MB output cap. It is the only
  `child_process` import under `src/`; a lint rule restricts the import to that
  file.
- "Open in terminal" creates a VS Code terminal whose shell is `claude` with the
  arguments `attach <id>` (no `sendText`, no shell string), and only after the id
  matches `^[0-9a-fA-F-]{8,64}$`.
- No new synced scalars and no `SCHEMA_VERSION` bump. Per-device state (group-by
  override, last Apply snapshot, robin first-launch flag) lives in workspaceState
  or globalState keys that are never passed to `setKeysForSync`.
- `src/dnd/dropReducer.ts` stays frozen.
- The extension is not renamed and not published (D11). The header wordmark reads
  "Nest" (UI-SPEC deviation 14); `displayName` stays as it is.
- Zero runtime dependencies. No new fonts or binary assets.
- Every UI change keeps the ARIA tree, roving focus, and keyboard behavior intact,
  and every animation honors `prefers-reduced-motion`.

## Universal Definition of Done (every slice)

- `npm test` (lint, compile, unit) and `npm run test:integration` (the VS Code
  extension host) both pass. testCommand runs both.
- installCheck succeeds: the VSIX packages.
- Adversarial review dry: no critical or major finding, including no unmet
  acceptance-criteria checkbox on the slice's issue.
- UI slices: `npm run fidelity -- --theme light` and `-- --theme dark` capture the
  panel with made-up data into `.claude-working/screens/`; the build and review
  compare the captures against UI-SPEC's Sprint 5 section. A visible mismatch
  against a spec token or metric is a major.
- CHANGELOG updated under Unreleased; ARCHITECTURE.md updated when a binding
  contract or the module map changed; DECISIONS.md appended for any fork.
- New pure logic has unit tests (no `vscode` import in unit tests); every new
  vscode-facing behavior that unit tests cannot reach has an extension-host
  integration test under `src/test/integration/`.
- Lands on `sprint-5` with verified author and committer Jake Mismas
  <jake@jakemismas.com>, no AI attribution, the exact trailer.
- Public-repo lens clean; sacred constraints re-asserted on any slice that
  touches them.
- Retirement: a superseded surface loses every registration (commands, menus,
  messages, exports, tests, docs).
- The engine state file is never staged; no scratch files under `src/`.

## Part A: data (prefix `s5a-`)

### Slice A0: s5a-test-host
Goal: make the extension-host integration suite and the screenshot harness usable
by every later slice on this machine and in CI.
Ships: `npm run test:integration` runs green from a VS Code terminal; the fidelity
harness captures light and dark themes into `.claude-working/screens/`.
Modules: `src/test/integration/runTest.ts`, `scripts/fidelity/screenshot.js`,
`scripts/fidelity/harness.html`, `src/test/unit/projectKeyResolver.test.ts`,
`.vscodeignore`, `package.json`.
Tests: unit tests for the executable resolver; the integration suite itself.
Manual smoke: run `npm run test:integration` from a VS Code integrated terminal and
see the suite pass; run `npm run fidelity -- --theme dark` and open the PNG.

Acceptance criteria:
- [ ] `runTest.ts` deletes `ELECTRON_RUN_AS_NODE` from the environment before
  launching, so the suite runs from inside a VS Code terminal.
- [ ] `runTest.ts` resolves the downloaded VS Code executable and falls back from
  `.../MacOS/Electron` to `.../MacOS/Code` when the former is missing; a unit test
  covers both names with a fake filesystem probe.
- [ ] `npm run test:integration` exits 0 locally (output tail recorded in the
  slice's test evidence).
- [ ] `scripts/fidelity/screenshot.js` accepts `--theme light|dark` (default
  light) and `--out <dir>` (default `.claude-working/screens/`), and names files
  `<state>-<theme>.png`; the dark theme defines dark `--vscode-*` variables in the
  harness so theme-following surfaces render dark.
- [ ] The existing test fixture in `projectKeyResolver.test.ts` that names a real
  client folder is replaced with a made-up folder name; the test still passes.
- [ ] `.vscodeignore` excludes `SPRINT-4-PLAN.md`, `SPRINT-5-PLAN.md`,
  `schemas/*.md` (if any) and `scripts/**` stays excluded; the VSIX file list
  (`npx vsce ls`) shows no plan documents.
Non-goals: no CI change to run integration tests (CI has no display); no new
devDependencies.

```json
{ "id": "s5a-test-host", "order": 0, "issue": 155 }
```

### Slice A1: s5a-fleet-record
Goal: read and fold fleet records into a typed, validated fleet state.
Ships: Nest loads `dev/fleet.jsonl` from each workspace folder, watches it, and
exposes a `FleetState` the panel can use (no UI change yet beyond a debug-free
refresh on change).
Modules: `src/fleet/fleetRecord.ts` (pure), `src/fleet/fleetSource.ts`,
`src/fleet/types.ts`, `src/extension.ts`, `ARCHITECTURE.md`.
Tests: unit tests for parsing, coercion, folding, the rotate chain and organize
events; an integration test that appending a line to a watched file in a temp
workspace folder fires a reload.
Manual smoke: in a scratch folder, write a two-line `dev/fleet.jsonl` (an
orchestrator launch and a build launch for ticket `T-101`); reload Nest and confirm
no error toast; append an `end` line and confirm the panel refreshes.

Record contract (version 1, one JSON object per line): `v` (1), `at` (ISO time),
`event` (`launch`, `rename`, `rotate`, `end`, `backfill`, `organize`), `agent`,
`sessionId`, `name`, `client`, `ticket` (string or null), `role` (`orchestrator`,
`build`, `fix`, `qa`, `spike`, `capture`, `review`, `intake`, `draft`), `launchedBy`
(session id or a user marker), `cwd`, and for `rotate` also `previous` and `next`.
`organize` carries any of `folder`, `tags` (array), `stage`. `end` may carry
`outcome` (`done` or `failed`). Unknown fields and unknown events are ignored.

Acceptance criteria:
- [ ] `parseFleetLine` accepts a valid v1 line and rejects (returns null for)
  non-JSON, non-object, `v` other than 1, a missing or malformed `sessionId`, and
  an unknown `event`, without throwing.
- [ ] Every string field is coerced: control characters stripped, length capped
  (names and folders 200, tags 40 each, at most 20 tags), and ids checked against
  the session-id grammar.
- [ ] `foldFleet` builds per-session entries (name, ticket, role, agent,
  launchedBy, cwd, client, folder, tags, stage, ended, outcome, firstAt, lastAt)
  where later records override earlier ones field by field, `rename` changes only
  the name, and `organize` changes only the fields it carries.
- [ ] The rotate chain resolves the current orchestrator as the newest
  orchestrator that no `rotate` names as `previous` and that has not ended; all
  other orchestrators are listed as past, newest first.
- [ ] `backfill` records create entries exactly like `launch` but never count as
  a new pickup for animations (`isBackfill: true`).
- [ ] `fleetSource` reads `dev/fleet.jsonl` from every workspace folder, skips a
  file larger than 8 MB with one logged warning, reads lines up to 16 KB, and
  never writes any file (no write API is imported).
- [ ] A file watcher on each fleet file triggers a debounced (250 ms) reload; the
  integration test proves an appended line reaches the fleet state.
- [ ] ARCHITECTURE.md gains a "Fleet record (read-only input)" section and a
  module-map entry for `src/fleet/`.
Non-goals: no UI rendering of fleet data; no writing of records.

```json
{ "id": "s5a-fleet-record", "order": 1, "issue": 156 }
```

### Slice A2: s5a-nest-config
Goal: a file-driven layout (`.nest/config.json`) with a published schema and hot
reload, including linked folders and the queue source.
Ships: Nest reads `.nest/config.json` from the first workspace folder, validates it
against the shipped schema, reloads on save, adds linked folders' chats and fleet
records, and offers "Nest: Open Layout File".
Modules: `schemas/nest-config.schema.json`, `src/fleet/nestConfig.ts` (pure),
`src/fleet/configSource.ts`, `src/claude/chatScanner.ts`,
`src/claude/projectKeyResolver.ts`, `src/extension.ts`, `package.json`.
Tests: unit tests for parsing, defaults, coercion, and linked-folder expansion;
integration tests for hot reload and the Open Layout File command.
Manual smoke: create `.nest/config.json` with `"groupBy": "date"` in a scratch
folder and save; the panel regroups without a reload. Type an invalid value and see
the schema squiggle in the editor.

Config fields: `$schema`, `groupBy` (`auto`, `tickets`, `folders`, `date`),
`rules` (array, validated here, used in slice C2), `tags` (name to hex color),
`linkedFolders` (array of absolute or `~` paths, `*` allowed in the last segment
only), `queue` (`file`, `keyColumn`, `stageColumn`, optional `titleColumn`), `fleet`
(`files`: extra fleet record paths), `doneStages` (default `["Done"]`).

Acceptance criteria:
- [ ] `schemas/nest-config.schema.json` describes every field above and is
  contributed through `contributes.jsonValidation` for `.nest/config.json`.
- [ ] `parseNestConfig` returns defaults for a missing or unparsable file and a
  list of human-readable problems for invalid fields; an invalid field falls back
  to its default without discarding valid siblings.
- [ ] Coercion caps every string (paths 1024, names 200), drops non-hex colors,
  and caps arrays (rules 200, linked folders 50, tags 100).
- [ ] Linked folders expand `~`, allow `*` only in the last segment, resolve only
  existing directories, cap expansion at 50 matches, and never resolve under
  `~/.claude/projects`.
- [ ] Chats from each linked folder's transcript directory appear in the panel
  next to the workspace's own chats (read-only scan through the existing scanner);
  their org metadata lives under the window's project key.
- [ ] Fleet records from linked folders and from `fleet.files` load through the
  slice A1 source.
- [ ] A watcher on `.nest/config.json` reloads within 500 ms of a save (integration
  test).
- [ ] The command `claudeNest.openLayoutFile` opens the existing file, or, when it
  is missing, an untitled editor at `.nest/config.json` pre-filled with a starter
  template that includes `$schema`; Nest itself writes nothing (integration test
  asserts the file does not exist after the command).
- [ ] A user's hand-filed folder for a chat (a folder set in the metadata store
  by drag or menu) always wins over the config and fleet `organize` placement;
  a unit test covers the precedence order: hand-filed, then fleet organize, then
  rules, then auto grouping.
Non-goals: no settings UI (slice C1); no rules execution (slice C2).

```json
{ "id": "s5a-nest-config", "order": 2, "issue": 157 }
```

### Slice A3: s5a-live-status
Goal: live per-chat status from `claude agents --json` and queue state from a
Markdown table, rolled up per folder.
Ships: each chat gets a status (working, needs, queued, done, idle); each group
gets its most urgent status; the queue list is available read-only.
Modules: `src/claude/agentsCli.ts`, `src/fleet/status.ts` (pure),
`src/fleet/queueTable.ts` (pure), `src/extension.ts`, `.eslintrc.json`.
Tests: unit tests for the CLI output parser, status mapping, rollup, the queue
table parser, and the poll scheduler with a fake clock; an integration test that a
missing CLI degrades quietly.
Manual smoke: start a background chat in the workspace and see its status turn
working within 10 seconds while the panel is visible.

Status mapping (D16): an interactive session with `status: busy`, or a background
session with state `running`, `working` or `busy`, is working. A background state
of `blocked`, `waiting`, `needs-input` or `needs_input`, or an unread assistant
question (the existing question marker), is needs. A fleet `launch` with no live
session and no transcript yet is queued. A session with state `done` or `stopped`,
or a fleet `end`, is done. Anything else is idle. Rollup order: needs, working,
queued, done, idle.

Acceptance criteria:
- [ ] `agentsCli.ts` runs `claude agents --json` through `execFile` with no shell,
  a 5 second timeout and a 4 MB `maxBuffer`, behind an injected runner so unit
  tests never spawn a process.
- [ ] The parser accepts an array of objects, keeps only `sessionId`, `kind`,
  `state`, `status`, `cwd`, `name`, `startedAt` and `pid` after coercion, and
  returns an empty list for anything else without throwing.
- [ ] Only sessions whose `sessionId` matches a chat in the panel affect status;
  entries for other folders are ignored.
- [ ] The status mapping and rollup above are implemented in pure functions with
  a unit test per row.
- [ ] Polling runs every 10 seconds while the panel is visible and every 60
  seconds otherwise; overlapping polls are skipped; polling stops on dispose.
- [ ] When the CLI is missing or fails, Nest logs once, shows no toast, treats all
  statuses as derived from transcripts and fleet records, and retries every 5
  minutes.
- [ ] `queueTable.ts` parses the first Markdown table in the configured queue file
  whose header has the configured key and stage columns, keeps row order, caps at
  500 rows and cells at 200 characters, and returns an empty list when the file or
  columns are missing.
- [ ] `.eslintrc.json` restricts `child_process` imports under `src/` to
  `src/claude/agentsCli.ts`.
Non-goals: no rendering (slice B1); no writes to the queue.

```json
{ "id": "s5a-live-status", "order": 3, "issue": 158 }
```

## Part B: panel (prefix `s5b-`)

### Slice B0: s5b-group-model
Goal: one pure model that turns chats, fleet state, config, statuses and the queue
into the panel's sections for every group-by mode.
Ships: `buildFleetSections` used by the webview host (rendering follows in B1).
Modules: `src/fleet/groupModel.ts` (pure), `src/fleet/suffix.ts` (pure),
`src/views/orgPanelModel.ts`, `src/views/orgPanelWebview.ts`.
Tests: unit tests per group-by mode, the parent nesting, date buckets, the
precedence order, suffixes, the Active projection and the queue projection.
Manual smoke: none beyond B1 (pure model).

Acceptance criteria:
- [ ] Ticket mode yields: the current orchestrator (pinned), past orchestrators
  (newest first), one group per ticket (id, title, stage, chats, rollup status),
  user folders, Unsorted, and the archived count.
- [ ] A ticket's title comes from the queue table's title column when present,
  else the newest chat name with the ticket id removed; its stage comes from the
  queue table, else the newest fleet `organize` stage.
- [ ] A chat row inside a ticket group carries its agent tag (from `agent`, else
  `role`) and a short suffix: the chat name with the ticket id, the title words and
  the agent word removed, trimmed to 24 characters ("round 2", "data check"), or
  empty.
- [ ] Folders mode groups by the chat's working subfolder relative to the
  workspace root (from fleet `cwd`, else the transcript cwd); chats launched by
  another chat (`launchedBy`) nest one level under their parent.
- [ ] Date mode buckets by last activity into Today, Earlier this week, and Older
  using the local calendar week.
- [ ] Auto mode picks tickets when any fleet record has a non-null ticket, else
  folders when chats span more than one working subfolder, else date.
- [ ] Hand-filed chats stay in their user folder in every mode; fleet `organize`
  folders create virtual groups that never write to the store.
- [ ] The Active projection keeps only working and needs chats, opens every group
  that holds one, and hides the rest; the count includes the orchestrator.
- [ ] The queue projection lists queue rows in file order with key, title and
  stage, and marks rows whose ticket has a live chat.
- [ ] Group and row ids follow the existing id grammar (no `:`, `#` or `>`) and
  never collide with the reserved sentinels.
Non-goals: no rendering changes.

```json
{ "id": "s5b-group-model", "order": 0, "issue": 159 }
```

### Slice B1: s5b-fleet-panel
Goal: render the fleet sections in the panel per UI-SPEC's Sprint 5 section.
Ships: the ticket view and the any-folder view, status dots, stage and agent tags,
the Active filter, the read-only Queue list, and the row animations.
Modules: `media/orgPanel.js`, `media/orgPanel.css`, `src/views/orgPanelWebview.ts`,
`scripts/fidelity/harness.html`, `src/test/unit/*`.
Tests: unit tests for the host message shapes and coercion; harness captures in
light and dark for: ticket view, any-folder view, Active on, Queue open.
Manual smoke: open a folder with a fleet record (made-up data) and check the
pinned orchestrator, a ticket folder's stage tag, the chat tags, the Active filter
and the Queue list.

Acceptance criteria:
- [ ] The header row holds the robin slot (empty until C0) and the "Nest"
  wordmark; below it a search box, an "Active N" button with a pulsing green dot
  and an "Queue N" button with a steady blue dot, per UI-SPEC.
- [ ] The pinned orchestrator renders as the bordered card row; "Past
  orchestrators" is a collapsible row below it.
- [ ] Each ticket group row shows chevron, rollup status dot, muted ticket id,
  title, and the stage pill in the stage's color; chat rows show the status dot,
  the agent tag in its color, and the suffix.
- [ ] Any-folder groups show the folder or clock icon, label, a pulsing dot when
  any chat in it is live, and the count; child chats show the `└` marker and a
  deeper indent.
- [ ] Status dots match D16 and UI-SPEC: working pulses green, needs blinks an
  amber "?", queued is steady blue, done is a check, idle is hollow.
- [ ] The Active button toggles `aria-pressed`, opens every group with a live
  chat and hides everything else; toggling off restores the previous open state.
- [ ] The Queue button toggles a read-only list (position, muted key, title,
  stage pill, blue dot); the list offers no reorder, add or remove control.
- [ ] Animations: a new row slides in with a brief highlight; a dot that becomes
  done morphs into the check; group open and close slide; Active collapses and
  expands rows; a stage pill cross-fades on change. Each has a
  `prefers-reduced-motion` rule that removes the motion.
- [ ] Every new string from fleet, config, queue or CLI data reaches the DOM
  through `textContent`; no `innerHTML` with data.
- [ ] The ARIA tree keeps roles, levels, roving tabindex and arrow-key behavior
  for the new rows (unit test over the row model's aria fields).
- [ ] Harness captures for the four states in light and dark land in
  `.claude-working/screens/` with made-up data only.
Non-goals: no robin art (C0); no settings changes (C1).

```json
{ "id": "s5b-fleet-panel", "order": 1, "issue": 160 }
```

### Slice B2: s5b-open-running
Goal: open finished chats in Claude Code and running background chats in a
terminal.
Ships: clicking a finished or idle chat opens it through the Claude Code link;
clicking a running background chat offers "Open in terminal", which runs
`claude attach <id>` in a new VS Code terminal.
Modules: `src/launch/attachLauncher.ts`, `src/launch/uriLauncher.ts`,
`src/extension.ts`, `media/orgPanel.js`, `package.json`.
Tests: unit tests for the id guard and the launcher's terminal options with an
injected terminal factory; an integration test that the command creates a terminal
with the expected shell path and arguments.
Manual smoke: start a background chat, click it in Nest, choose "Open in
terminal", and land in the attached session.

Acceptance criteria:
- [ ] A chat whose live status comes from a background session that is working or
  needs the user opens "Open in terminal" (a notification with that button) on
  click; every other chat opens through
  `vscode://Anthropic.claude-code/open?session=<id>` as today.
- [ ] The context menu gains "Open in terminal" for running background chats only.
- [ ] `attachLauncher` validates the id against `^[0-9a-fA-F-]{8,64}$` before any
  terminal is created and refuses otherwise with a warning.
- [ ] The terminal is created with `shellPath: 'claude'` and
  `shellArgs: ['attach', id]`, named after the chat (coerced, 60 characters), with
  no `sendText` call.
- [ ] When `claude` is not on PATH the terminal's failure is surfaced as a single
  warning naming the command, and nothing else changes.
Non-goals: no attach for interactive sessions; no session control (stop, kill).

```json
{ "id": "s5b-open-running", "order": 2, "issue": 161 }
```

## Part C: robin and organize (prefix `s5c-`)

### Slice C0: s5c-robin
Goal: the header robin, animated by live fleet state.
Ships: the block-character robin from UI-SPEC in the header with every state in
the design, three new states, reduced-motion stills, and an off switch.
Modules: `src/fleet/robinState.ts` (pure), `media/orgPanel.js`,
`media/orgPanel.css`, `src/views/orgPanelWebview.ts`, `package.json`,
`scripts/fidelity/harness.html`.
Tests: unit tests for the state machine (priorities, transient states and their
durations, note scheduling with an injected random source, night window); harness
captures of each state in light and dark.
Manual smoke: with animations on, start two background chats and watch the robin
peck with notes; turn on the editor's reduced motion and see a still robin.

States (priority high to low; transient states play once, then fall back):
handoff (a `rotate` event, transient 3.2 s), error (a fleet `end` with
`outcome: failed` or a CLI state of `failed` or `error`, transient 6 s), needs (any
chat needs the user), worm (a new non-backfill `launch` with a ticket, transient
1.8 s), done (a fleet `end` with `outcome: done` or a ticket entering a
`doneStages` stage, transient 1.6 s), milestone (every queue row's ticket in a
`doneStages` stage, transient 4 s), working (one or more working chats; peck speed
steps up at 3 and 6), sleep (nothing running for 10 minutes), night (sleep between
22:00 and 06:00 local, with a crescent moon), idle. New states proposed and built
this sprint: hatch (first launch only, an egg cracks and the robin appears,
transient 2.4 s, remembered per device), milestone, and night.

Acceptance criteria:
- [ ] The robin renders from text spans with the exact block characters and
  colors in UI-SPEC (head, body, branch rows), including the eye blink every
  3.4 s.
- [ ] `robinState` returns one state from the inputs above using the stated
  priority and transient durations; a unit test covers each state and each
  priority conflict.
- [ ] While working, one pixel note (the 3-row block note from UI-SPEC) pops out
  per working chat at random moments, at most one note per chat per 2.5 s, with
  an injected random source in tests; zero working chats means zero notes.
- [ ] Idle breathes, blinks, glances around, and flicks its tail; needs tilts,
  hops and pulses a "?"; done jumps with notes and a sparkle burst; error shakes
  with a red "!"; sleep tucks and floats "z Z"; handoff flies off and a robin
  lands; worm gulps a worm; hatch cracks an egg; milestone does a double jump with
  a larger burst; night shows a crescent moon and slower breathing.
- [ ] Under `prefers-reduced-motion`, every state shows a still pose with its
  static marker ("?", "!", "z", moon, check) and no keyframe animation runs.
- [ ] The setting `claudeNest.robin.animations` (default true) turns all robin
  animation off (still pose, no notes); the robin itself stays.
- [ ] The robin is `aria-hidden`; its state is exposed once as a polite live
  region text only when it changes to needs or error.
- [ ] Animation timers live in `orgPanel.js` (CSP: no inline script or style)
  and stop while the webview is hidden.
Non-goals: no other mascots; no sound.

```json
{ "id": "s5c-robin", "order": 0, "issue": 162 }
```

### Slice C1: s5c-settings
Goal: the Settings overlay controls for this sprint per the mockup's Settings
board.
Ships: "Group chats by" (Auto, Tickets, Folders, Date), "Layout file" with an Open
button, and "Robin: Animations" toggle.
Modules: `media/orgPanel.js`, `media/orgPanel.css`, `src/views/orgPanelWebview.ts`,
`src/extension.ts`, `scripts/fidelity/harness.html`.
Tests: unit tests for the new inbound messages' coercion and the group-by
precedence; harness captures of the Settings overlay in light and dark.
Manual smoke: switch Group chats by to Date and back to Auto; click Open on the
layout file; toggle robin animations off and on.

Acceptance criteria:
- [ ] A four-option segmented control sets the group-by mode; the choice is a
  per-workspace override stored in workspaceState (never synced) that wins over
  the layout file's `groupBy`; choosing Auto clears the override.
- [ ] The caption under the control reads "Auto: tickets when an orchestrator
  records them, otherwise folders, then date."
- [ ] The Layout file row shows `.nest/config.json` and an Open button that runs
  `claudeNest.openLayoutFile`.
- [ ] The Robin row toggles `claudeNest.robin.animations` through the
  configuration API and reflects external changes to the setting.
- [ ] New inbound messages pass the existing `coerce` gate (enum-checked mode,
  boolean toggle) and unknown values are ignored.
- [ ] Overlay focus trap, Escape to close and focus return still work.
Non-goals: no rules editor (rules live in the layout file).

```json
{ "id": "s5c-settings", "order": 1, "issue": 163 }
```

### Slice C2: s5c-organize-rules
Goal: ordered auto-organize rules with a backfill Preview, Apply and Undo.
Ships: Settings gains an "Organize" section: Preview lists every move the rules
would make over existing chats; Apply files them into user folders and tags;
Undo restores the last Apply.
Modules: `src/fleet/rules.ts` (pure), `src/commands/organizeCommands.ts`,
`src/store/metadataStore.ts` (call sites only), `media/orgPanel.js`,
`media/orgPanel.css`, `src/views/orgPanelWebview.ts`.
Tests: unit tests for rule matching, first-match-wins, templates, the hand-filed
guard, preview diffing, and Undo; an integration test for Apply then Undo against a
store fake behind the reconcile barrier.
Manual smoke: add a rule matching role `qa` with tag `qa` to the layout file,
Preview, Apply, check the tags, then Undo.

Rule shape: `{ "match": { "role"?, "agent"?, "ticket"? (true or a regex),
"name"? (regex), "cwd"? (glob) }, "folder"? (template with {ticket}, {title},
{agent}, {role}, {subfolder}), "tags"? (array), "pin"? (boolean) }`.

Acceptance criteria:
- [ ] Rules are evaluated in order and the first match wins; regexes are length
  capped (200), compiled once, and an invalid regex disables only its rule with a
  reported problem.
- [ ] Templates expand from coerced fleet fields only and produce names that pass
  the existing folder-name validation.
- [ ] Preview lists every move (chat, from, to folder, tags added) with counts,
  covering all existing chats including those known only from `backfill` records,
  and writes nothing.
- [ ] A chat whose folder was set by hand (any folder assignment not made by the
  last Apply) is never moved and never retagged by a rule.
- [ ] Apply writes through the metadata store behind the reconcile barrier,
  creating missing folders, and records a per-device snapshot (never synced) of
  every changed chat's prior folder and tags.
- [ ] Undo restores exactly the snapshot of the last Apply, skips chats the user
  changed since, removes folders Apply created that are now empty, and clears the
  snapshot.
- [ ] `pin: true` stars the chat through the existing star path.
Non-goals: no automatic Apply on file change; no rule editor UI.

```json
{ "id": "s5c-organize-rules", "order": 2, "issue": 164 }
```

## Part R: release prep (prefix `s5r-`)

The security council runs before this slice over the whole sprint diff against
`452fb621eafb9dba8920f7ff4f729ce7b05bf631` (main at plan time). Deviation from the
suite's release gate, recorded for the owner: this run makes no version bump, tag
or GitHub release, so it does not wait for the human smoke pass; the real release
(version, tag, Marketplace-free VSIX on the GitHub release) waits for the owner's
smoke pass on the parent issue and his merge to main.

### Slice R0: s5r-docs-handoff
Goal: close out the docs for the fleet view.
Ships: README fleet-view section with a made-up `.nest/config.json` example and
the fleet record contract; ARCHITECTURE module map and invariants current;
CHANGELOG Unreleased consolidated.
Modules: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `UI-SPEC.md` (pointer
sweep only), `docs/fleet-record.md`.
Tests: the full suite; a grep that no doc references a retired surface.
Manual smoke: read the README section and follow its example in a scratch folder.

Acceptance criteria:
- [ ] README documents the fleet record fields, the layout file fields with a
  made-up example, the status dots, the Active and Queue buttons, Open in
  terminal, organize rules, and the robin off switch.
- [ ] `docs/fleet-record.md` is the canonical record contract an orchestrator can
  write against, with a made-up example per event.
- [ ] ARCHITECTURE.md's module map lists every new module from this sprint.
- [ ] No doc names a client, a person, a real ticket, or a client path.
Non-goals: no version bump, tag, or release.

```json
{ "id": "s5r-docs-handoff", "order": 0, "issue": 165 }
```

## Engine args (paste verbatim per part; issue numbers back-filled at approval)

Shared fields for every part:

```json
{
  "identity": { "name": "Jake Mismas", "email": "jake@jakemismas.com" },
  "trailerPrefix": "Nest",
  "planDoc": "SPRINT-5-PLAN.md",
  "perSliceFloor": 300000,
  "maxFixRounds": 3,
  "councilMinConfidence": 0.6,
  "integrationBranch": "sprint-5",
  "localLanding": true,
  "sacredConstraints": [
    "Nothing writes, renames, moves or deletes under ~/.claude/projects/.",
    "Nest never writes a fleet record, a queue file, or .nest/config.json; it only reads them.",
    "No new fs-write carve-out in .eslintrc.json; organize Apply and Undo write only through the metadata store behind the reconcile barrier.",
    "child_process is imported only by src/claude/agentsCli.ts, via execFile with a fixed binary and arguments, no shell.",
    "A session id reaches a terminal or URI only after matching ^[0-9a-fA-F-]{8,64}$.",
    "No new synced scalars and no SCHEMA_VERSION bump.",
    "src/dnd/dropReducer.ts stays frozen.",
    "No client names, people names, real ticket numbers or client paths in code, tests, fixtures, docs or screenshots.",
    "The extension is not renamed and not published."
  ],
  "defaultTestCommand": "npm test && npm run test:integration",
  "defaultInstallCheck": "npx vsce package --no-dependencies -o .claude-working/build-check.vsix",
  "packageCommand": "npx vsce package --no-dependencies -o .claude-working/claude-code-nest-sprint-5.vsix",
  "visualReference": "UI-SPEC.md",
  "stateFile": ".slice-build-state.json"
}
```

Part A adds:

```json
{
  "runHandoff": false,
  "slices": [
    { "id": "s5a-test-host", "order": 0, "issue": 155, "visualCheck": "npm run fidelity -- --theme light && npm run fidelity -- --theme dark" },
    { "id": "s5a-fleet-record", "order": 1, "issue": 156 },
    { "id": "s5a-nest-config", "order": 2, "issue": 157 },
    { "id": "s5a-live-status", "order": 3, "issue": 158 }
  ]
}
```

Part B adds:

```json
{
  "runHandoff": false,
  "slices": [
    { "id": "s5b-group-model", "order": 0, "issue": 159 },
    { "id": "s5b-fleet-panel", "order": 1, "issue": 160, "visualCheck": "npm run fidelity -- --theme light && npm run fidelity -- --theme dark" },
    { "id": "s5b-open-running", "order": 2, "issue": 161 }
  ]
}
```

Part C adds:

```json
{
  "runHandoff": false,
  "slices": [
    { "id": "s5c-robin", "order": 0, "issue": 162, "visualCheck": "npm run fidelity -- --theme light && npm run fidelity -- --theme dark" },
    { "id": "s5c-settings", "order": 1, "issue": 163, "visualCheck": "npm run fidelity -- --theme light && npm run fidelity -- --theme dark" },
    { "id": "s5c-organize-rules", "order": 2, "issue": 164, "visualCheck": "npm run fidelity -- --theme light && npm run fidelity -- --theme dark" }
  ]
}
```

Part R adds:

```json
{
  "runHandoff": true,
  "slices": [
    { "id": "s5r-docs-handoff", "order": 0, "issue": 165 }
  ],
  "securityCouncil": {
    "beforeSliceId": "s5r-docs-handoff",
    "issue": 166,
    "maxRounds": 3,
    "baselineRef": "452fb621eafb9dba8920f7ff4f729ce7b05bf631",
    "trailerId": "sprint-5",
    "changeSetLabel": "Sprint 5",
    "extraLenses": [
      { "key": "untrusted-local-inputs", "prompt": "Refute the safety of every path by which fleet.jsonl, .nest/config.json, the queue Markdown table, or claude agents --json output reaches the webview DOM, a terminal, a URI, a regex engine, or the metadata store. Look for missing coercion, missing length caps, ReDoS in user-supplied rule regexes, id grammar gaps, and innerHTML sinks." },
      { "key": "public-repo-hygiene", "prompt": "Refute that the sprint diff is free of client names, people names, real ticket numbers, and client paths in code, tests, fixtures, docs, and screenshots. Treat any real-looking organization or person name in a fixture as a finding." },
      { "key": "process-and-terminal", "prompt": "Refute the safety of the child_process use in src/claude/agentsCli.ts and the terminal created for claude attach: shell interpretation, argument injection, PATH hijack assumptions, unbounded output, zombie processes, and polling that never stops." }
    ]
  }
}
```

## Waits for the owner (outside the approved scope)

1. Merging anything to main, version 0.3.0, the tag, and the GitHub release.
2. Sprint 4 (`SPRINT-4-PLAN.md`), which needs a rebase onto this sprint's panel.
3. Writing fleet records (`fleet.py`) and orchestrator changes: phase P2, a
   different repo.
4. Mascot alternatives from the design's "Mascot ideas" board; the robin is the
   only mascot built.
5. Wiring the private-word check as a real git `pre-push` hook: this machine's
   global hooks path belongs to another tool, so the check runs as
   `npm run check:private` before every push the driver makes.
6. Moving issue cards on the project board: the GitHub token lacks the project
   scope, so board moves wait for `gh auth refresh -s project`.

## Retrospective inputs to watch this sprint

- First sprint on the current model: record actual spend per slice for the first
  two slices and re-baseline `perSliceFloor` and part sizing in the next plan.
- First sprint with local landing: record whether trailer resume on `sprint-5`
  behaved, and whether stacked pull requests were easy for the owner to merge.
