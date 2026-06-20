# Decisions

Autonomous design decisions made during the unattended build are appended here,
one dated entry per fork: the slice, the fork, the chosen resolution, and the
rationale. Locked decisions from the approved plan live in PLAN.md and
ARCHITECTURE.md and are not relitigated here.

## 2026-06-19 Slice 1 (hover preview): reconcile the PLAN Ships line to the binding UI-SPEC hover card

Fork: SPRINT-2-PLAN.md declares UI-SPEC.md binding for slices 1, 2, and 6, but the
slice 1 per-slice Ships line (and its manual-smoke step) described the hover preview
card as title, relative time, ~tokens, models, files-touched count, and snippet,
omitting the folder and the full tag set that the binding UI-SPEC.md hover card
requires. The first autonomous build followed the narrower Ships line, and the
adversarial completeness review halted slice 1 after three fix rounds on the divergence.

Resolution (autonomous, reversible): the binding spec wins, per the run prompt's
explicit instruction to build slices 1, 2, and 6 to UI-SPEC.md. The slice 1 Ships line,
modules note, manual-smoke step, and test note were reconciled so the hover card
includes folder, age, ~token total, full tag set, and a first/last message snippet;
models and files-touched count remain as additive context. buildChatTooltip takes the
chat's folder name and tag set as plain params (the providers already read both at the
call site), keeping the builder vscode-free. Tracked as issue #34.

Rationale: this is a plan-internal contradiction, not a design choice, so resolving it
in favor of the document the plan itself declares binding is non-discretionary and fully
reversible (a doc edit; the actual hover card is still gated by the slice 1 review and
test gate before it lands). Recorded here per the engine's fork-recording contract
because the contradiction surfaced in post-build review, where the engine has no council
to log it.

## 2026-06-19 Sprint 2 planning: chat-window features dropped as impossible

Fork: the Sprint 2 source spec (FEATURES.md) and its UI mockup include an in-window
chat surface (a context-health bar across the chat, a one-click compact button, a live
"used / 200K" token readout, a tag chips bar beside the session title, and a transcript
plus composer). Resolution: dropped from scope and not planned. V2-RESEARCH.md sections 4
and 5 spike-verified that a third-party extension cannot inject UI into Claude's chat body
or input, cannot read Claude's live webview state, cannot obtain the real session id, and
cannot drive the session (e.g. /compact); a full in-app renderer is explicitly "Don't
build" and an in-panel composer would write into a running session. The honest residue
(a per-chat ~token total computed from the transcript, and tag editing inside Nest's own
panel) is folded into the surviving slices. USD cost is also dropped (needs a maintained
pricing table or a network call that breaks the telemetry-free promise). Rationale: the
read-only invariant and the spike findings are non-negotiable; planning impossible features
would only surface as failed slices.

## 2026-06-19 Sprint 2 planning: one sprint including the webview re-platform

Fork: ship the read-layer expansion (search, preview, token badge, export, star, archive)
alone as v0.1.0 and defer the webview org-panel re-platform to a later sprint, or do both in
one sprint. Resolution: one sprint (user decision), with the webview migration as the last,
heaviest slice (6). Mitigations: slices 0..5 stay independently shippable so a release can be
cut from the read layer if slice 6 slips; the flat Chats TreeView is kept as the accessible
fallback; accessibility and keyboard navigation are acceptance criteria on slice 6, not polish.

## 2026-06-19 Sprint 2 planning: release as v0.1.0, not v2.0

Fork: the release version. Resolution: v0.1.0, a minor bump over the shipped 0.0.1. Rationale:
honest semver for a pre-1.0 extension still stabilizing (a heuristic chat-identity layer and a
known reconcile fragility); 1.0.0 is reserved for when the read-only guarantees are battle-
tested. "Sprint 2" is the release-effort name; V2-RESEARCH.md's "Phase 1/1.5/2" are internal
R&D sub-phases and are not reused as the sprint name.

## 2026-06-19 Engine: auto-resolve reversible design forks (new default)

Fork: when the fit-review council flags a design fork, should the build halt for a human on a
low-confidence judgment, or decide it autonomously? Resolution (user decision, applied as the
nest-slice-build engine default): the council now hard-stops ONLY when the judge marks the fork
irreversible (data loss or a read-only-constraint risk) or the judge agent dies. A reversible
fork proceeds on the judge's best option even at low confidence, and the decision is recorded in
DECISIONS.md with its confidence, low-confidence ones flagged for post-hoc human review.
Rationale: a reversible wrong call is caught by the adversarial review (the read-only-data-
integrity lens is a second backstop) or undone in a later PR, and is visible in the PR diff, so
blocking on it wastes a human round-trip; an irreversible wrong call cannot be cheaply undone and
is reviewed only after it has landed, so it still requires a human. The COUNCIL_MIN threshold is
retained only to flag low-confidence decisions, not to block them. The review-still-dirty-after-3-
rounds halt and the identity and landing halts are unchanged. See .claude/workflows/nest-slice-build.js.

## 2026-06-17 Slice 9 (Polish): progress wraps a synchronous scan on the explicit-refresh path only, and FlatProvider gains the memoized-snapshot shape

Resolution of two build-time decisions the Polish plan and its accepted fit patch
left to the build.

1. PROGRESS/CANCELLATION WITHOUT AN ASYNC getChildren. The fit patch is binding:
   getChildren and getParent stay SYNCHRONOUS (getParent reads the memoized snapshot
   and cannot defer). So the cancellable progress lives on a SEPARATE explicit
   refresh/scan command path, not the passive reveal path. The four Refresh commands
   now call refreshScanCommands.refreshWithProgress, which wraps the scan in
   vscode.window.withProgress with a CancellationToken, primes the provider snapshot
   via a new ScanPrimable.primeSnapshot seam, then fires onDidChangeTreeData once;
   the subsequent passive getChildren reads the primed (synchronous) snapshot without
   rescanning. The scanner (src/claude/chatScanner.ts) stays vscode-free: scanChats
   gained optional plain-callback {onProgress, shouldCancel} that the vscode layer
   supplies, so no vscode import crosses into the scanner or the unit gate.

   HONEST LIMITATION (recorded, not hidden): scanChats reads each transcript with a
   SYNCHRONOUS fs.readFileSync, so the whole scan runs in one synchronous turn. The
   CancellationToken is polled (shouldCancel) before each file and onProgress is
   reported after each, but because the JS event loop is blocked during the
   synchronous scan, a Cancel click cannot be processed mid-scan: cancellation takes
   effect for a re-issued refresh, not for an in-flight synchronous scan, and the
   progress message increments are computed but the notification cannot repaint
   mid-loop. This was chosen over making the scan async (which the fit patch forbids
   for the getChildren/getParent path) and over chunking the scan across microtasks
   (which would change scanChats' contract and risk the snapshot-consistency the
   memoized providers rely on). The progress indicator and the cancellation plumbing
   are present and correct; the constraint is the synchronous reader, and TESTING.md
   Slice 9 step 3 states it plainly rather than overclaiming interruptible cancel.

