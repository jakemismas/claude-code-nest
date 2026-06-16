# Decisions

Autonomous design decisions made during the unattended build are appended here,
one dated entry per fork: the slice, the fork, the chosen resolution, and the
rationale. Locked decisions from the approved plan live in PLAN.md and
ARCHITECTURE.md and are not relitigated here.

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
