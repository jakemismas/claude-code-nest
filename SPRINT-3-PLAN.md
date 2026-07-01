# Claude Code Nest: Sprint 3 Slice Plan, "One Panel" (v0.2.0)

Twelve dependency-ordered vertical slices that rebuild the shipped v0.1.1 extension into
the SINGLE sidebar panel defined by the Claude-design handoff at `media/design/`
(prototype `ChatSidebar.html`, prose `media/design/README.md`), matched verbatim. The
sprint reworks the surviving surface, REMOVES every other view, and ADDS the missing
design behavior. UI-SPEC.md is the binding UI contract, including the agreed deviations;
this file is the build contract for the autonomous runs. Parent issue: #76.

Sprint 3 runs as THREE engine parts plus a gated release run, one build chat each:

- Part 1 (prefix `s3a-`, orders 0..5): consolidation, the visual harness, and the
  re-skinned core list.
- Part 2 (prefix `s3b-`, orders 0..3): hover card, context menu, Settings and Archive
  overlays, auto-archive.
- Part 3 (prefix `s3c-`, orders 0..1): full-state fidelity sweep, docs and a11y closeout.
- HUMAN VERIFY GATE: no release runs until Jake installs the part-3 VSIX, runs the
  TESTING.md smoke checklist next to the open prototype, and records the pass as a
  comment on #76. Findings become fix PRs first.
- Release run (single slice `s3r-release`): the 10-lens security council (armed via
  args), then version 0.2.0, tag, and the GitHub release. Issue #91; council issue #90.