2. FlatProvider GAINED THE MEMOIZED-SNAPSHOT SHAPE. The other three providers
   already memoized their scan in ensureSnapshot (cached until refresh()); FlatProvider
   alone rescanned on every getChildren. For primeSnapshot to actually cache the
   progress-wrapped scan (so the passive getChildren that follows reads the primed
   records rather than rescanning WITHOUT progress), FlatProvider was refactored to
   hold a records snapshot cleared on refresh() and rebuilt lazily, mirroring the
   established pattern. This is a behavior change for the flat view (it now memoizes
   until an explicit Refresh, like the other three views) and aligns it with the
   slice fit patch's "lazy per-project load ... memoizes until refresh()" claim. The
   empty-state contract is preserved: getChildren still returns [] for a non-root
   element, [] for an absent workspace, and [] on a caught scan failure, and never
   throws.

   The marketplace additions are net-new package.json fields and media assets per
   the fit patch (top-level icon: media/icon.png raster tile, keywords,
   galleryBanner, homepage, bugs, qna, and a contributes.walkthroughs with four
   media/walkthrough/*.md steps); media/nest.svg remains the activitybar
   viewsContainers icon and is NOT used as the gallery tile. No telemetry was present
   to remove; the new error toast is worded to never blame Claude.

## 2026-06-17 Slice 8 (Export/import): write-ban resolution, LWW-per-record interpretation, and the shadow key

Resolution of three build-time forks the plan and the accepted fit patch left open.

1. Write-ban collision. The fit patch offered two resolutions and recommended the
   vscode.workspace.fs path on the claim that it "is not matched by the fs-call
   selectors at all." That claim is FALSE and was disproved by running the lint
   gate: the bank's first selector,
   CallExpression[callee.property.name=/^(writeFile|...)$/], is object-AGNOSTIC,
   so vscode.workspace.fs.writeFile(...) trips it exactly as fs.writeFile(...)
   does (lint failed on src/commands/exportImportCommands.ts line 381 with the
   member-call message). The accepted resolution is therefore the patch's FIRST
   option: all export/import and auto-export snapshot file IO is isolated in a new
   narrow module src/store/exportIO.ts, added to the .eslintrc no-restricted-syntax
   override list alongside src/settings/claudeSettingsIO.ts. exportIO.ts does
   nothing but the vscode.workspace.fs read/write/readDirectory/delete/
   createDirectory primitives and imports NO node fs, so the carve-out stays
   auditable and the command module plus the pure store modules remain under the
   full ban. exportIO.ts never writes under ~/.claude (its targets are a
   user-chosen export path or context.globalStorageUri); the only sanctioned
   ~/.claude write is still claudeSettingsIO.ts behind its path assertion.
   ARCHITECTURE.md's read-only-chokepoint section was updated to record the second
   carve-out and the corrected reasoning.

2. "LWW per scalar field" with no per-field stamp. ProjectMeta carries only a
   per-project updatedAt and a per-ChatMeta updatedAt, never a per-scalar-field
   stamp (architecture and the fit patch confirm this). So the merge implements
   "LWW per scalar field" as: chat folderId is arbitrated by the per-RECORD
   ChatMeta.updatedAt (the only scalar a stamp covers), folders/tags same-id
   conflicts are arbitrated by the document-level updatedAt, and tags/links unions
   are additive and stamp-independent. A tie keeps the live side (local-wins bias,
   consistent with the platform's per-key local-wins sync behavior). A genuine
   differing-NON-NULL folderId on both sides is the irreducible same-scalar
   conflict floor; it is counted per project and surfaced through the honest LWW
   warning. The build did NOT invent a per-field stamp and did NOT bump
   SCHEMA_VERSION, per the patch.

3. The reconcile shadow needed a store. No shadow store existed (Slices 1-7 added
   only globalState meta and nest.local.* orphan keys). reconcileSync.ts defines
   the shadow (the last-seen synced ProjectMeta this device wrote/saw) and the
   diff/detection; MetadataStore gained getSyncShadow/putSyncShadow that persist it
   under SHADOW_KEY_PREFIX = 'nest.shadow.v1' through the existing LOCAL
   (non-synced) write chain. The prefix deliberately does not start with
   META_KEY_PREFIX, so isMetaKey is false and the store never registers the shadow
   for sync (verified by a unit test). MetadataStore also gained allProjectKeys()
   so export-all enumerates every persisted project, including one synced in a
   prior session but not touched this session.

4. Reconcile persist gate: storeChanged, not merge.changed (defect fix, found by
   the slice-8 review). The first build gated the foreign-merge store write on
   ProjectMergeResult.changed, which reports whether the merge differs from its
   BASE. In the reconcile path the base is the SHADOW
   (mergeProjectMeta(shadow, live)), so a foreign value that DROPPED a local-only
   record this device never synced produced merged == shadow (changed:false): the
   write was skipped, the store kept the lossy foreign value, and the shadow was
   then advanced to it, losing the record permanently. Resolution: reconcileProject-
   Sync now reports storeChanged = (merged differs from the live STORE value), and
   reconcileAllProjects gates the write on storeChanged. A foreign subset is always
   written back (the dropped record is restored); a pure-superset foreign write
   (nothing dropped, merged == live) still skips the redundant write via the
   acceptedKeys path. The import path was never affected (its merge base IS the live
   store, so changed already equals storeChanged there). Locked by regression tests
   at the pure and orchestration levels.

## 2026-06-17 Slice 7 (Settings): chokepoint canonicalization, EOL/comma surgical edit, and the mtime injection seam

Resolution: three implementation decisions in the settings slice that the plan and
the accepted fit patch left to the build.

1. PATH CANONICALIZATION (the chokepoint's core guarantee). assertAllowedTarget
   canonicalizes both the allowed path (os.homedir()-anchored settings.json, the
   same anchor chatScanner.defaultProjectsRoot uses) and the candidate via
   path.resolve + path.normalize, then case-folds ONLY the leading drive letter on
   win32 (lowercase position 0 when /^[A-Za-z]:/), exactly the projectKeyResolver
   convention. It deliberately does NOT fs.realpathSync the target: create-when-
   missing is in scope and realpath throws on a nonexistent path. The rest of the
   path stays case-sensitive (the candidate is derived from the same homedir, so a
   case mismatch outside the drive letter is a genuinely different path and must be
   rejected). A dot-segment path like .../projects/../settings.json normalizes to
   the allowed path and is accepted (path.resolve collapses it); a real
   .../projects/x.jsonl target throws. This is the binding read-only guarantee:
   nothing routed through the chokepoint can ever write under ~/.claude/projects/.

2. SURGICAL EDIT SHAPE. The single-key jsonc edit is a byte-range splice computed
   by a small top-level-only, comment- and string-aware scanner (never
   parse-then-stringify). An existing top-level cleanupPeriodDays has only its
   value bytes replaced (siblings, whitespace, comments, key order untouched); a
   value already equal to the request is a no-op that rewrites nothing. When the
   key is absent it is INSERTED AS THE FIRST MEMBER followed by a comma, anchored
   right after the opening brace, so every existing member survives byte-for-byte;
   an empty {} gets the sole member with no trailing comma. EOL is preserved by
   detecting CRLF anywhere in the document and using it for the inserted line. A
   same-named key NESTED at depth > 1 is never matched (the scanner skips whole
   bracketed values and a depthAt re-check confirms depth 1), so a nested
   cleanupPeriodDays does not shadow the top-level insert. Create-when-missing
   writes a minimal LF document containing just the key.

3. MTIME GUARD AND ITS TEST SEAM. The guard re-stats immediately before the write
   and aborts on any change, comparing statSync().mtimeMs (float ms), not the
   second-resolution Date, so a same-second concurrent edit is still caught.
   writeCleanupPeriodDays takes an optional WriteOptions.statMtimeMs injection seam
   (defaulting to fs.statSync(p).mtimeMs), mirroring ScannerOptions / ResolveDeps
   elsewhere. This was chosen over monkeypatching fs.statSync in the test: the fs
   module namespace property is non-configurable (Object.defineProperty throws), so
   an in-place swap is impossible, and a DI seam is the codebase's established
   pattern for making an fs-touching unit deterministic. The atomic temp-write-then-
   rename uses a '.nest-settings-<pid>-<ts>.tmp' sibling and both calls stay inside
   the exempt chokepoint module.

Rationale: ARCHITECTURE.md's "Read-only invariant" pre-staged the eslint carve-out
for src/settings/claudeSettingsIO.ts ahead of this slice; this slice fills that
carve-out with the only write-capable fs calls in src (verified: a write-capable fs
grep over src hits only the chokepoint and the exempt test tree). The fit patch
correctly required canonicalizing WITHOUT realpath and comparing mtimeMs not mtime;
both are implemented as stated. The patch's premise that "no .vscodeignore exists"
was WRONG (one exists), but its conclusion held on inspection: .vscodeignore
excludes src/**, **/*.ts, and out/test/** but not media/**, so the settings.{html,
js,css} assets ship in the VSIX unchanged (confirmed by vsce package output), and
no packaging change beyond the asWebviewUri + localResourceRoots plumbing was
needed. The webview HTML body ships as media/settings.html (the plan's module) and
the module substitutes the per-load nonce, CSP, and asWebviewUri asset URLs into it,
because those cannot be baked into a static file under a CSP that forbids inline
script.

## 2026-06-16 Slice 6 (Smart Groups): four __smart_*__ sentinels and a '::' bucket-id namespace

Resolution: this slice extends the reserved-id space in two ways that the prior
ARCHITECTURE.md / DECISIONS.md id-grammar contract did not cover, and both are
recorded here as binding.

1. RESERVED_SENTINELS (src/model/idFactory.ts) gains four entries:
   '__smart_pr__', '__smart_ticket__', '__smart_branch__', '__smart_fork__'. They
   are the ids of the four Smart Groups signal-group rows. Like '__unfiled__'
   (Slice 2) and '__untagged__' (Slice 3) they are separator-free synthetic-node
   sentinels that live in the same id-space as minted folder/tag ids but are NOT
   mintable; the factory's assertMintableId rejects them so a real folder/tag id
   can never collide with a smart-group row id. The set is the second guard
   alongside the separator rule. They are also re-exported from smartGroupEngine.ts
   (SMART_GROUP_IDS) as defense-in-depth for the view.

2. A new TWO-char '::' bucket-id separator (SMART_BUCKET_SEPARATOR in
   smartGroupEngine.ts) names a smart-group bucket row: '<groupId>::<bucketKey>',
   and the view layers a chat-occurrence row on top as '<bucketNodeId>::<chatId>'.
   This is a NEW namespace sitting beside the three single-char composite-id
   separators the grammar already documents (folder member '#', tag occurrence ':',
   linked-child '>'). '::' is two ':' characters, but it is reserved ONLY under a
   '__smart_*__' group prefix that no other view ever mints, and the smart-group
   view never hands its ids to the single-':' tag-occurrence parser (nor any other
   view's parser), so the namespaces do not collide in practice: a tag occurrence
   id is '<separator-free tagId>:<chatId>' and can never begin with a '__smart_*__'
   sentinel because that sentinel is excluded from the mintable tag-id space.

Rationale: the DoD requires ARCHITECTURE.md (and the decision log) be updated when
a slice changes a binding contract, and the id grammar is the most load-bearing
binding contract in this codebase. The Slice 2 DECISIONS entry documented the
sentinel class as exactly '__unfiled__' / '__untagged__'; leaving the four new
'__smart_*__' sentinels undocumented would let a future reader assume the mintable
exclusion set is closed. The '::' choice was made over reusing a single existing
separator because the smart-group ids are never parsed back into component ids by
the model (the view stores a bucket's memberChatIds directly rather than splitting
the id), so the bucket key is treated as opaque; a two-char token under a reserved
prefix is the cheapest way to keep these ids visibly distinct from the three
parsed composite-id grammars without widening the single-char reserved set (which
would ripple into the id-factory separator check and every existing split). The
ARCHITECTURE.md "Separator-namespace discipline" rule and the "Smart-group signal
strength" note were revised to record both additions.

## 2026-06-16 Slice 5 (fix pass): cross-view drag payload rides an in-process stash, not the DataTransfer

Resolution: the CROSS-view (cross-tree) drag payload is carried by an in-process
singleton stash (src/dnd/dragContext.ts: stashDrag/takeDrag), NOT by a custom MIME
on the DataTransfer. handleDrag stashes the dragged chat ids (and still writes them
under the shared chat MIME and the controller's own reserved MIME, which remain the
WITHIN-view carrier and the drop-target offer respectively). handleDrop reads a
recognized MIME value when present (a within-view drop, where the host preserved our
custom item) and otherwise falls back to the stash (a cross-view drop). The stash is
one-shot: takeDrag clears it on every drop so it can never leak into a later
unrelated drop. This SUPERSEDES the carrier mechanism asserted in the Slice 3
DECISIONS entry below.

Rationale: the Slice 3 entry assumed that on a cross-tree drop "the host strips our
custom chat MIME and carries only the SOURCE tree's reserved MIME" and that the
chat-id JSON written under that reserved MIME would therefore reach the peer
controller's handleDrop. That is FALSE for VSCode 1.66. The pinned
@types/vscode 1.66 DataTransfer doc says a custom MIME added in handleDrag "will
only be included in the handleDrop when the drag was initiated from an element in
the same drag and drop controller," and the handleDrag doc says custom
DataTransferItem objects are preserved only "when the items are dropped on another
tree item in the same tree." The pinned extHostTreeViews.ts source confirms the
mechanism: $handleDrop re-applies the source controller's handleDrag items
(addAdditionalTransferItems) ONLY when sourceViewId === destinationViewId; on a
cross-tree drop only the base transfer DTO crosses, so the value the source
controller wrote under its own reserved MIME never reaches the peer controller.
Listing the peer reserved MIME in dropMimeTypes only makes the peer tree a drop
TARGET (so handleDrop runs at all); it does not make the source's overwritten
custom value survive cross-controller. The original assumption would have made the
headline cross-view drag a silent no-op (pickPayload returns the host-internal
value, parseChatIds rejects it, intents=[]). The in-process stash is the standard
VSCode-extension pattern for passing data between two trees of the same extension
and does not depend on any unverified DataTransfer-survival behavior. The
integration test was rewritten to hand the peer controller a transfer carrying a
host-style opaque reserved-MIME value (which parseChatIds rejects) so the assertion
only passes if the payload rides the stash, closing the question-begging gap where
the prior test copied the source's own value into the drop transfer.

## 2026-06-16 Slice 5 (fix pass): a drop on a linked-child row files alongside it, never unfiles

Resolution: in the Folders DnD controller, a drop landing on a LinkedChildItem row
resolves to that linked child's underlying chat's CURRENT home folder id (via a
ChatHomeResolver dep backed by FoldersProvider.memberNodeForChat) so the dragged
chat is filed ALONGSIDE the linked child, matching the documented chat-onto-chat
behavior. When that home cannot be resolved the controller returns a NOOP_TARGET
sentinel and the drop is a strict no-op. NOOP_TARGET is distinct from undefined:
undefined means "the view root / empty space," which on the Folders view
legitimately unfiles, so a separate sentinel is required to keep an unresolvable
linked-child drop from silently unfiling.

Rationale: LinkedChildItem was spliced into the FolderTreeNode union in Slice 5, but
the drop-target resolver predated it and matched only FolderItem and ChatMemberItem,
falling through to undefined for a LinkedChildItem. The reducer maps an undefined
Folders target to setFolder(chatId, null) = unfile, so a drop on a linked-child row
silently moved the dragged chat OUT of its folder home (a data-loss-adjacent
surprise). A LinkedChildItem is not a folder-home node (its tree id is the
`${parentChatId}>link>${chatId}` link composite, not `${folderId}#${chatId}`), so
its folder home must be looked up by chat id rather than parsed from the node id.

## 2026-06-16 Slice 5 (Links): deterministic single-parent selector is the smallest source chatId

Resolution: the store permits a chat to be the target of kind:'parent' links from
MORE THAN ONE source chat (addLink dedupes only on the exact (targetChatId, kind)
pair, never enforces a single parent), so links.ts must pin ONE designated parent
per child or the child would nest under different parents on different renders and
the cycle/diamond traversal would be non-deterministic. The selector is: among all
source chats that hold a kind:'parent' link to a given child, the designated parent
is the one with the lexicographically SMALLEST source chatId (string comparison on
the separator-free UUID). This is total (every candidate set is non-empty when a
child has any parent link), stable across renders (the input is the same stored
links, the order is content-independent), and independent of object/iteration order
(it is a min over a value, not a first-seen pick). A child with no kind:'parent'
link pointing at it has no designated parent and renders only in its own folder
home, never as a linkedChild. The linkedChild composite id is
`${parentChatId}>link>${chatId}` where parentChatId is exactly this designated
parent, so the id is itself deterministic.

Rationale: ARCHITECTURE.md ("Link cycle detection") requires "a linked child
renders under only its one designated parent link" and a deterministic visited-set
traversal. Since the store does not enforce single-parent at write time, the
determinism has to be a property of the READ-time selector, not of write discipline.
Smallest-source-chatId was chosen over "first link found" (which depends on object
iteration order and so is not stable) and over a stored "primary" flag (which would
add a synced field and a new mutation this slice's plan does not call for). The
selector lives in vscode-free links.ts so the unit suite asserts the tie-break
directly without the vscode host.

## 2026-06-16 Slice 3 (Tags/DnD): dropMimeTypes lists the PEER view's reserved MIME, not only its own

Resolution: each NestDragAndDropController sets dropMimeTypes to ALL recognized
payload MIMEs (NEST_CHAT_MIME, FOLDERS_RESERVED_MIME, TAGS_RESERVED_MIME) — i.e.
its own reserved MIME, the PEER view's reserved MIME, AND the shared custom chat
MIME — while dragMimeTypes stays narrow (the controller's own reserved MIME plus
the shared chat MIME). handleDrag writes the chat-id payload under both its own
reserved MIME (the cross-view carrier) and the shared chat MIME (the within-view
carrier). This deviates from the original ARCHITECTURE.md "Drag and drop" wording
("declares only its own reserved MIME plus one shared custom chat MIME"), which
has been corrected to match.

Evidence: @types/vscode is pinned to 1.66.0 (package.json engines ^1.66.0). The
DataTransfer class doc (node_modules/@types/vscode/index.d.ts) states that custom
additional MIME types added in handleDrag "will only be included in the handleDrop
when the drag was initiated from an element in the same drag and drop controller."
The dropMimeTypes doc states "To support drops from trees, you will need to add
the mime type of that tree. This includes drops from within the same tree," where
a tree's MIME is application/vnd.code.tree.<treeidlowercase>. So on a cross-tree
drop the host strips our custom chat MIME and carries only the SOURCE tree's
reserved MIME; for the target tree to be offered as a drop target and to receive
that payload it MUST list the peer tree's reserved MIME in dropMimeTypes. Following
the literal old rule (own reserved MIME only) would silently break the headline
cross-view drag feature. The implementation in src/dnd/dndController.ts
(dropMimeTypes = [...RECOGNIZED_PAYLOAD_MIMES]) is correct and required.

## 2026-06-16 Slice 2 (Folders): the id factory lands here, separator + sentinel guard

Resolution: src/model/idFactory.ts is added as the vscode-free single place
folder ids are minted and validated. It mints a separator-free folder id
(crypto.randomUUID, mirroring deviceId.ts, with a separator-free fallback) and
exposes isSeparatorFree / assertSeparatorFree / isMintableId / assertMintableId.
The mintable space excludes the synthetic sentinels __unfiled__ (this slice) and
__untagged__ (slice 3), so a factory-minted id can never collide with a synthetic
bucket. Slice 2 is the first slice to mint folder ids, so the factory lands here
rather than being deferred.

Rationale: ARCHITECTURE.md mandates that folder/tag/chat ids be free of ':' '#'
'>' and says to "enforce in the id factory." Until this slice nothing minted an
id, so there was no factory; placing it here makes the separator rule a property
of the minting code (and the assertion is re-run at the folder-write boundary as
defense in depth) instead of a review-time discipline. Excluding the sentinels
from the mintable space closes the one remaining collision path between a real
folder id and a synthetic bucket id.

## 2026-06-16 Slice 2 (Folders): slash names expand to a chain of real records (interpretation b)

Resolution: typing a slash name like Work/ClientA in the create-folder command
expands at CREATE time into a chain of real parent-child Folder records (Work
parentId=null, ClientA parentId=Work.id), reusing any existing segment matched by
(parentId, name) and minting a new record only for a missing segment. No literal
'/' is ever stored in a single Folder.name. folderTree.ts assembles the nested
tree from the flat records at render time; the slash split happens in
folderCommands.ts at create time. The synthetic Unfiled bucket uses the sentinel
folderId __unfiled__ and holds every chat whose ChatMeta.folderId is null/absent
or whose home folder no longer resolves. Chat member nodes use the composite id
${folderId}#${chatId} for both real and Unfiled buckets; getParent splits on the
FIRST '#' to recover the single owning folder id.

Rationale: the alternative (storing a literal slash inside one Folder.name) would
make Folder.parentId meaningless, leave the delete cascade and getParent's
single-owning-folder semantics undefined, and contradict folderTree.ts's stated
"slash-path expansion, single-home assembly" role. Expanding to real records
keeps parentId authoritative, makes deleteFolder's by-folderId cascade and
getParent well-defined, and lets a later segment reuse an existing or
earlier-in-this-call parent. The __unfiled__ sentinel mirrors the established
__untagged__ convention and, being separator-free and excluded from the factory's
mintable space, cannot collide with a real folder id; the first-'#' split is
unambiguous because folderId is separator-free and chatId is a separator-free
UUID.

## 2026-06-15 Slice 1 (storage): orphan state on a separate non-synced document

Resolution: the local-only orphan-reconcile state (missingSince, archived,
tombstone) is NOT modeled as fields on the synced ProjectMeta. It lives on a
distinct LocalProjectMeta document stored under a NON-synced key,
nest.local.v1::<projectKey>, which deliberately does not carry the
nest.meta.v1 prefix, so isMetaKey is false for it and the store never sweeps it
into setKeysForSync. The MetadataStore registers only meta keys for sync;
setLocalChatState and putLocalProjectMeta write the companion key directly,
outside the debounced synced write chain.

Rationale: ARCHITECTURE.md requires that orphan state be "local only, never
synced." Storing missingSince/archived as fields on the synced ChatMeta would
make that invariant a runtime discipline that one wrong write could violate
(and a foreign-device wholesale replace of a project's value could carry another
machine's orphan view). Putting the orphan state on a separate document that is
structurally excluded from the sync key set makes the invariant a property of
the storage layout, not of every write site. The synced ProjectMeta stays
self-contained and free of any local-only field.

## 2026-06-15 Slice 1 (storage): deferred-drain debounce (no inline drain)

Resolution: every mutation stages its result in an in-memory pending map and
schedules a DEFERRED drain (a setTimeout at the debounce interval, or
setTimeout 0 when debounceMs <= 0 in the test harness); a mutation never drains
inline. Reads serve the pending map first (read-your-writes), then fall back to
the migrated stored value. flush() loops draining the chain tail until both the
debounce timer is clear and the pending map is empty.

Rationale: the first implementation drained synchronously inside mutate when
debounceMs was 0, which cleared the pending entry before the async
memento.update landed. A second same-tick mutation then read neither the
pending value (already cleared) nor the not-yet-persisted store value, so it
overwrote the first mutation with a stale base document. Deferring the drain
keeps the pending map populated across a synchronous burst, so reads stay
consistent and the burst still coalesces into one persisted write. This also
matches the production path (a real debounce timer), so the test harness with
debounceMs 0 exercises the same code path rather than a special-cased inline
branch.

## 2026-06-15 Slice 0 (scaffold): "documented URI handler" fork

Resolution: the open-chat launcher fires the verified URI
vscode://Anthropic.claude-code/open?session=<sessionId>, where <sessionId> is
the .jsonl filename with its extension stripped (filename equals sessionId per
ARCHITECTURE.md). The URI is built with vscode.Uri.from({ scheme: "vscode",
authority: "Anthropic.claude-code", path: "/open", query: "session=" + id }).
The authority is NOT lowercased and the bare UUID is NOT URL-encoded beyond
standard query encoding (a UUID contains no characters that require percent
encoding).

Evidence: the installed anthropic.claude-code 2.1.178 bundle (extension.js)
registers Se.window.registerUriHandler({ handleUri(h){ let _ = new
URLSearchParams(h.query); switch(h.path){ case "/open": { let b =
_.get("session") ?? void 0, x = _.get("prompt") ?? void 0;
Se.commands.executeCommand("claude-vscode.primaryEditor.open", b, x); ... } } }
}). VSCode routes vscode://<publisher>.<name> to the extension whose id matches
that authority; the package.json there is publisher "Anthropic", name
"claude-code", so the authority must be cased "Anthropic.claude-code". The
session query param is read via URLSearchParams.get, which percent-decodes, so
the launcher passes the raw sessionId and relies only on standard query
encoding.

## 2026-06-15 Slice 0 (scaffold): project-key encoder character class

Resolution: the encoder replaces every character that is not [A-Za-z0-9-] with a
single hyphen, not just the five-member separator set (backslash, forward slash,
colon, dot, space) the original draft enumerated. The regex is
/[^A-Za-z0-9-]/g applied after lowercasing the leading drive letter.

Evidence: the live ~/.claude/projects listing on this machine contains
c--Users-JakeMismas-Notes--Github, which is the on-disk encoding of the workspace
c:\Users\JakeMismas\Notes+ Github. The '+' is not a separator, yet Claude Code
hyphenated it (and the following space), producing the double hyphen. A
separators-only encoder yields c--Users-JakeMismas-Notes+-Github, which never
matches the real directory, so resolveProjectDir returns null and the flat view
shows zero chats for that workspace; the cwd-scan fallback cannot recover because
it re-encodes the transcript cwd with the same broken rule. The broad class
reproduces all 13 real directory names exactly (verified) while still passing
every prior test case. ARCHITECTURE.md's separator-class wording was corrected to
match.

## 2026-06-15 Slice 0 (scaffold): "project-key casing" fork

Resolution: ARCHITECTURE.md's encoding rule stays authoritative for DERIVING
the key (lowercase only the leading drive letter, then replace each separator
character with a single hyphen). The resolver, however, MATCHES the derived key
against the real on-disk directory names case-insensitively on the leading
drive-letter segment (or falls through to the cwd scan fallback) rather than
requiring exact string equality. The cwd self-verify anchor specified in
ARCHITECTURE.md is kept: derive the key, then confirm by re-encoding a
transcript cwd.

Evidence: the real ~/.claude/projects listing carries inconsistent leading
drive-letter casing. C--Users-JakeMismas (uppercase C) and
c--Users-JakeMismas-Documents-Claude-Code---Nest (lowercase c) both exist on
the same machine. The encoding rule lowercases the leading drive letter, so a
cwd of C:\Users\JakeMismas derives c--Users-JakeMismas, which would never match
the on-disk C--Users-JakeMismas under exact equality. Case-insensitive leading
match (with scan fallback) resolves it without weakening the derivation rule.

## 2026-06-19 Slice s2-fulltext-search (order 2, issue 19): FIT REVIEW packaging conflict

Fork: the slice's packaging requirement is self-contradictory with the existing
toolchain and could not be satisfied as written. The slice's installCheck is
vsce package --no-dependencies (SPRINT-2-PLAN.md line 158). .vscodeignore line 18
is node_modules/**, which excludes ALL of node_modules from the VSIX. The issue
(#19) and plan (lines 98-99, 171) require minisearch as a RUNTIME dependency that
is "installed before packaging" and that --no-dependencies "still bundles". These
three cannot all hold. With BOTH --no-dependencies set AND node_modules/** ignored,
minisearch's files never enter the VSIX, so a runtime require('minisearch') throws
"Cannot find module" at activation in an INSTALLED extension. Worse, --no-dependencies
makes vsce skip the npm dep-tree walk, so the package step SUCCEEDS (passes
installCheck) while shipping a broken extension, a silent false-success. The plan's
prescribed fix at line 171 (npm install minisearch before packaging) is provably
wrong three ways: (a) node_modules/** excludes an installed minisearch from the
VSIX, (b) --no-dependencies makes vsce skip the dep-tree walk so it never tries,
(c) the package step still succeeds while shipping an extension whose
require('minisearch') throws at activation.

Verified facts: node_modules/minisearch is NOT installed; package.json has NO
dependencies block at all (the extension has ZERO third-party runtime deps today,
all imports are vscode or node builtins, confirmed by grep over src). No bundler
in the toolchain: esbuild/webpack/rollup all absent from devDependencies, no bundle
script, compile is plain tsc to CommonJS (out/extension.js). minisearch ships UMD
(dist/umd/index.js) and ESM (dist/es/index.js); it is a small, dependency-free,
single-tree MIT package (~25KB) that bundles cleanly if a bundler or a vendored
copy is introduced. The prior slice-7 DECISIONS entry confirms .vscodeignore
excludes src/**, **/*.ts, out/test/** but ships media/**, and does NOT carve an
exception for node_modules. All three proposals also caught the decisive trap the
fit review's parenthetical missed: a raw src/search/vendor/minisearch.js is BOTH
not compiled (tsconfig rootDir:src, include:src/**/*.ts, no allowJs) AND not
shipped (.vscodeignore:10 src/**, :12 **/*.ts), reproducing the same silent
failure. out/** DOES ship (nothing excludes it but out/test/** at :11), so the
vendored file must reach out/.

Resolution (autonomous, reversible): Option A, vendor MiniSearch into the repo as
a single local module, host-side only, with a post-tsc copy step that puts it in
out/. installCheck, .vscodeignore, --no-dependencies, and package.json dependencies
all stay untouched. (Synthesis: Proposal 3's mechanism, hardened with Proposal 2's
ships-verification and Proposal 1's dual-surface framing.) Mechanism: vendor
MiniSearch's published UMD/CJS dist verbatim as src/search/vendor/minisearch.js
(byte-identical to upstream, MIT), add a hand-thin src/search/vendor/minisearch.d.ts
for the small surface searchIndex.ts uses, and extend the compile script with a
one-line node -e fs copy of the vendor dir into out/search/vendor/, exactly the
shape already proven in the clean script (package.json:518, node -e rmSync). The
vendored .js sits outside the tsc and eslint paths entirely (eslint lints .ts only,
package.json:521; ignores **/*.d.ts, .eslintrc:74), so zero strict-mode friction
and zero lint churn. searchIndex.ts imports it by relative path (import MiniSearch
from './vendor/minisearch') so the emitted CommonJS require resolves inside out/,
which ships. MiniSearch is HOST-ONLY: the index is a host module (plan:99), the
webview only posts a query string and renders host-returned ranked rows. So there
is exactly one vendored copy under out/search/vendor/, no media/ copy, no
webview-CSP problem.

