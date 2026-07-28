# Claude Code Nest: Sprint 4 Slice Plan, "Sweep" (v0.2.1)

A bug-fix, security-hardening, and code-condensing sprint over the shipped v0.2.0
extension. No new features. Every slice is driven by verified review findings from a
12-lens adversarial review fleet (plus verification passes) run against main at
`1e860cb`, folded together with the open backlog (#59, #133, #134). This file is the
build contract for the autonomous runs; the findings register (appendix) is the
canonical finding-to-slice mapping, and each slice's GitHub issue carries the
per-finding detail as acceptance criteria. Parent issue: #137.

Sprint 4 runs as TWO engine parts plus a gated release run, one build chat each:

- Part 1 (prefix `s4a-`, orders 0..5): bug and security fixes.
- Part 2 (prefix `s4b-`, orders 0..5): condensing, removals, and the docs closeout.
- HUMAN VERIFY GATE: no release run until Jake installs the part-2 VSIX, runs the
  TESTING.md smoke checklist, and records the pass as a comment on #137.
- Release run (single slice `s4r-release`): the security council armed over the
  sprint diff (baseline `1e860cb`), then version 0.2.1, tag, and the GitHub release.
  Issue #151; council issue #150.

Orders are contiguous from 0 per part; exact-id trailer matching keeps parts from
colliding with each other and with prior sprints.

## Review upgrades in force this sprint (from the Sprint 3 retrospective)

1. TRAILER INTEGRITY GATE. Twice in Sprint 3 the engine emitted `Fixes #N` beside the
   `Nest-Slice` trailer, breaking git trailer parsing so preflight read a merged slice
   as unbuilt (repairs #113 -> #114, and the earlier s3b repair). This sprint the work
   commit must carry the trailer as a sole, well-formed trailer block (blank line
   before it, nothing else in the block except `Fixes #N` formatted as a proper
   trailer line), and after each merge the run verifies
   `git log -1 --format=%(trailers:key=Nest-Slice,valueonly)` returns the id before
   declaring the slice landed. A parse failure is a halt, not a warning.
2. FORMALIZED HALT SALVAGE. Sprint 3 died twice on session limits mid-slice. The
   recovery that worked is now the standard: on resuming any halted run, first inspect
   partial state (git status, branch, trailer of HEAD), then run a five-lens salvage
   verify (correctness, class-sweep, read-only/data-integrity, acceptance-criteria,
   landing-safety) over any uncommitted or unlanded work BEFORE landing it.
3. FINDINGS-BASED ACCEPTANCE CRITERIA. Every slice issue enumerates its findings as
   checkboxes with file:line. The completeness critic audits checkbox by checkbox; an
   unaddressed finding without a recorded fix-by-removal or defer note is a major.
4. FIX-BY-REMOVAL DISCIPLINE. A Part 1 fix slice may skip a finding ONLY when this
   plan maps it to a Part 2 removal (register column "Resolution"). The Part 2 slice
   then owns the finding's checkbox.
5. DOCS-REALITY LENS. The review found two subsystems documented as live that never
   ran. Reviewers on every slice check that ARCHITECTURE.md claims touched by the
   slice match actual wiring; a doc claiming dead code is live (or vice versa) is a
   major on the docs-closeout slice and a minor elsewhere.

## Sprint-wide hard rules

- The read-only invariant on `~/.claude/projects/` is unchanged and re-asserted on
  every fs-touching slice; every fs write goes through the exportIO chokepoint behind
  `assertNotUnderClaudeProjects`.
- `src/dnd/dropReducer.ts` stays frozen. Deleting the RETIRED native-tree DnD modules
  (s4b-retire-dnd) does not touch the reducer or the live webviewDropAdapter path.
- No new synced scalars; no SCHEMA_VERSION bump unless s4a-sync-reconcile's escrow
  decision (from #134) explicitly records one in DECISIONS.md.
- Removals sweep the WHOLE surface: package.json contributions, activation events,
  registrations, exports, tests, and doc references. An orphaned registration or a
  stale doc claim about a removed module is a major finding.
- Every superseded keep-decision gets a dated DECISIONS.md entry naming the decision
  it supersedes. The four recorded keeps being superseded are listed in the register.
- No visual redesign this sprint. The fidelity harness is not a gate on any slice;
  slices touching media/orgPanel.js preserve rendered behavior except where a finding
  says otherwise.
- The engine state file is never staged; no scratch files under src/.

## Universal Definition of Done (per slice)

- tsc clean, eslint clean, npm test green (pretest runs lint + compile).
- `npx vsce package --no-dependencies -o nest-build-check.vsix` succeeds.
- Adversarial review (4 lenses + completeness critic over the issue's AC checkboxes)
  comes back dry: no critical or major finding.
- CHANGELOG.md entry per slice; ARCHITECTURE.md updated when a binding contract
  changes (mandatory on every s4b removal slice).
- Lands as its own PR, author and committer Jake Mismas <jake@jakemismas.com>, no AI
  attribution, carrying `Nest-Slice: <id> (<order>)` and `Fixes #<issue>` per the
  trailer integrity gate above.

## Test layering

Unchanged: headless node + mocha unit tests are the engine gate; electron-host
integration checks defer to TESTING.md. Part 2 DELETES ~1,000 lines of tests that
exercise removed modules; the docs-closeout slice regenerates TESTING.md from this
plan's Manual smoke sections.

---

## Part 1 (run prefix s4a, orders 0..5): bug and security fixes

### Slice 0: archive-copy durability. Issue #138

- Goal: the Nest-owned archive copy actually survives everything it promises to.
- Ships: cross-project prune backstop (S01: isArchivedCopyLiveProtected iterates all
  project keys, force-keeping any copy whose chat is userArchived or starred in ANY
  project, not just the open workspace); a copy-retry lane for archived chats with no
  copy while the transcript still exists (S02); cleanupPeriodDays=0 no longer
  disables the starred protective-copy pass (F40); the Archive overlay Export button
  works on copy-only rows via an archived-copy export path, or is disabled with a
  reason, never a silent no-op (F07); the archivedRows post no longer re-opens a
  closed overlay or steals focus, and openArchive no longer flashes a false
  "Nothing archived" empty state (F29); isUnderArchiveDir tightened to fully
  canonical comparison (F26).
- Modules: src/extension.ts (backstop), src/store/autoArchivePolicy.ts,
  src/store/autoArchiveEngine.ts, src/store/archiveBodyStore.ts,
  src/views/orgPanelWebview.ts, src/commands/exportChatCommands.ts,
  media/orgPanel.js, affected tests.
- Tests: cross-project force-keep; retry-lane decision table; window=0 protective
  copy; export-archived-copy formatter path; overlay open/refresh state machine.
- Manual smoke: archive a chat, delete its transcript copy of the .jsonl in a scratch
  fixture, Export from the overlay produces the copy's content; Restore then Escape
  during the round-trip does not reopen the overlay.
- Skill fields: id `s4a-archive-durability`, order 0, issue 138.

### Slice 1: sync and reconcile correctness. Issue #139

- Goal: close the remaining data-loss and quiescence gaps the Sprint 3 audit left.
- Ships: quiescence fix for #133 (storeChanged compares content modulo the
  project-level updatedAt/deviceId stamp); pending-chain divert folds the foreign
  merge into newer pending entries so a chain rooted on an in-flight value cannot
  blind-write over it (S03); shadow finalize writes the value the pass actually
  classified instead of a raw post-await re-read, plus a single-flight guard on
  reconcileAllProjects (S04); import persist gate measures merged-vs-raw-store
  (storeChanged rule) instead of result.changed (S05); coerceShadow validates
  meta.chats/folders/tags and degrades to first-sight adopt instead of throwing
  (S06); reconcileAllProjects call sites get error handling (F42); #134 remainder:
  normalizeFolder gates parentId with isSafeRecordId, and the restoredAt escrow
  question is DECIDED and recorded in DECISIONS.md (fix, bump, or accepted floor).
  Note #134's targetChatId gate already landed in e9a7c2f.
- Modules: src/store/metadataStore.ts, src/store/reconcileSync.ts,
  src/store/schema.ts, src/commands/exportImportCommands.ts, affected tests.
- Tests: two-device quiescence simulation reaching a fixed point; the divert-fold
  interleave; shadow finalize under a mid-pass foreign write; corrupt-shadow degrade.
- Manual smoke: none beyond the unit gate (two-device behavior is simulated).
- Skill fields: id `s4a-sync-reconcile`, order 1, issue 139.

### Slice 2: search correctness. Issue #140

- Goal: search results are never stale, never another project's, never falsely empty.
- Ships: the persisted MiniSearch index is keyed or validated per project and
  staleness-checked before serving (F09); a dropped tier-A reply re-queries instead
  of stranding "No chats match" (F08); typing shows the previous fresh result set or
  a searching state, never a false 0 RESULTS flash (F32); the persisted-index
  envelope gains an integrity/shape check (F18); SearchRow stops posting the five
  fields the client never reads (F34).
- Modules: src/search/searchStore.ts, src/search/searchIndex.ts,
  src/views/orgPanelWebview.ts, media/orgPanel.js, affected tests.
- Tests: wrong-project index rejected; stale index rejected or rebuilt; race-window
  re-query; renderFiltered pending-state table.
- Manual smoke: switch between two projects and search immediately in each; type a
  query letter by letter watching for empty-state flashes.
- Skill fields: id `s4a-search-correctness`, order 2, issue 140.

### Slice 3: panel and model fixes. Issue #141

- Goal: the remaining verified webview and pure-model defects.
- Ships: null-timestamp unread clears on markSeen (F31); aria-level uses treeDepth
  not the clamped render depth (F30); star toggle posts intent against current state
  or debounces double-toggle (F33); rollupByTag routes all-dangling-tag chats to
  Untagged (F35); keysMatch stops whole-key case-insensitive comparison for
  driveless paths (F36); asksSomething stops flagging '?' inside URLs (F37); a
  degraded sections post no longer wipes the persisted collapsed set (F44); focus is
  restored to the active row after mutation re-renders (F46); double-click no longer
  posts 'open' twice (F47); the read-state clear trigger for a reply landing in the
  already-focused tab is fixed best-effort or recorded as an accepted gap in
  DECISIONS.md (F45).
- Modules: src/views/orgPanelModel.ts, media/orgPanel.js, src/rollup/tokenRollup.ts,
  src/claude/projectKeyResolver.ts, src/model/questionHeuristic.ts,
  src/extension.ts, affected tests.
- Tests: each model fix gets its table (null-timestamp clear, dangling-tag rollup,
  keysMatch cases, URL question heuristic); collapsed-set survival on degraded post.
- Manual smoke: star/unstar rapidly; double-click a row; rename a folder and confirm
  keyboard focus lands back on it.
- Skill fields: id `s4a-panel-model-fixes`, order 3, issue 141.

### Slice 4: input hardening. Issue #142

- Goal: close every still-open #59 item not owned by a removal, plus the new
  untrusted-input findings.
- Ships: yamlQuote and escapeMarkdownInline escape C0/C1 controls (F03); scan-derived
  titles capped (F04); size caps on whole-file reads with loud skip-reporting for
  oversized transcripts (F05); UNC-spelling bypass of assertNotUnderClaudeProjects
  closed (F13); CSPRNG nonce (F14); webview folderId isSafeRecordId-gated in coerce
  (F15); setFolderColor validates isValidColor at the store sink (F16); export slug
  regex runs after truncation (F20); client color sinks re-validate (F22); models
  list capped (F23); import rejects arbitrary claimed schemaVersion (F27); merge
  unions re-clamped to schema caps deterministically (F28); malformed drop messages
  are rejected instead of defaulting to a folder-unfile (F41).
- Modules: src/export/chatExport.ts, src/claude/jsonlReader.ts,
  src/claude/chatScanner.ts, src/store/exportPathGuard.ts, src/store/metadataStore.ts,
  src/store/exportImport.ts, src/views/orgPanelWebview.ts, media/orgPanel.js,
  src/dnd/webviewDropAdapter.ts, src/commands/exportChatCommands.ts, affected tests.
- Tests: control-char export corpus; oversized-file skip visibility; UNC guard cases;
  coerce/gate tables; import version and cap clamps; drop-message rejection.
- Manual smoke: none beyond the unit gate.
- Skill fields: id `s4a-input-hardening`, order 4, issue 142.

### Slice 5: scan performance. Issue #143

- Goal: stop paying whole-library costs on hot paths.
- Ships: the cwd-probe fallback stops reading every transcript on the machine in full
  on every scan of an unresolved workspace (bounded probe, cached negative) (F38);
  Claude-tab focus no longer triggers a full synchronous rescan, and an explicit
  Refresh runs one scan, not three (F43).
- Modules: src/claude/chatScanner.ts, src/claude/projectKeyResolver.ts,
  src/extension.ts, src/commands/refreshScanCommands.ts, affected tests.
- Tests: probe read bounds; single-scan-per-refresh assertion via injected counters.
- Manual smoke: focus-switch between a Claude tab and the panel on a large library;
  no beachball.
- Skill fields: id `s4a-scan-perf`, order 5, issue 143.

## Part 2 (run prefix s4b, orders 0..5): condensing and removal

### Slice 0: retire the native-tree DnD cluster. Issue #144

- Goal: delete the retired native-tree drag-and-drop stack whole.
- Ships: dndController.ts, dragContext.ts, dropPayload.ts DELETED (D03) with their
  tests dndContract.test.ts, dragContext.test.ts, dropPayload.test.ts (T01, T02) and
  the stash-empty assertion in webviewDropAdapter.test.ts; dropReducer.ts (frozen)
  and webviewDropAdapter.ts untouched; DECISIONS.md entry supersedes the
  ARCHITECTURE.md "kept and unit-tested" keep and the integration-spec
  historical-record keep.
- Modules: src/dnd/{dndController,dragContext,dropPayload}.ts (delete),
  src/test/integration/dndContract.test.ts (delete), src/test/unit tests, ARCHITECTURE.md,
  DECISIONS.md.
- Manual smoke: webview DnD still files and tags chats.
- Skill fields: id `s4b-retire-dnd`, order 0, issue 144.

### Slice 1: retire smart groups and dead command surface. Issue #145

- Goal: delete the dormant smart-group engine and the uninvocable commands.
- Ships: src/smart/** and SmartSignalsInput DELETED with both test files (D04);
  promoteSmartGroup.ts, its test, its two registrations and manifest entries DELETED
  (D06); refreshFolders/refreshTags manifest entries, registrations, and their
  commandSurfaces accepted-list rows DELETED (D09); the leadingMessageUuids absorber
  and ChatRecord field removed from the scan path (gitBranch KEPT for future display,
  recorded); DECISIONS.md entry supersedes the smart-group keep.
- Modules: src/smart/** (delete), src/commands/promoteSmartGroup.ts (delete),
  src/claude/jsonlReader.ts, src/claude/chatScanner.ts, src/model/types.ts,
  src/extension.ts, package.json, src/test/unit/{smartGroupEngine,smartSignals,promoteSmartGroup}.test.ts
  (delete), src/test/unit/commandSurfaces.test.ts, ARCHITECTURE.md, DECISIONS.md.
- Manual smoke: palette shows no promote or refreshFolders/refreshTags entries;
  scans still resolve titles and PR data.
- Skill fields: id `s4b-retire-smart-groups`, order 1, issue 145.

### Slice 2: reduce providers to services. Issue #146

- Goal: the largest removal, executed on the verified safe boundary.
- Ships: foldersProvider/tagsProvider reduced to one service module carrying the five
  live seams (resolveProjectKey, refresh, primeSnapshot + scan machinery, chatRecords,
  tokenTotalsByChat), collapsing tagsProvider's duplicate scan (D05/F11); the
  TreeDataProvider halves, node classes, memoization, getParent/memberNodeForChat
  DELETED; extension.ts and folderCommands/tagCommands signatures simplified off the
  runtime-dead instanceof branches, with a real replacement for the FolderItem
  command-arg adapter at extension.ts:440; linkDecoration.ts DELETED (D08);
  buildChatTooltip: tokenBadge split into its own live module, buildChatTooltip and
  its describes removed per D07/T05 (tokenBadge tests relocated and kept);
  chatStarBadge.test.ts deleted or rewritten against the org-panel model (T04);
  activation.test.ts and tagCommands.test.ts updated; DECISIONS.md entry supersedes
  the s3a non-view-services keep and the buildChatTooltip keep.
- Modules: src/views/{foldersProvider,tagsProvider,linkDecoration,chatTooltip}.ts,
  src/extension.ts, src/commands/{folderCommands,tagCommands}.ts, affected tests,
  ARCHITECTURE.md, DECISIONS.md.
- Manual smoke: folders, tags, star, rollup, link pick list, progress refresh, and
  auto-archive all still work from the panel.
- Skill fields: id `s4b-provider-services`, order 2, issue 146.

### Slice 3: retire the settings write path and orphan reconcile. Issue #147

- Goal: delete the two dead subsystems the docs bill as live.
- Ships: claudeSettingsIO write/protocol half DELETED (writeCleanupPeriodDays,
  computeCleanupPeriodEdit, detectEol, handleSettingsMessage + message types,
  validateCleanupPeriodDays, SettingsIoError, WriteOptions), module shrunk to the
  read path, eslint carve-out comment updated (D02); this RESOLVES F01, F02, F12,
  and F39 by removal; settingsProtocol.test.ts deleted, claudeSettingsIO.test.ts
  pruned to the read half (T03); orphan-reconcile subsystem DELETED: reconcile.ts,
  its test, the three local-document store methods, and the LocalChatState half of
  schema.ts (D01), resolving F17 by removal; scaffold.test.ts deleted (T07); the
  three stale retired-surface comments fixed (T08); ARCHITECTURE.md corrected where
  it documents either subsystem as live; DECISIONS.md records both removals
  (reversible; git history keeps the code).
- Modules: src/settings/claudeSettingsIO.ts, src/store/{reconcile,metadataStore,schema}.ts,
  affected tests, .eslintrc write-ban comments, ARCHITECTURE.md, DECISIONS.md.
- Manual smoke: Settings overlay still reads the effective cleanup window; archive,
  star, folder, tag flows unaffected.
- Skill fields: id `s4b-retire-settings-write-orphan`, order 3, issue 147.

### Slice 4: dedupe, manifest, and packaging. Issue #148

- Goal: collapse verified duplication and fix the manifest.
- Ships: the four roving-focus handler copies collapsed to one helper (F48); the
  getProjectKey-or-bail and flush-then-refresh command patterns extracted (F49); the
  color-picker grid built once (F50); the overlay shell and close-restore pattern
  shared (F51); attachDropTarget/attachChipDropTarget unified (F52); the host
  post-guard and coerce/empty-id boilerplate collapsed (F53, F54); menu items built
  through the existing item() helper (F55); the projectKey-to-meta read idiom
  extracted (F56); the shadow-finalize block deduplicated (F57, after s4a-1 lands
  its correctness fix); dead CSS rule removed (F58); onCommand activation events
  added for createFolder/createTag/showTokenRollup or the engines floor raised, with
  the commandSurfaces gate extended to catch the class (F06); orgPanelInteractions/
  orgPanelCollapse mirrors excluded from the runtime compile or relocated under
  src/test (D10); same-file-only exports de-exported (D11).
- Modules: media/orgPanel.{js,css}, src/views/orgPanelWebview.ts, src/commands/*,
  package.json, tsconfig or compile script, affected tests.
- Manual smoke: color picker, context menu, both overlays, and sort popover all
  behave identically before and after.
- Skill fields: id `s4b-dedupe-manifest`, order 4, issue 148.

### Slice 5: docs closeout. Issue #149

- Goal: the governance docs match the post-sweep reality.
- Ships: ARCHITECTURE.md swept for every removal and stale claim (including the
  prune-backstop wording S01 corrected and the two dead-subsystem sections); README
  feature list reconciled; TESTING.md regenerated from this plan's Manual smoke
  sections; CHANGELOG.md carries the full 0.2.1 Unreleased block; DECISIONS.md
  entries verified present for all four superseded keeps; #59, #133, #134 closed
  with pointer comments once their checkboxes are verifiably fixed on main.
- Modules: ARCHITECTURE.md, README.md, TESTING.md, CHANGELOG.md, DECISIONS.md.
- Manual smoke: none (docs).
- Skill fields: id `s4b-docs-closeout`, order 5, issue 149, testCommand `npm test`.

## HUMAN VERIFY GATE (between part 2 and the release run)

Jake installs the part-2 `nest-build-check.vsix`, runs the regenerated TESTING.md
checklist, and comments the pass (or findings) on #137. Findings become ordinary fix
issues and the gate repeats. THE RELEASE RUN MUST NOT BE INVOKED WITHOUT THE RECORDED
PASS.

## Release run (single slice, after the gate)

### Slice: release v0.2.1. Issue #151

- Invoked with `securityCouncil` armed: the 10 lenses over the whole sprint diff
  (baseline `1e860cb`, the pre-sprint main head), class-sweep fixes, looped to zero
  actionable, landing with trailer `Nest-Security: sprint-4 (audit)` (issue #150);
  minors filed as a post-release hardening issue.
- Then: version 0.2.1, dated CHANGELOG block, README/TESTING refresh, explicit
  `npx vsce package --no-dependencies -o claude-code-nest-0.2.1.vsix`. The tag and
  GitHub release are owned by the run prompt after the PR is verified on origin/main.
- Skill fields: id `s4r-release`, order 0, issue 151, testCommand `npm run compile`,
  installCheck `npx vsce package --no-dependencies -o claude-code-nest-0.2.1.vsix`.

---

## args per run (handed to nest-slice-build)

Common: `"planDoc": "SPRINT-4-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3,
"councilMinConfidence": 0.6`.

### Part 1

```json
{
  "planDoc": "SPRINT-4-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "slices": [
    { "id": "s4a-archive-durability",  "order": 0, "issue": 138, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4a-sync-reconcile",      "order": 1, "issue": 139, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4a-search-correctness",  "order": 2, "issue": 140, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4a-panel-model-fixes",   "order": 3, "issue": 141, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4a-input-hardening",     "order": 4, "issue": 142, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4a-scan-perf",           "order": 5, "issue": 143, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" }
  ]
}
```

### Part 2

```json
{
  "planDoc": "SPRINT-4-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "slices": [
    { "id": "s4b-retire-dnd",                  "order": 0, "issue": 144, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4b-retire-smart-groups",         "order": 1, "issue": 145, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4b-provider-services",           "order": 2, "issue": 146, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4b-retire-settings-write-orphan","order": 3, "issue": 147, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4b-dedupe-manifest",             "order": 4, "issue": 148, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s4b-docs-closeout",               "order": 5, "issue": 149, "testCommand": "npm test", "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" }
  ]
}
```

### Release run (ONLY after the recorded human pass on #137)

```json
{
  "planDoc": "SPRINT-4-PLAN.md", "perSliceFloor": 300000, "maxFixRounds": 3, "councilMinConfidence": 0.6,
  "securityCouncil": { "beforeSliceId": "s4r-release", "issue": 150, "maxRounds": 3, "baselineRef": "1e860cb", "trailerId": "sprint-4", "changeSetLabel": "Sprint 4" },
  "slices": [
    { "id": "s4r-release", "order": 0, "issue": 151, "testCommand": "npm run compile", "installCheck": "npx vsce package --no-dependencies -o claude-code-nest-0.2.1.vsix" }
  ]
}
```

## Notes for the build engine (not blockers)

- Part 1 lands before Part 2 by construction: the fix-by-removal findings (F01, F02,
  F12, F17, F39) are owned by s4b slices, and s4b-dedupe-manifest's F57 dedup builds
  on s4a-sync-reconcile's corrected shadow-finalize shape.
- s4b-provider-services is the L slice; its safe boundary (five seams, the
  extension.ts:440 adapter, the instanceof branches) is verified and recorded in
  issue #146. Do not improvise beyond the boundary.
- Superseding the four recorded keeps REQUIRES the DECISIONS.md entries; the review
  lenses treat a removal without its entry as a major.
- The findings register below is the canonical mapping. Slice issues carry the
  per-finding detail; the raw review JSONs live outside the repo (session scratchpad)
  and are not part of this contract.

---

## Appendix: findings register (id -> slice)

Verified severity after adversarial review. Resolution: fix (Part 1), remove
(Part 2), moot (already fixed on main), refuted (dropped).

| Id | Sev | Slice | Finding |
|---|---|---|---|
| S01 | major | s4a-archive-durability | Prune backstop blind to non-open projects |
| S02 | major | s4a-archive-durability | No copy-retry lane for archived chats |
| F40 | minor | s4a-archive-durability | cleanupPeriodDays=0 disables protective copy |
| F07 | major | s4a-archive-durability | Archive Export silent no-op on copy-only rows |
| F29 | minor | s4a-archive-durability | archivedRows reopens closed overlay; empty-state flash |
| F26 | minor | s4a-archive-durability | isUnderArchiveDir canonicalization (#59) |
| S03 | major | s4a-sync-reconcile | Pending chain blind-writes over drain merge |
| S04 | major | s4a-sync-reconcile | Shadow finalize adopts unclassified foreign write |
| S05 | minor | s4a-sync-reconcile | Import gates persist on changed, not storeChanged |
| S06 | minor | s4a-sync-reconcile | coerceShadow under-validation makes mutate throw (#59 F19) |
| F42 | minor | s4a-sync-reconcile | reconcileAllProjects fire-and-forget errors |
| #133 | major | s4a-sync-reconcile | Reconcile never quiesces (project-stamp churn) |
| #134 | minor | s4a-sync-reconcile | parentId gate + restoredAt escrow decision (AC2 already fixed) |
| F09 | major | s4a-search-correctness | Persisted index served with no project/staleness check |
| F08 | minor | s4a-search-correctness | Refresh-during-search drops reply, no re-query |
| F32 | minor | s4a-search-correctness | Keystroke flashes false 0 RESULTS |
| F18 | minor | s4a-search-correctness | Index envelope integrity (#59) |
| F34 | minor | s4a-search-correctness | SearchRow posts five unread fields |
| F31 | minor | s4a-panel-model-fixes | Null-timestamp chat unread forever |
| F30 | minor | s4a-panel-model-fixes | aria-level uses clamped depth |
| F33 | minor | s4a-panel-model-fixes | Star toggle posts stale state |
| F35 | minor | s4a-panel-model-fixes | rollupByTag drops all-dangling-tag chats |
| F36 | minor | s4a-panel-model-fixes | keysMatch case-insensitive for driveless paths |
| F37 | minor | s4a-panel-model-fixes | Question badge on URLs with query strings |
| F44 | minor | s4a-panel-model-fixes | Degraded post wipes collapsed set |
| F45 | minor | s4a-panel-model-fixes | Edge-triggered read-state clear (best-effort or record gap) |
| F46 | minor | s4a-panel-model-fixes | Focus drops to body after re-render |
| F47 | minor | s4a-panel-model-fixes | Double-click posts open twice |
| F03 | minor | s4a-input-hardening | Control chars pass yamlQuote/escapeMarkdownInline |
| F04 | minor | s4a-input-hardening | No cap on transcript-supplied titles |
| F05 | minor | s4a-input-hardening | Unbounded readFileSync; oversized files vanish |
| F13 | minor | s4a-input-hardening | UNC bypass of assertNotUnderClaudeProjects |
| F14 | minor | s4a-input-hardening | Math.random nonce (#59) |
| F15 | minor | s4a-input-hardening | folderId not gated in coerce (#59) |
| F16 | minor | s4a-input-hardening | setFolderColor no isValidColor at sink (#59) |
| F20 | minor | s4a-input-hardening | Slug regex before truncation (#59) |
| F22 | minor | s4a-input-hardening | Client color sinks no re-validation |
| F23 | minor | s4a-input-hardening | models list uncapped |
| F27 | minor | s4a-input-hardening | Import trusts claimed schemaVersion |
| F28 | minor | s4a-input-hardening | Merge unions exceed schema caps |
| F41 | minor | s4a-input-hardening | Malformed drop defaults to folder-unfile |
| F38 | minor | s4a-scan-perf | cwd-probe reads every transcript in full |
| F43 | minor | s4a-scan-perf | Full rescan per tab focus; 3 scans per Refresh |
| D03 | major | s4b-retire-dnd | Native DnD cluster test-only (515 lines) |
| T01 | major | s4b-retire-dnd | dndContract integration test of retired path |
| T02 | major | s4b-retire-dnd | dropPayload/dragContext tests of unwired modules |
| D04 | major | s4b-retire-smart-groups | Smart cluster test-only (583 lines) + dead tier-A fields |
| D06 | major | s4b-retire-smart-groups | Promote commands uninvocable |
| D09 | minor | s4b-retire-smart-groups | refreshFolders/refreshTags unreachable |
| D05/F11 | major | s4b-provider-services | Provider tree halves runtime-dead (~700 lines) |
| T04 | major | s4b-provider-services | chatStarBadge tests of unrendered icons |
| D07 | minor | s4b-provider-services | buildChatTooltip dead; tokenBadge split |
| T05 | minor | s4b-provider-services | chatTooltip.test prune-partial |
| D08 | minor | s4b-provider-services | linkDecoration dead |
| D01 | major | s4b-retire-settings-write-orphan | Orphan reconcile never wired |
| D02 | major | s4b-retire-settings-write-orphan | Settings write half dead (~450 lines) |
| T03 | major | s4b-retire-settings-write-orphan | settingsProtocol test of retired reducer |
| F01 | minor | s4b-retire-settings-write-orphan | BOM write corruption (moot by removal) |
| F02 | minor | s4b-retire-settings-write-orphan | Create-when-missing clobber (moot by removal) |
| F12 | minor | s4b-retire-settings-write-orphan | Comment-blind indexOf (moot by removal) |
| F17 | minor | s4b-retire-settings-write-orphan | setLocalChatState gate (moot by removal) |
| F39 | minor | s4b-retire-settings-write-orphan | Settings write path dead code |
| T07 | minor | s4b-retire-settings-write-orphan | Vacuous scaffold test |
| T08 | minor | s4b-retire-settings-write-orphan | Stale retired-surface comments |
| F48-F58 | minor | s4b-dedupe-manifest | Duplication and dead-CSS set (11 findings) |
| F06 | minor | s4b-dedupe-manifest | Missing onCommand activation events |
| D10 | minor | s4b-dedupe-manifest | Test mirrors ship in runtime compile |
| D11 | minor | s4b-dedupe-manifest | Same-file-only exports |
| F10 | - | refuted | Empty-bodies poison (fixed in audit round 2) |
| F21 | - | moot | __proto__ escrow (fixed: Object.defineProperty) |
| F24 | - | moot | Import project key gate (fixed: isSafeProjectKey) |
| F25 | - | moot | normalizeLink targetChatId (fixed in e9a7c2f) |

Superseded recorded keeps (all four get DECISIONS.md entries): the s3a non-view
provider-services keep (DECISIONS.md 2026-07-01), the dndController/dragContext keep
(ARCHITECTURE.md), the integration-specs-as-historical-record keep, and the
buildChatTooltip future-consumer keep.