Each part's orders are contiguous from 0 as the engine requires; the exact-id trailer
matching (fix for #29) keeps parts from colliding with each other and with prior sprints.

## Design references (binding)

- `media/design/ChatSidebar.html`: the working prototype; the definitive reference.
- `media/design/README.md`: tokens, metrics, and interaction prose; match verbatim.
- `UI-SPEC.md`: the Nest data mapping, the read-state model, and the agreed deviations
  (hardcoded palette, width flexibility, done-dot semantics, reduced motion, a11y floor,
  best-effort Claude integration points). Reviews must NOT flag agreed deviations.
- `media/design/reference/`: 320px reference screenshots (created by slice s3a-1).

## How this feeds the build engine

The engine is `.claude/workflows/nest-slice-build.js` (upgraded pre-sprint, #77). Per
slice it reads `id`, `order` (contiguous 0..n-1 per part), `issue`, `testCommand`
(default `npm test`), `installCheck`, and NEW `visualCheck` (a command producing harness
screenshots; when present the build iterates against the design and a visual-fidelity
review lens runs). Run args also carry `planDoc: "SPRINT-3-PLAN.md"` so councils and the
handoff read this plan. Landing stays PR-per-slice with the `Nest-Slice: <id> (<order>)`
trailer; the engine now puts `Fixes #<issue>` in every slice PR body so the merge closes
the issue.

Engine review upgrades in force this sprint (all from the Sprint 2 retrospective):

- An always-on untrusted-input-security lens joins the per-slice adversarial review.
- The completeness critic audits the slice's GitHub-issue acceptance criteria checkbox
  by checkbox against the diff; an unmet criterion is a major finding.
- Fix passes obey the CLASS-SWEEP RULE: fix the named instance AND every sibling of its
  class (all map keys, all id sinks, all color fields, all render sites).
- UI slices get the visual-fidelity lens: fresh harness screenshots read next to
  `media/design/reference/`.

## Universal Definition of Done (per slice)

Per-slice notes below list only deltas. Every slice must also satisfy:

- tsc --noEmit clean; eslint clean; npm test green (headless unit suite).
- vsce package succeeds (the install proof).
- The adversarial review (4 lenses + completeness, plus visual on UI slices) comes back
  dry: no critical or major finding, including no unmet issue acceptance criterion.
- For UI slices: the harness screenshot comparison against the design reference is part
  of build AND review; visible mismatches against spec tokens or metrics are major.
- README feature section and CHANGELOG entry updated; ARCHITECTURE.md updated when a
  binding contract changes.
- Lands as its own PR, author and committer Jake Mismas <jake@jakemismas.com> (no AI
  attribution of any kind), carrying `Nest-Slice: <id> (<order>)` and `Fixes #<issue>`.
- The read-only invariant re-asserted on every fs-touching slice: nothing writes,
  renames, moves, or deletes under `~/.claude/projects/`; every fs write goes through
  the settings chokepoint or exportIO behind `assertNotUnderClaudeProjects`.
- The gitignored .nest-build-state.json is never staged; no scratch files under src/.

## Sprint-wide hard rules

- The handoff palette is hardcoded verbatim; no VS Code theme variables drive panel
  colors this sprint (UI-SPEC deviation 1 covers width only).
- `src/dnd/dropReducer.ts` is frozen (shell-only DnD changes), as in Sprint 2.
- The synced schema does not change: no new synced scalars, no SCHEMA_VERSION bump.
  Read state, sort, collapsed set, section toggles, and archive search are LOCAL Memento
  state, never in setKeysForSync.
- Bodies are never held in the scan snapshot; hover card and search read on demand.
- The search index and all body copies stay in globalStorage or memory, never synced,
  never under `~/.claude/projects`.
- Nothing loads from the network (fonts included; Newsreader is bundled).
- Removed surfaces are removed cleanly: no orphaned commands in the palette, no dead
  activation events, no unreferenced media files shipped in the VSIX.

## Test layering

Unchanged from Sprint 2: headless node + mocha unit tests are the engine's test gate;
electron-host integration tests stay deferred to TESTING.md. NEW: the fidelity harness
(`npm run fidelity`) is a build/review aid, not a test gate; it renders the real webview
assets with synthetic data and screenshots them for eye comparison.

---

## Part 1 (run prefix s3a, orders 0..5)

### Slice 0: retire Chats and Smart Groups trees, single browsing surface. Issue #78

- Goal: the org panel becomes the only browsing surface; the Archive tree and settings
  editor tab survive until part 2 ships their in-panel replacements.
- Ships: package.json drops `claudeNest.flat` and `claudeNest.smartGroups` (views,
  viewsWelcome, menus, activation events); extension.ts stops constructing them;
  tree-context-only commands hidden from the palette; linkToChat/unlinkChat/
  exportLibrary/importLibrary/showTokenRollup stay palette-callable; providers with
  remaining consumers (project-key resolution, rollup seam, link pick list) become
  non-view services, the rest are deleted with tests updated; schema and data untouched.
- Modules: package.json, src/extension.ts, src/views/flatProvider.ts,
  src/views/smartGroupsProvider.ts, src/commands/promoteSmartGroup.ts (palette
  visibility), affected unit tests.
- Manual smoke: only Organize (and Archive, for now) render; palette shows no orphaned
  tree commands; folders/tags/star/archive still work from the panel.
- Skill fields: id `s3a-view-consolidation`, order 0, issue 78.

### Slice 1: visual fidelity harness and reference screenshots. Issue #79

- Goal: give build and review agents eyes; the missing piece behind Sprint 2's fidelity
  failure.
- Ships: `scripts/fidelity/harness.html` hosting the REAL media/orgPanel.js and .css
  with a stubbed acquireVsCodeApi and synthetic mock data (all sections, colored folders
  and tags, unread dot, question badge, starred row); `npm run fidelity` screenshots the
  harness AND `media/design/ChatSidebar.html` at 320px via headless Chrome/Edge into
  `.claude-working/fidelity/` (gitignored), failing loudly when no browser exists;
  committed prototype reference shots under `media/design/reference/`; ARCHITECTURE.md
  documents the loop; harness excluded from the VSIX.
- Modules: scripts/fidelity/ (new), package.json (script), .vscodeignore,
  ARCHITECTURE.md.
- Manual smoke: run `npm run fidelity`; both PNG sets exist and open.
- Skill fields: id `s3a-visual-harness`, order 1, issue 79, visualCheck
  `npm run fidelity`.

### Slice 2: design-token shell, toolbar, sort popover, search visuals. Issue #80

- Goal: the panel chrome matches the handoff before any row work.
- Ships: tokens from media/design/README.md as CSS custom properties (panel `#FCFBF8`,
  accent `#d97757`, borders, text scale, radii, shadows; theme variables out); toolbar
  (New session pill LEFT, spacer, gear, sort popover with exactly Newest first default /
  Oldest first / Name A-Z and an accent checkmark); New session wired best-effort to the
  `claude-vscode.*` commands or URI handler with a graceful failure toast and the probe
  recorded in DECISIONS.md; the search input per spec with the orange focus glow and
  clear button (behavior may stay title-filter until slice 5); sections scaffolded in
  order STARRED / QUESTIONS / FOLDERS / UNSORTED with spec headers, Starred/Questions
  hidden when empty, Unsorted always present; the Archived (N) bottom row (opens the
  existing Archive view until part 2); Newsreader bundled locally; density modes REMOVED
  (UI and persisted state); sort persisted locally and applied to every list.
- Modules: media/orgPanel.css (rewrite), media/orgPanel.js, src/views/orgPanelWebview.ts,
  src/views/orgPanelModel.ts (section order/toggles), media/fonts/ (new),
  package.json (font packaging), DECISIONS.md.
- Manual smoke: panel renders the warm light design on a dark theme; sort popover works;
  New session opens a new Claude chat or toasts gracefully; focus glow matches the demo.
- Skill fields: id `s3a-design-shell`, order 2, issue 80, visualCheck `npm run fidelity`.

### Slice 3: chat row anatomy, read state, question badge, unread dot. Issue #81

- Goal: rows match the handoff exactly and the new read-state semantics land.
- Ships: the full row anatomy (status slot, title, tag pills, tabular relative time
  35m/3h/1d/2w/1mo, star toggle, exact paddings/indents/colors, hover `#F0EEE6`, active
  `#F6E5DB` + inset accent border as the ONLY tint); the per-row token badge REMOVED;
  the local read-state store (per-device lastSeenAt, Memento, never synced) with its
  clear triggers (open via Nest, named-tab focus, newer user message); Questions
  reworked to "unread assistant turn that asks" with the blinking `?` badge (static
  under prefers-reduced-motion) and folder breadcrumb; the solid dot for unread
  non-question assistant turns; the old lastMessageRole heuristic replaced everywhere.
- Modules: media/orgPanel.{js,css}, src/views/orgPanelModel.ts,
  src/views/relativeTime.ts, src/store/readState.ts (new, vscode-thin),
  src/model/questionHeuristic.ts (new, vscode-free, unit-tested), src/extension.ts
  (tab-focus listener), affected tests.
- Tests: questionHeuristic (asks vs statement, tail-window, garbage tolerance);
  readState (set/clear triggers, never-synced guard); relativeTime new format table.
- Manual smoke: unread reply shows a dot, question shows blinking `?`; opening the chat
  clears both; starred row not tinted; time column matches the mock.
- Skill fields: id `s3a-row-anatomy`, order 3, issue 81, visualCheck `npm run fidelity`.

### Slice 4: folder tree, color picker, popovers, drag-and-drop. Issue #82

- Goal: the folder experience matches the handoff.
- Ships: folder rows (chevron, color-filled folder SVG default `#C2A56E`, counts with
  subfolder rollup); click expand, double-click inline rename, right-click 8-swatch
  color picker; FOLDERS header `+` popover (name, Create/Cancel) and collapse-one-level
  control (deepest-first, then re-expand-all); one visible sublevel with deeper legacy
  folders clamped at depth 2 (data preserved, creation capped); DnD drop highlight
  `#FAE6DC` + inset accent ring, drop on UNSORTED clears the folder, dropReducer frozen.
- Modules: media/orgPanel.{js,css}, src/views/orgPanelModel.ts,
  src/views/orgPanelCollapse.ts, src/dnd/webviewDropAdapter.ts (target additions only),
  src/model/folderTree.ts (depth clamp helper), affected tests.
- Manual smoke: per the issue #82 checklist (rename, color, counts, popovers, DnD).
- Skill fields: id `s3a-folder-tree`, order 4, issue 82, visualCheck `npm run fidelity`.

### Slice 5: full-text search, snippets, tag chips, N RESULTS. Issue #83

- Goal: the top search box and chips behave per the handoff.
- Ships: search over titles AND bodies via the existing MiniSearch index; body-only
  matches show the role-prefixed one-line snippet; tag chips with spec states, toggling,
  multi-select AND-combined with search; any filter swaps sections for a flat
  `N RESULTS` list with breadcrumbs; debounced, non-blocking; every interpolation
  escaped (security lens checks the render-site class).
- Modules: media/orgPanel.{js,css}, src/views/orgPanelWebview.ts,
  src/views/orgPanelModel.ts, src/search/searchIndex.ts (snippet role prefix),
  affected tests.
- Manual smoke: body-text query surfaces a chat with a `Claude: ...` snippet; two chips
  AND-combine; clearing restores sections.
- Skill fields: id `s3a-search-chips`, order 5, issue 83, visualCheck `npm run fidelity`.

## Part 2 (run prefix s3b, orders 0..3)

### Slice 0: rich hover preview card. Issue #84

- Ships: the floating 270px card (title; folder, age, ~NNk tok line; tag pills; first
  user + last assistant message clamped to 3 lines); hover-stable (130ms leave delay,
  hoverable card); spec shadow; on-demand body read, discarded; replaces the old
  tooltip path; keyboard-accessible equivalent; all content escaped.
- Modules: media/orgPanel.{js,css}, src/views/orgPanelWebview.ts (body-on-demand
  message), src/claude/bodyReader.ts (first/last extraction reuse),
  src/views/chatTooltip.ts (retire from panel), tests for the card model.
- Skill fields: id `s3b-hover-card`, order 0, issue 84, visualCheck `npm run fidelity`.

### Slice 1: right-click context menu. Issue #85

- Ships: the chat context menu (tag toggles with checkmarks; create-new-tag with name
  input + 8-swatch picker; Export as Markdown/JSON via the existing pipeline; Archive
  hidden for starred/archived with the starred note); spec styling; Esc/outside
  dismissal; keyboard operable; host-side validation of every message field.
- Modules: media/orgPanel.{js,css}, src/views/orgPanelWebview.ts,
  src/commands/exportChatCommands.ts (entry reuse), src/commands/curationCommands.ts,
  tests for the menu model and message validation.
- Skill fields: id `s3b-context-menu`, order 1, issue 85, visualCheck `npm run fidelity`.

### Slice 2: Settings overlay and auto-archive engine. Issue #86

- Ships: the full-panel Settings overlay (back chevron, Newsreader heading; keep-window
  select 7d/14d/30d/90d/1y/Never defaulting to the effective Claude cleanupPeriodDays,
  30 if unset; section pill toggles with Unsorted-unreachable protection); the
  auto-archive engine (unstarred chats past the window get userArchived + archivedAt +
  a body copy, batched, on activation and post-scan; first-run notification; starred
  chats exempt but protectively body-copied past the Claude deletion age); the settings
  editor tab RETIRED (settingsWebview + media/settings.*); openSettings opens the
  overlay.
- Modules: media/orgPanel.{js,css}, src/views/orgPanelWebview.ts,
  src/store/autoArchive.ts (new, pure policy + orchestration seam),
  src/store/archiveBodyStore.ts, src/settings/claudeSettingsIO.ts (read
  cleanupPeriodDays), src/extension.ts, package.json, deletions of
  src/settings/settingsWebview.ts and media/settings.*, tests (policy boundaries,
  starred exemption, protective copy, Never).
- Skill fields: id `s3b-settings-overlay`, order 2, issue 86, visualCheck
  `npm run fidelity`.

### Slice 3: Archive overlay; the panel becomes the only view. Issue #87

- Ships: the Archive overlay (gray focus glow search, rows with export + Restore,
  empty states); Archived (N) row wiring; star-unarchives; the Archive tree RETIRED;
  archived-copy preview reachable from the overlay; exactly ONE contributed view
  remains.
- Modules: media/orgPanel.{js,css}, src/views/orgPanelWebview.ts,
  src/views/archiveProvider.ts (retire or reduce to a data service), package.json,
  src/extension.ts, src/commands/curationCommands.ts (star-unarchive), tests.
- Skill fields: id `s3b-archive-overlay`, order 3, issue 87, visualCheck
  `npm run fidelity`.

## Part 3 (run prefix s3c, orders 0..1)

### Slice 0: full-state fidelity sweep. Issue #88

- Ships: harness staging + capture of every UI state (default, filtered, hover card,
  context menu both modes, drag highlight, both overlays, both popovers, rename);
  matching prototype captures; the committed reference set updated; every visible
  mismatch fixed or recorded as an agreed deviation in UI-SPEC.md; visual lens looped
  until dry.
- Skill fields: id `s3c-fidelity-sweep`, order 0, issue 88, visualCheck
  `npm run fidelity`.

### Slice 1: docs rewrite and accessibility closeout. Issue #89

- Ships: TESTING.md rewritten for the one-panel surface (per-slice smoke steps from
  this plan); README/ARCHITECTURE/CHANGELOG reconciled; the full keyboard and ARIA pass
  with gaps fixed; walkthrough media updated or retired.
- Skill fields: id `s3c-docs-a11y`, order 1, issue 89, testCommand `npm test`.

## HUMAN VERIFY GATE (between part 3 and the release run)

Jake installs the part-3 `nest-build-check.vsix` (or a fresh package), runs the new
TESTING.md checklist with `media/design/ChatSidebar.html` open beside VS Code, and
comments the pass (or findings) on #76. Findings become ordinary fix issues/PRs and the
gate repeats. THE RELEASE RUN MUST NOT BE INVOKED WITHOUT THE RECORDED PASS.

## Release run (single slice, after the gate)

### Slice: release v0.2.0. Issue #91

- The run is invoked with `securityCouncil` armed: 10 lenses over the whole sprint diff
  (baseline `e390d0a`, the pre-sprint main head), class-sweep fixes, looped to zero
  actionable, landing with trailer `Nest-Security: sprint-3 (audit)` (issue #90); minors
  filed as a post-release hardening issue.
- Then: version 0.2.0, dated CHANGELOG block, README/TESTING refresh, explicit
  `npx vsce package --no-dependencies -o claude-code-nest-0.2.0.vsix`. The tag and
  GitHub release are owned by the run prompt after the PR is verified on origin/main.
- Skill fields: id `s3r-release`, order 0, issue 91, testCommand `npm run compile`,
  installCheck `npx vsce package --no-dependencies -o claude-code-nest-0.2.0.vsix`.

---

## args per run (handed to nest-slice-build)

Common: `"planDoc": "SPRINT-3-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3,
"councilMinConfidence": 0.6`.

### Part 1

```json
{
  "planDoc": "SPRINT-3-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "slices": [
    { "id": "s3a-view-consolidation", "order": 0, "issue": 78, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s3a-visual-harness",     "order": 1, "issue": 79, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3a-design-shell",       "order": 2, "issue": 80, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3a-row-anatomy",        "order": 3, "issue": 81, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3a-folder-tree",        "order": 4, "issue": 82, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3a-search-chips",       "order": 5, "issue": 83, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" }
  ]
}
```

### Part 2

```json
{
  "planDoc": "SPRINT-3-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "slices": [
    { "id": "s3b-hover-card",       "order": 0, "issue": 84, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3b-context-menu",     "order": 1, "issue": 85, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3b-settings-overlay", "order": 2, "issue": 86, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3b-archive-overlay",  "order": 3, "issue": 87, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" }
  ]
}
```

### Part 3

```json
{
  "planDoc": "SPRINT-3-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "slices": [
    { "id": "s3c-fidelity-sweep", "order": 0, "issue": 88, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix", "visualCheck": "npm run fidelity" },
    { "id": "s3c-docs-a11y",      "order": 1, "issue": 89, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" }
  ]
}
```

### Release run (ONLY after the recorded human pass on #76)

```json
{
  "planDoc": "SPRINT-3-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "securityCouncil": { "beforeSliceId": "s3r-release", "issue": 90, "maxRounds": 3, "baselineRef": "e390d0a", "trailerId": "sprint-3", "changeSetLabel": "Sprint 3" },
  "slices": [
    { "id": "s3r-release", "order": 0, "issue": 91, "testCommand": "npm run compile", "installCheck": "npx vsce package --no-dependencies -o claude-code-nest-0.2.0.vsix" }
  ]
}
```

## Notes for the build engine (not blockers)

- Slice s3a-visual-harness must land before any visualCheck slice runs; the order
  enforces this. If `npm run fidelity` cannot find a headless browser on the machine,
  the visual lens reports that loudly instead of passing silently.
- The webview rewrite is large; media/orgPanel.js may be split into modules if the
  fit review prefers, but the CSP/nonce pattern and the message validation boundary in
  orgPanelWebview.ts are load-bearing and must survive.
- The Archived (N) row targets the Archive tree until s3b-archive-overlay replaces it;
  do not delete the tree early.
- Retirements must sweep package.json contributions completely (Sprint 2 left orphaned
  refresh commands; see #69).
- The release tag and GitHub release are owned by the run prompt after the s3r-release
  PR is verified on origin/main, exactly like Sprint 2.