Rationale: the blocking conflict is real and verified against the live files
(.vscodeignore:18 node_modules/**; package script vsce package --no-dependencies
at package.json:525; no dependencies block). Where proposals diverged was the
vendor FORM. Proposal 2's headline (port MiniSearch's source to a .ts file so tsc
emits it) is the riskiest: a verbatim port through this repo's tsc --strict +
noUnusedLocals + noUnusedParameters (tsconfig:9,11,12) is NOT guaranteed to compile
clean, and Proposal 2 itself adds a residual-risk escape hatch admitting it may
fail and tempt weakening strictness repo-wide. Proposal 3's primary mechanism
(vendor dist verbatim, thin .d.ts, copy into out/) is lowest-risk and most
auditable. Why not B or C: Option B (esbuild/webpack inline) rewrites the frozen
tsc-only build/test toolchain contract for the smallest possible need,
disproportionate and unnecessary once the copy step exists. Option C (drop
--no-dependencies AND remove node_modules/**) breaks the installCheck string
shared verbatim across all 8 slices (SPRINT-2-PLAN:156-163, the engine resumes by
matching this trailer) and bloats every VSIX. Both rejected. Confidence 0.88.

Non-blocking fold-ins (verified, to honor in the build): (1) searchStore.ts
persists ONLY through exportIO.writeTextFile/readTextFile against
context.globalStorageUri; every exportIO write runtime-asserts
assertNotUnderClaudeProjects (exportIO.ts:34-59), and the object-agnostic eslint
selector (.eslintrc:25) trips any fs write outside the two carve-outs (exportIO.ts
is in the override list, .eslintrc:82-87); the guard test reuses exportPathGuard.
Do NOT add a new fs path. (2) The index key/file is NEVER in setKeysForSync
(sprint-wide hard rule, SPRINT-2-PLAN:67); add this as an explicit review
checkpoint. (3) Body-index invariant resolved the safe way: persist
tier-A-derived tokens only (title, lastMessageText, filesTouched); index bodies
only in the in-memory session via bodyReader.readTranscriptBodies per chat,
discarded, keeping "bounded reductions on snapshot, full body never" unambiguous
(SPRINT-2-PLAN:65-66). (4) The slice MUST add the binding "search-index location"
section to ARCHITECTURE.md (DoD, SPRINT-2-PLAN:45). (5) Search wiring lives in
durable host modules (provider/searchIndex), not the throwaway media/chatsPreview.js
that slice 6 supersedes.

SUPERSEDED plan instructions (council fold-in): SPRINT-2-PLAN.md:99 ("add
minisearch to package.json dependencies and run npm install minisearch") and
SPRINT-2-PLAN.md:171 ("npm install minisearch before the installCheck or
--no-dependencies packages a broken require") are both SUPERSEDED and NOT
followed. Reason: node_modules/** is excluded from the VSIX (.vscodeignore:18)
and `vsce package --no-dependencies` skips the npm dep-tree walk, so an installed
minisearch never ships and the package step still succeeds, a silent
false-success. They are replaced by the vendored-module mechanism above:
package.json gains NO dependencies block, `npm install minisearch` is NOT run,
and MiniSearch is vendored at src/search/vendor/minisearch.js and copied into
out/ by the compile step. A post-package assertion confirms
out/search/vendor/minisearch.js is present inside the VSIX, turning the install
proof from a false-success into a real one.

## 2026-06-19 Slice s2-schema-scalars-and-lww: single-arbiter per-scalar LWW, coupled archivedAt, no new conflict array

Fork: the slice adds four synced curation scalars (chat starred, userArchived,
archivedAt; folder color) and must arbitrate them in mergeProjectMeta. Three sub-forks
were resolvable without an irreversible call: (a) how to time-arbitrate per-chat scalars
given there is one per-record updatedAt and no per-scalar stamp; (b) whether archivedAt
arbitrates independently of userArchived; (c) whether the new boolean/number scalars get
their own conflict array alongside folderConflicts.

Resolution (autonomous, reversible): (a) all per-chat scalars are decided by the SINGLE
existing useFile boolean (fileChat.updatedAt > liveChat.updatedAt), the same comparison
that already picks the merged chat's deviceId; a tie keeps live, matching folderId's tie
rule. No per-field timestamps were invented. (b) archivedAt travels COUPLED to
userArchived: the winning side supplies both, so the timestamp can never desynchronize
from the flag (and the store's setChatArchived clears archivedAt on unarchive). (c) NO
new conflict array: folderConflicts stays the surfaced floor per the plan; the slice
patch marks symmetry for the other scalars as optional and not required to pass.
Folder.color is arbitrated at the document level (folders carry no per-record stamp) and
required extending all three of foldersEqual, cloneFolder, and normalizeFolder together,
or a color-only edit reads as equal and silently never merges or persists.

Rationale: reusing the one existing stamp and arbiter keeps the import-merge and
shadow-reconcile paths byte-identical in behavior (they both delegate to
mergeProjectMeta), avoids inventing a parallel stamping scheme the schema does not carry,
and keeps the conflict surface unchanged. The new fields are nested on the folder/chat
records, so the top-level KNOWN_TOP_LEVEL/__unknown forward-compat escrow is untouched
and no SCHEMA_VERSION bump is needed (additive-optional, default-absent on older docs).

## 2026-06-19 Slice s2-star-archive: read userArchived not the orphan flag, full read-only-bank body store, deterministic retention

Fork: slice 4 adds star/archive commands, an Archive view, a Nest-owned body copy, and
the first contributes.configuration value. Four sub-forks were resolvable without an
irreversible call: (a) which archive flag the Archive view lists by, given two distinct
"archived" flags exist; (b) where the body-copy IO lives relative to the read-only lint
bank; (c) where the keep-window setting is read; (d) how the retention policy encodes its
edges.

Resolution (autonomous, reversible): (a) the Archive view lists by the SYNCED
ChatMeta.userArchived === true from store.getProjectMeta, and NEVER reads the local-only
LocalChatState.archived (the orphan-reconcile, missing-on-disk flag on nest.local.v1).
The two are deliberately distinct (schema.ts:80-96): userArchived is a synced curation
choice, LocalChatState.archived is reconcile machinery. Restore calls
store.setChatArchived(false) (clearing archivedAt); star/unstar is independent. A unit
test asserts the provider reads userArchived, not the orphan flag. (b) archiveBodyStore.ts
mirrors searchStore.ts: it does NO node fs and NO direct vscode.workspace.fs, going only
through exportIO (which runtime-asserts assertNotUnderClaudeProjects), so it stays under
the FULL read-only lint bank with no new carve-out. One file per archived chat keyed by
the separator-free sessionId UUID under globalStorageUri/archive; ensureDirectory before
the first write; an exposed archivedBodyPath helper for the guard test. (c) the keep-window
is read in the vscode-thin layer via vscode.workspace.getConfiguration('claudeNest') and
passed as a plain keepWindowDays number into the pure archiveRetention policy, which never
reads getConfiguration (the headless gate would break otherwise). (d) the policy decides
keep|prune purely from {archivedAt, starred, keepWindowDays, now}: keepWindowDays <= 0 is
the never-prune sentinel, STARRED exemption precedes the window, and the window edge is
inclusive (age strictly greater than the window prunes), so the boundary case is
deterministic.

Rationale: (a) conflating the flags would either surface orphaned-on-disk chats the user
never archived or fail to surface user-archived ones; reading only the synced flag is the
single correct source and matches slice 3's intent. (b) reusing the exportIO chokepoint
keeps the read-only invariant enforced by lint rather than review discipline, with no new
exemption to audit, exactly as the search index does. (c) keeping getConfiguration out of
the pure policy preserves the vscode-free unit gate. (d) injecting now and forbidding clock
access inside the policy makes the boundary test exact rather than wall-clock dependent.
The Archive view registers without a dragAndDropController (read-mostly), matching the
smartGroups shape. Closes issue #21.

## 2026-06-20 Slice s2-star-archive (fix pass): live-protection backstop, cleaned-up-row preview, star badge on every surface

Fork: the review-and-fix loop surfaced three reversible sub-forks left open by the initial
slice. (e) The prune trusts each copy's OWN recorded {archivedAt, starred} snapshot, but
that snapshot is updated only best-effort by updateStarFlag (a swallowed write failure, a
star applied where the copy never landed, or a star synced from another device that never
touched this install's copy can leave it stale-false while the LIVE synced flag is true) —
so a starred copy could be silently, permanently pruned. (f) An archived row whose
transcript Claude has cleaned up had no Open command and was non-clickable, even though the
Nest-owned copy — the entire reason the feature exists — is still readable. (g) The star
badge rendered only in the Archive view, so starring a chat from Chats/Folders/Tags gave no
feedback on those surfaces.

Resolution (autonomous, reversible): (e) pruneArchivedBodies takes an optional
isLiveProtected(sessionId) check; before deleting a copy the pure policy marked prune, it
re-reads the live synced meta and force-keeps a chat that is still userArchived AND starred.
The check is a no-write read of getProjectMeta wired in the vscode-thin layer, so the pure
policy and the sync surface are unchanged; a throwing check fails SAFE toward keep, and when
no project resolves nothing is protected (the historical copy-snapshot-only behavior). (f)
an archived row's default click is Open when the live transcript is present and
claudeNest.previewArchivedChat (preview the Nest-owned copy by sessionId) when it is gone;
the preview is also a context/inline action on every archived row. previewArchivedBody
routes through the SAME pure formatter as the live preview (the shared formatPreviewLines),
so the two renderings are byte-identical, and a missing/empty copy surfaces an info notice
rather than a blank document. (g) every primary provider resolves the synced
ChatMeta.starred via the shared resolveStarred and swaps the row icon to star-full, folding
starred into its reuse key (flat) or cardStarred field (folders, tags) so a toggle rebuilds
only the affected rows.

Rationale: (e) starring is the user's explicit "do not lose this" signal and the copy is
the chat's only durable form after Claude's cleanup, so a stale-snapshot star must never let
the prune delete it; reading the live flag at prune time is the authoritative source, and
fail-safe-toward-keep means a backstop fault never causes data loss. (f) a cleaned-up row
that cannot be opened defeats the survival promise the copy exists to keep; reusing the live
formatter guarantees no second rendering path can drift. (g) the synced flag is the single
source the star command writes and the Archive view reads, so reading it everywhere keeps
the badge consistent; ThemeIcon cannot composite glyphs, so the star replaces the chat icon
rather than overlaying it. All three are reversible (a later PR can drop the backstop arg,
revert the cleaned-up click to non-clickable, or remove the badge) and visible in the diff.
Still closes issue #21.

## 2026-06-20 Slice s2-export-and-rollup (order 5, issue 22): export-IO seam naming, YAML front-matter escaping, pinned counting rule, virtual-document rollup surface

Fork: the fit patches flagged four points to settle. (1) TOKEN-TOTALS SEAM: the rollup needs
per-chat tokenTotals, but foldersProvider.chatRecords() projects each record down to
{title, timestamp} and drops tokenTotals. Resolution: add the narrow
FoldersProvider.tokenTotalsByChat() seam returning a fresh Map<sessionId, TokenTotals> from
the full records the provider already holds behind ensureSnapshot(), mirroring chatRecords();
the pure tokenRollup reducer takes that plain map plus ProjectMeta and never reads the
provider. (2) FRONT-MATTER ESCAPING/INJECTION: the export front-matter carries
user/transcript-derived strings (title, tags, folder name, link ids). Resolution: the
Markdown front-matter emits every scalar as a double-quoted YAML string with
backslash/quote/newline/CR/tab escaped (yamlQuote) and sequences as quoted flow arrays, so a
title with a colon/quote/newline/leading-'---' is contained on one quoted line and cannot
break the block or inject a second one; the JSON formatter is round-trippable and gets this
free via JSON.stringify. A no-body case and a markdown-injection case were added to
chatExport.test.ts (the injection test asserts EXACTLY two front-matter fences). (3) DOUBLE-
COUNT RULE: pinned in tokenRollup.ts and asserted in tokenRollup.test.ts: a chat counts ONCE
in its single folder (unfiled/stale-id -> synthetic Unfiled; by-folder totals PARTITION the
library) and ONCE per EACH of its tags (untagged -> synthetic Untagged; a multi-tag chat adds
its full total to every tag bucket, so by-tag totals are INTENTIONALLY NOT a partition and can
EXCEED the library total). The report renderer carries the explicit note so the tag rollup
does not read as a bug. (4) ROLLUP UI SURFACE: the plan named the reducer + command but not
the render target.

Resolution chosen: the lightest surface that meets the AC, a read-only virtual document built
from the pure reducer + renderer output, opened by the vscode-thin showTokenRollup command,
avoiding any webview/CSP dependency (the rollup is explicitly the first thing to cut). The
claudeNest.showTokenRollup command is contributed with a view/title entry on
flat/folders/tags and is available in the palette; claudeNest.exportChat is a chat-row context
action (flat/folders/tags) gated out of the palette since it needs a target, mirroring the
Slice 4 curation-command contributions.

One additional fork surfaced during the build (not in the patches): the export's guarded-write
seam was first named writeFile, which the read-only lint bank's object-AGNOSTIC first selector
(ban any callee property named writeFile) rejected on the deps.writeFile(...) call site exactly
as it would a node fs write. Resolution: rename the seam to writeExport; the actual guarded
write stays exportIO.writeTextFile (a carve-out module that runtime-asserts
assertNotUnderClaudeProjects), and the command performs no write-shaped call itself, so the
export command stays under the full ban. This mirrors the Slice 8 finding that the selector is
object-agnostic. All four resolutions are reversible (a later PR can widen the seam, swap the
rollup surface to a webview, or re-tune the contributions) and visible in the diff. Closes
issue #22.
