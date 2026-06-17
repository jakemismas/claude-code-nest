# Decisions

Autonomous design decisions made during the unattended build are appended here,
one dated entry per fork: the slice, the fork, the chosen resolution, and the
rationale. Locked decisions from the approved plan live in PLAN.md and
ARCHITECTURE.md and are not relitigated here.

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
