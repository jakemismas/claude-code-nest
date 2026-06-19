# Claude Code Nest: Sprint 2 Slice Plan (v0.1.0)

Eight dependency-ordered vertical slices extending the shipped v0.0.1 extension, each
leaving the extension installable and working, each landing as its own PR that closes its
GitHub issue. This is the build contract for the autonomous run. ARCHITECTURE.md holds the
binding design rules and is updated by each slice that changes a contract; DECISIONS.md
records autonomous design calls; CHANGELOG.md records the per-slice landing; FEATURES.md is
the raw source spec and V2-RESEARCH.md the research behind it.

Sprint 2 implements R&D Phase 1: the one additive, read-only reader change (retain message
bodies, tool_use, and usage that jsonlReader.ts currently parses and discards) unlocks
search, rich preview, token badges, files-touched, and content export. The impossible
chat-window features (compact button, in-window transcript renderer and composer, live token
gauge, UI injected into Claude's chat, USD cost) are dropped; see DECISIONS.md.

## UI design reference

The sidebar visual target is `media/mockups/sidebar-mockup.html` (open in a browser for the
Comfortable and Compact frames), distilled to intent in `UI-SPEC.md`. Slices 1, 2, and 6 build
to UI-SPEC.md. Pixel-exactness is a human smoke check (TESTING.md), not an automated gate,
because the build agent cannot see its own rendered webview; the adversarial review must not
churn on cosmetic mismatches it cannot verify.

## How this feeds the build engine

The engine is the workflow at `.claude/workflows/nest-slice-build.js`, surfaced as the
`nest-slice-build` skill. It reads per slice: `id` (kebab-case), `order` (int, contiguous
0..n-1), `issue` (GitHub issue number), `testCommand` (defaults `npm test`), and
`installCheck` (the package proof). The orders are contiguous 0..7; the `s2-` prefix lives in
`id`, so a landing trailer reads e.g. `Nest-Slice: s2-tier-a-reader (0)`. The engine's landing
is PR-per-slice (branch `slice/<id>`, commit as Jake, `gh pr create --base main`, `gh pr merge
--merge --delete-branch`, then `git merge --ff-only origin/main` to sync), and it resumes by
scanning origin/main for `Nest-Slice` trailers. See the run prompt for the exact invocation.

## Universal Definition of Done (per slice)

Per-slice notes below list only the deltas. Every slice must also satisfy:

- tsc --noEmit clean.
- eslint clean (the read-only chokepoint selector bank runs inside lint; pretest runs lint then compile).
- npm test green (headless node + mocha unit suite).
- vsce package succeeds (the install proof; the installCheck command).
- The three-lens-plus-completeness adversarial review comes back dry (no critical or major finding survives the fix-and-reverify loop).
- README feature section and CHANGELOG entry updated.
- ARCHITECTURE.md updated when the slice changes a binding contract (slice 0 tier-A fields; slice 2 search-index location; slice 3 reconcileSync per-scalar LWW; slice 4 archive-as-org-layer plus Nest-owned body copy; slice 6 org-panel-as-primary, the DnD-shell-only contract, and the awaiting-reply heuristic).
- Lands as its own PR with Jake Mismas <jake@jakemismas.com> as author and committer (no AI author or co-author trailer, no generated-by marker), carrying `Nest-Slice: <id> (<order>)` and a `Fixes #<issue>` line so the merge closes the issue, merged to main and verified on origin/main.
- The read-only invariant re-asserted in review of every fs-touching slice (0, 1, 2, 4, 5): nothing writes, renames, moves, or deletes under `~/.claude/projects/`; every fs write goes through the settings chokepoint (src/settings/claudeSettingsIO.ts) or the narrow export-IO module (src/store/exportIO.ts), each behind its runtime `assertNotUnderClaudeProjects` guard.
- The gitignored .nest-build-state.json is never staged.

The manual UI smoke checklist is NOT run during the unattended build (it needs a human in
VS Code). Each slice lists its smoke steps below; they are consolidated into TESTING.md at the
release slice for the user to run after install.

## Test layering

- Unit (headless): node + mocha against out/test/unit/**. Pure logic only; these never import
  the vscode module. This is what `npm test` runs and what the engine's test gate verifies.
- Integration (electron host): @vscode/test-electron under out/test/integration/**. These need
  a VS Code download and a display, so they are deferred to TESTING.md and run by a human or
  CI, never during the unattended build.

## Sprint-wide hard architecture rules (baked into every relevant slice's DoD)

- Tier-A reductions (counts, summed token totals, capped files-touched, truncated first/last
  message, distinct models) ride the scan snapshot; full transcript BODIES are never held in
  the snapshot, only read on demand for one chat and discarded.
- The search index is never synced (never in setKeysForSync) and never written under
  ~/.claude/projects; it lives in extension globalStorage or in memory only.
- Archive is an org-layer flag plus a Nest-owned exported body copy under globalStorage; it
  never renames, moves, or deletes anything under ~/.claude/projects.
- Only curation scalars sync; any new synced scalar MUST be added to reconcileSync's per-field
  merge in the same slice that introduces it.
- Slice 6 must NOT modify src/dnd/dropReducer.ts; only the DataTransfer-extraction shell changes.

---

## Slice 0: tier-A summary reader (read-only, no UI) — issue #17

- **Goal:** extend the one transcript reader to retain a read-only tier-A summary per chat that every later slice reads; render nothing.
- **Ships:** additive, read-only fields on `TranscriptScan` and `ChatRecord`, absorbed by the existing line-type scan and carried through `readChat`: `messageCount` (user/assistant lines); `lastMessageText` (truncated) plus `lastMessageRole` ('user' | 'assistant') for the awaiting-reply heuristic; `tokenTotals` summed from each `message.usage` (input/output/cache, tolerant of absence); `filesTouched` (distinct `file_path` from `tool_use` blocks, deduped and CAPPED like the existing `MAX_LEADING_UUIDS`); `models` (distinct `message.model`). Nothing renders; existing UI and fields unchanged.
- **Modules:** `src/model/types.ts` (add tier-A fields to `TranscriptScan` and `ChatRecord`, all defaulted null/0/[], mirroring the slice-6 signal-field block); `src/claude/jsonlReader.ts` (add absorbers alongside `absorbPrLink`/`absorbGitBranch`/`absorbLeadingUuid`: `absorbMessageCount`, `absorbLastMessage` via the existing `extractMessageText`, `absorbUsage`, `absorbFilesTouched` with a new `MAX_FILES_TOUCHED`, `absorbModel`; preserve skip-unknown-types tolerance); `src/claude/chatScanner.ts` (`readChat` copies the new fields onto the record; no new fs calls).
- **Tests:** `jsonlReader.tierA.test.ts` (messageCount; last-turn text/role; usage sum tolerating garbage; filesTouched dedupe and cap; distinct models; malformed-line tolerance; all-absent defaults). Extend the scratch-fixture scan test to assert the fields ride through `readChat`.
- **Manual smoke:** none (no UI). Confirm the four views render unchanged after install.
- **Skill fields:** id `s2-tier-a-reader`, order 0, issue 17, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 1: lazy body reader, token badge, rich hover preview — issue #18

- **Goal:** read a single chat's full body on demand (never into the snapshot); surface a per-chat ~token badge and a rich hover preview plus the chatsPreview card. Build the badge and preview card to UI-SPEC.md.
- **Ships:** `readTranscriptBodies` (on-demand single-chat body reader, discarded after use); the tier-A token total as a per-chat ~token badge in the row description; a rich `MarkdownString` tooltip built to the binding UI-SPEC.md hover card (folder, relative time/age, ~tokens, full tag set, first/last message snippet) plus models and files-touched count as additive context; the chatsPreview POC card gains the same summary line.
- **Modules:** `src/claude/bodyReader.ts` (new, vscode-free: `readTranscriptBodies(filePath)`, single read, read-only, try/catch like `readChat`; held by no provider); `src/views/chatTooltip.ts` (new, vscode-free: `buildChatTooltip(record, folderName, tags)` returns plain markdown including the folder and the full tag set; provider wraps in `vscode.MarkdownString`); `src/views/flatProvider.ts`, `foldersProvider.ts`, `tagsProvider.ts` (set `TreeItem.description` and `.tooltip`, passing the chat's folder name and full tag set from the metadata the providers already read at the call site; keep memoized nodes, ids, getParent); `src/views/chatsPreviewWebview.ts` + `media/chatsPreview.js` (extend `PreviewRow` and render the summary line; still POC).
- **Tests:** `bodyReader.test.ts` (ordered extraction over scratch fixture; never throws; [] on unreadable); `chatTooltip.test.ts` (full / token-less / multi-model records; asserts the folder and full tag set render; no vscode import).
- **Manual smoke:** hover a chat row; tooltip shows folder, full tag set, tokens, models, files, and snippet; row shows the ~token badge; the Chats (Preview) card shows the summary line.
- **Skill fields:** id `s2-tier-b-body-and-hover`, order 1, issue 18, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 2: full-text content search (MiniSearch, in-memory) — issue #19

- **Goal:** index chat content with MiniSearch and surface matches plus a snippet in the chatsPreview filter box. No embeddings, no SQLite. Surface results per UI-SPEC.md (snippet under the title).
- **Ships:** an in-memory MiniSearch index over tier-A text (title, lastMessageText, filesTouched) plus on-demand bodies; a query in the chatsPreview filter returns matching chats with a highlighted snippet. Index lives in extension globalStorage (serialized for warm starts) or in memory; NEVER registered for sync, NEVER under ~/.claude/projects.
- **Modules:** `package.json` (add `minisearch` runtime dependency; the build agent must `npm install minisearch` before the installCheck, and confirm `vsce package --no-dependencies` still bundles it); `src/search/searchIndex.ts` (new, vscode-free: `buildIndex`, `search` returning {sessionId, score, snippet}, pure snippet builder); `src/search/searchStore.ts` (new, vscode-thin: persist/load via exportIO to globalStorageUri only; fall back to in-memory rebuild if cut); `src/views/chatsPreviewWebview.ts` + `media/chatsPreview.js` (filter gains a content-search mode; render ranked rows with snippets).
- **Tests:** `searchIndex.test.ts` (ranked sessionIds; snippet centers and truncates; empty/no-match; no vscode import); a guard test that the store target resolves under globalStorage, never a projects path.
- **Manual smoke:** type a content query; matches show with a snippet; clearing restores the full list.
- **Skill fields:** id `s2-fulltext-search`, order 2, issue 19, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 3: schema curation scalars and reconcileSync per-scalar LWW (no UI) — issue #20

- **Goal:** add new synced curation scalars to the schema AND extend reconcileSync's per-field arbitration to cover them, in the same slice. No UI.
- **Ships:** additive-optional fields, NO `SCHEMA_VERSION` bump: `ChatMeta.starred?`, `ChatMeta.userArchived?` plus `ChatMeta.archivedAt?`, `Folder.color?`. The `mergeProjectMeta` per-scalar LWW (today arbitrating only `folderId`) is EXTENDED to arbitrate `starred`/`userArchived`/`archivedAt` and `Folder.color` by record `updatedAt`. Without this, the new scalars would be wholesale-replaced on a foreign sync write.
- **Modules:** `src/store/schema.ts` (optional fields on `ChatMeta`/`Folder`; extend `normalizeChat`/`normalizeFolder`; keep `SCHEMA_VERSION = 1`; these are nested fields so the `KNOWN_TOP_LEVEL`/`__unknown` escrow is unaffected, assert in review); `src/store/exportImport.ts` (extend the per-chat scalar LWW near the `folderId` arbitration; add `Folder.color` to the folder merge; extend conflict accounting); `src/store/reconcileSync.ts` (no signature change; it delegates to `mergeProjectMeta`; update the doc comment to name the new scalars); `src/store/metadataStore.ts` (add `setChatStarred`/`setChatArchived`/`setFolderColor` that stamp updatedAt/deviceId and coalesce into the existing pending write).
- **Tests:** `schema.test.ts` (round-trip and normalize of new optionals; absent default; older doc migrates with no version bump); `exportImport.merge.test.ts` (LWW picks newer scalar by updatedAt; tag/link union unchanged; concurrent same-scalar reported); `reconcileSync.test.ts` (foreign write that flipped `starred` reconciled additively, not wholesale-replaced).
- **Manual smoke:** none (store behavior fully headless-covered).
- **Skill fields:** id `s2-schema-scalars-and-lww`, order 3, issue 20, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 4: star and user-archive, Archive view, Nest-owned body copy — issue #21

- **Goal:** let the user star/archive chats, browse an Archive view, restore, and keep a Nest-owned exported body copy so archived chats survive Claude's cleanup, without touching ~/.claude/projects.
- **Ships:** star/unstar and archive/unarchive commands writing the slice-3 scalars through the store; an Archive TreeView listing `userArchived` chats; a Restore command (clears the flags); a configurable keep-window (7d..never) governing when a body copy is taken/pruned, with STARRED chats exempt from pruning; on archive, a Nest-owned copy of the full body exported via exportIO to globalStorage (LOCAL, not synced) so the chat survives Claude's cleanup. NEVER renames/moves/deletes under ~/.claude/projects.
- **Modules:** `src/commands/curationCommands.ts` (new: STAR/UNSTAR/ARCHIVE/RESTORE; deps mirror folderCommands; reads body via bodyReader, writes via the archive store); `src/store/archiveBodyStore.ts` (new, vscode-thin: write/read/prune the body copy under globalStorageUri via exportIO only); `src/store/archiveRetention.ts` (new, vscode-free: pure policy {archivedAt, starred, keepWindowDays, now} -> keep|prune); `src/views/archiveProvider.ts` (new: TreeDataProvider over archived chats; memoized snapshot; synchronous getChildren/getParent; getChildren(undefined) returns [] with a viewsWelcome empty state, never throws); `package.json` (contribute `claudeNest.archive`, the four commands plus menus, and the keepWindow setting); `src/extension.ts` (register the view, no DnD controller, and the commands with refresh + scheduleAutoExport); `ARCHITECTURE.md` (document archive-as-org-layer plus Nest-owned body copy; re-assert the no-projects-mutation invariant).
- **Tests:** `archiveRetention.test.ts` (starred always kept; never-window keeps all; 7d prunes only past-window unstarred; boundary case); a guard test that the body target is under globalStorage and `assertNotUnderClaudeProjects` throws on a projects path; archiveProvider via the existing provider-shape unit pattern (no vscode).
- **Manual smoke:** star a chat (exempt badge); archive a chat (leaves active lists, appears in Archive, body copy on disk under globalStorage); delete the underlying transcript out of band and confirm the archived copy still reads; Restore returns it; confirm nothing under ~/.claude/projects changed.
- **Skill fields:** id `s2-star-archive`, order 4, issue 21, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 5: per-chat export to Markdown and JSON, token rollup — issue #22

- **Goal:** export one chat to Markdown/JSON (org layer in front-matter) through the exportIO chokepoint; roll up token cost by folder and tag (tokens only, no USD).
- **Ships:** an Export Chat command offering Markdown or JSON; the file carries front-matter / a header with the org layer (folder, tags, starred, links, models, token total) and the body from bodyReader; a cost-by-folder and cost-by-tag token rollup summing tier-A `tokenTotals` (tokens only, NO USD). The rollup is the FIRST thing to cut if time is short; export ships first.
- **Modules:** `src/export/chatExport.ts` (new, vscode-free: `renderMarkdown(record, body)` / `renderJson(record, body)` pure formatters); `src/commands/exportChatCommands.ts` (new: EXPORT_CHAT; save dialog picks the target; body via bodyReader; write via exportIO.writeTextFile with the runtime guard); `src/rollup/tokenRollup.ts` (new, vscode-free: `rollupByFolder`/`rollupByTag` pure reducers); `package.json` + `src/extension.ts` (contribute and register).
- **Tests:** `chatExport.test.ts` (Markdown front-matter plus body; JSON shape; no-body and multi-tag; round-trippable JSON); `tokenRollup.test.ts` (per-folder and per-tag sums; unfiled/untagged buckets; a chat counted once per its single folder, once per each tag).
- **Manual smoke:** export to Markdown (front-matter shows org layer); to JSON; open the rollup and confirm totals match member chats; confirm an export aimed into ~/.claude/projects is refused by the guard.
- **Skill fields:** id `s2-export-and-rollup`, order 5, issue 22, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 6: org-panel webview migration (primary view) — issue #23

- **Goal:** promote the chatsPreview POC to the PRIMARY org panel (sections, chips, sort, density, folder color, rename, drag-to-unfile, webview DnD reusing the pure dropReducer) and retire the native Folders/Tags trees while keeping the flat Chats tree as the accessible fallback. Largest slice, last before release. Build to UI-SPEC.md; the visual target is media/mockups/sidebar-mockup.html.
- **Ships:** a primary org-panel WebviewView (CSP-locked, nonce-scripted) with sections Starred (slice-3 flag), Questions (the scan-time awaiting-reply heuristic from slice-0 `lastMessageRole === 'user'`, LABELLED a heuristic, NOT live), plus folders/tags; tag filter chips; sort; density modes; per-folder color (slice-3 `Folder.color`); double-click rename; drag-to-unfile; webview drag-and-drop reusing the UNCHANGED `reduceDrop` (only the extraction shell changes). Accessibility and keyboard nav are ACCEPTANCE CRITERIA (focus order, ARIA roles, Enter/Space activation, arrow navigation). Native Folders/Tags trees retired; flat Chats TreeView KEPT as accessible fallback.
- **Modules:** `src/views/orgPanelWebview.ts` (new, primary; supersedes chatsPreviewWebview); `src/views/orgPanelModel.ts` (new, vscode-free: `buildSections(records, meta)` including the heuristic); `src/dnd/webviewDropAdapter.ts` (new, vscode-thin: extract {payloadMime, sourceChatIds, targetView, targetId} from the drop message, call the UNCHANGED `reduceDrop` in src/dnd/dropReducer.ts, apply intents as N store calls plus one flush plus one refresh); `media/orgPanel.{js,css}` (DnD shell, chips, sort, density, rename, keyboard, ARIA); `src/extension.ts` (register org panel as primary; retire foldersView/tagsView createTreeView and their dead DnD controllers; keep flatView; keep the folder/tag/link/promote commands); `package.json` (re-point the primary view; remove retired tree views; keep claudeNest.flat); `ARCHITECTURE.md` (document org-panel-as-primary, the DnD-shell-only contract, the scan-time heuristic, the flat-tree fallback).
- **Tests:** `orgPanelModel.test.ts` (section assembly; heuristic flags only lastMessageRole === 'user'; per-folder color carried; empty sections render); the webview DnD shell is covered by the EXISTING dropReducer unit tests (reducer unchanged) plus a small adapter-extraction test mapping a webview message to a correct DropInput.
- **Manual smoke:** org panel is primary with Starred and Questions (heuristic-labelled) sections; chips filter; sort and density work; a folder shows its color; double-click renames; dragging to empty space unfiles; full keyboard nav and screen-reader labels work; the flat Chats tree still works; old Folders/Tags trees gone.
- **Skill fields:** id `s2-org-panel-webview`, order 6, issue 23, testCommand `npm test`, installCheck `npx vsce package --no-dependencies -o nest-build-check.vsix`.

## Slice 7: release v0.1.0 — issue #24

- **Goal:** cut the Sprint 2 release.
- **Ships:** a `package.json` version bump to 0.1.0; a dated CHANGELOG block covering slices 0..6; a README and TESTING.md refresh (the consolidated manual smoke checklist drawn from every slice above); a `vsce package` of the final VSIX. After this slice's PR is verified on origin/main, the run prompt owns `git tag v0.1.0` and `gh release create v0.1.0 ./claude-code-nest-0.1.0.vsix` with notes from the new CHANGELOG block.
- **Modules:** `package.json` (version), `CHANGELOG.md` (dated block plus a fresh empty Unreleased), `README.md`, `TESTING.md`; no src changes expected.
- **Tests:** npm test stays green (no new logic); the install proof is the package step. Note: the repo's `npm run package` script hardcodes nest-build-check.vsix, so the release uses the explicit `vsce package -o claude-code-nest-0.1.0.vsix` form.
- **Manual smoke:** install the VSIX from the release into a clean VS Code and run the consolidated checklist.
- **Skill fields:** id `s2-release`, order 7, issue 24, testCommand `npm run compile`, installCheck `npx vsce package --no-dependencies -o claude-code-nest-0.1.0.vsix`.

---

## args.slices (handed to nest-slice-build)

```json
{
  "slices": [
    { "id": "s2-tier-a-reader",          "order": 0, "issue": 17, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-tier-b-body-and-hover",  "order": 1, "issue": 18, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-fulltext-search",        "order": 2, "issue": 19, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-schema-scalars-and-lww", "order": 3, "issue": 20, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-star-archive",           "order": 4, "issue": 21, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-export-and-rollup",      "order": 5, "issue": 22, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-org-panel-webview",      "order": 6, "issue": 23, "testCommand": "npm test",        "installCheck": "npx vsce package --no-dependencies -o nest-build-check.vsix" },
    { "id": "s2-release",                "order": 7, "issue": 24, "testCommand": "npm run compile", "installCheck": "npx vsce package --no-dependencies -o claude-code-nest-0.1.0.vsix" }
  ]
}
```

## Notes for the build engine (not blockers)

- Preflight requires contiguous orders 0..7; this sprint uses exactly that. The s2- prefix is in `id`.
- Slice 2 adds the `minisearch` runtime dependency; `npm install minisearch` before the installCheck or `--no-dependencies` packages a broken require.
- Slice 6 must NOT modify src/dnd/dropReducer.ts; the fit review should reject any proposal that changes the reducer rather than the extraction shell.
- The release tag and GitHub release (the only steps outside a slice) are owned by the run prompt after slice 7's PR is verified on origin/main.
