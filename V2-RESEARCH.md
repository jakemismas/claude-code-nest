# Claude Code Nest — V2 Feature Research & Decisions

Status: research complete, build NOT started. Date: 2026-06-18.
Audience: any chat/agent (incl. the orchestrator) picking up Nest V2. You do not
need the originating conversation; everything to scope V2 is here. Confidence and
sourcing are flagged inline. Where a number is cited it was read off a live page
this session; treat unstated specifics as directional.

---

## TL;DR

- Nest V1 = a strictly read-only organization layer over Claude Code transcripts
  (folders, tags, links, read-only smart groups, org-layer export/import,
  best-effort cross-machine sync), packaged as v0.0.1.
- The one glaring gap is **search** (V1 filters titles only). The moat to protect
  is **the organization layer as a portable, syncable, read-only artifact** —
  uncontested in the market.
- **Locked for V2 (user-confirmed):** (1) full-text content search, (2) rich
  session preview on hover, (3) transcript archival + content export.
- Nearly all of V2 rides on **one additive, read-only reader change** (retain
  message bodies + tool_use blocks + usage fields). That single change unlocks
  search, preview, token badge, files-touched signal, and content
  export/archival.
- **Spike-verified this session:** a third-party extension CAN place an icon on
  Claude's chat tab (`editor/title` over viewType `claudeVSCodePanel`). It CANNOT
  render inside the conversation or read Claude's live state. So "reach onto the
  chat" is a thin convenience layer; the reliable home for per-chat UI is Nest's
  own inspector panel.

---

## 1. The moat (where Nest uniquely wins)

Uncontested white space: **treat the user's organization of chats as first-class,
portable, syncable data they own, layered read-only over transcripts they never
risk corrupting.** No competitor occupies this. The viewers have no org layer; the
organizers that exist are either flat or they mutate Claude's `.jsonl` files.

Sharpest head-to-head is **agsoft "Claude Code & Codex Assist"** (~7.7k installs,
the most feature-complete rival): closed-source, telemetry-on-by-default,
time-gates the user's own history behind a $4.99/mo paywall (free tier can't see
past ~7 days), and paywalls its anti-auto-delete archive. Nest can give all of
that free, private, unlimited. Positioning: **own your history, organize don't just
view, never lose a chat, nothing leaves your machine.**

---

## 2. Competitive landscape (verified)

| Capability | Status for Nest | Notes |
|---|---|---|
| Org-layer export/import as portable JSON | **Only Nest** | Strongest moat. Every rival "export" dumps transcript content, not the curation layer. Anthropic's own export request (#18645) explicitly excluded org metadata. |
| Manual chat-to-chat links | **Only Nest** | No tool does user-curated links between two chats. |
| Cross-machine sync of org metadata | **Only Nest** | `claude-sync` syncs raw files, not a curated layer. |
| Nestable folders + many-to-many tags as a system | **Only Nest** | Rivals are flat (project/date) or single-axis. |
| Strict read-only on transcripts | Shared (wedge vs write-tools) | Table stakes, not headline. Real wedge vs Claude Chats (~6.6k installs), Sessions Explorer, LinMa — all rewrite `.jsonl`. |
| Telemetry-free + free/MIT | Shared | hiztam, doorsofperception, jhlee0409 match. Clean contrast vs agsoft (paid + telemetry-on). |
| Smart Groups by branch/PR/fork lineage | **Eroded** | Native CLI now ships `Ctrl+B` branch filter, fork-grouping-under-root, `--from-pr`. Surviving value: a persistent cross-project grouped VIEW, ticket grouping, and a "files-touched" signal. |
| Full-text content search | **Gap (everyone beats us)** | V1 is title-only. The most exposed weakness. |
| In-app rendering, token/cost, diffs, multi-agent | **Gaps** | See section 3. |

Notable rivals: ccusage (~16.3k stars, cost CLI), claude-monitor (~8.2k, live
burn-rate), jhlee0409 history-viewer (~1.6k, 10-agent desktop), hiztam
codex-history-viewer (closest organizer: tags/notes/pins/saved-searches, but no
folders, no chat-to-chat links, no sync, no org export). Anthropic has shipped
`/rename`, `/recap`, `/rewind`, a desktop session sidebar, agent view, native
fork/branch lineage + PR auto-linking — so several raw complaints are now partly
addressed natively. Multiple GitHub feature requests for org/search/history were
closed **not planned** (#38235 export/browse/search; #30916 picker capped at 3;
#25130 resume limited to 10) or **duplicate** (#58161 tags/folders; #55291
bookmark/pin; #8701 search history) — strong "build it as a third-party read-only
layer" signal.

---

## 3. What to also have — adoption roadmap (verdicts + effort)

The unifying insight: **one additive, read-only reader change** (retain message
bodies, tool_use blocks, and `message.usage` fields — all already read into memory
during the V1 scan, just discarded) unlocks search, preview, token badge,
files-touched signal, and content export/archival. Sequence that change first.

| Feature | Verdict | Effort | Why |
|---|---|---|---|
| Full-text content search (substring + highlight + role/tool-output scope + regex) | **Adopt now** | S-M | #1 gap. Use MiniSearch (zero-dep, in-memory; free fuzzy/ranking). Skip semantic/embeddings (30MB model download fights the no-cloud pitch) and bundled SQLite (overkill for single-project). |
| Transcript archival + content export (Markdown/HTML) | **Adopt now** | S-M | Same engine as archival; reuses V1's `exportIO.ts` write chokepoint. Closes the hole that V1's "authoritative backup" saves only the org layer, not bodies. Export org layer alongside the body (front-matter) — unique to Nest. Undercuts agsoft's paywall. |
| Rich session preview (first prompt, last activity, msg count, files touched, branch; on hover/expand) | **Adopt now** | S | On-axis ("which chat is this?"); rides the reader change. NOT a full renderer. |
| Per-chat token badge + cost-by-folder/tag rollup (TOKENS ONLY) | **Adopt** | S / S-M | Verified: assistant JSONL lines carry `message.usage` (input/output/cache) + `message.model`; NO `costUSD`; models mix mid-file. So tokens are free. Folder/tag rollup ("what did this feature cost") is novel — pure-cost tools have no org layer. NO USD (needs a maintained pricing table or a network call that breaks telemetry-free). NO dashboard (cede to ccusage/claude-monitor/Anthropic first-party). |
| "Files touched" smart-group signal | **Adopt** | S | Reuses tool_use capture; re-differentiates smart groups after native CLI ate branch/PR/fork. |
| Surface chats the native picker can't see | **Adopt** | S | Mostly already true (Nest reads JSONL directly, immune to sessions-index.json corruption + the 10/3-session caps). Work = an explicit indicator. |
| Code diffs (read-only, reconstructed, labeled) | **Adopt later** | M | Pulls toward viewer-hood; accuracy ceiling (reconstructed from tool_use, not disk state); the high-value slice (apply-to-workspace) is the one Nest MUST refuse to stay read-only. Lead with the files-touched signal instead. |
| Multi-agent (Codex only, behind an adapter seam) | **Adopt later** | M | Codex is the only cheap, high-demand expansion. But resume is the moat and does not travel (no other agent exposes a URI handler). Don't go broad. Phase 2 decision. |
| Full in-app renderer | **Don't build** | L | hiztam already owns render+resume in VSCode; off-axis; keep resume-in-place. |
| USD cost, full dashboard, semantic search, SQLite index | **Cede/skip** | - | Entrenched, off-thesis, or values-violating. |

---

## 4. The chat-surface finding (spike-verified 2026-06-18)

Question: can a third-party extension put UI on Claude Code's chat surface?
Resolved with a throwaway extension run in an Extension Development Host against the
live Claude Code extension.

**Verified facts:**
- Claude's chat is an editor-area **WebviewPanel**, viewType **`claudeVSCodePanel`**.
  The public Tabs API reports it prefixed as `mainThreadWebview-claudeVSCodePanel`;
  the `when`-clause key is the bare `claudeVSCodePanel`. Extension id
  `anthropic.claude-code`, closed-source, no public API, private webview channels.
  Also ships sidebar webview views and an opt-in terminal mode.
- **CONFIRMED POSSIBLE (high confidence):** a third-party `editor/title` icon
  gated on `when: activeWebviewPanelId == 'claudeVSCodePanel'` renders over Claude's
  chat tab and fires on click. A control icon over the spike's own webview also
  fired, ruling out an artifact.
- Via the public **Tabs API** (`window.tabGroups`), Nest can read the active tab's
  label + viewType, so it can detect a focused Claude chat and best-effort identify
  WHICH chat by matching the tab label to its index (works for named chats; unnamed
  tabs all show "Claude Code"; duplicate titles collide; the real session id is
  never exposed).

**Still impossible (high confidence):**
- Injecting UI into the conversation body/input (sandboxed cross-origin
  `vscode-webview://` iframe; even core-file-patching hacks can't cross it and
  aren't shippable).
- Reading the webview's live state (messages/tokens/context).
- Getting the session id from any API.
- Driving the session, e.g. `/compact` (only contact is the URI handler
  `vscode://anthropic.claude-code/open?prompt=&session=` and contributed
  `claude-vscode.*` commands).

**Net:** the tab icon is a thin convenience layer — icon-only (no chips bar, no
inline content), editor-tab-only (no sidebar/terminal), identity-by-label
heuristic, and it rides the undocumented `claudeVSCodePanel` id (an Anthropic rename
silently drops the icon; low blast radius). Anything per-chat is computed from the
transcript file Nest locates by identity, never from Claude's UI.

---

## 5. The three user ideas + verdicts

1. **Tags bar + "+" next to the chat name** — viable only as a title-bar ICON that
   opens Nest's tag picker for the active chat (identified by label match),
   degrading to generic when unnamed. NOT a chips bar inside the chat. Real tag
   editing belongs in Nest's inspector where identity is certain.
2. **Health bar across the chat + one-click compact** — NO. The across-the-chat bar
   is body injection (impossible). The compact button has no supported channel and
   would be a write into a running session (breaks read-only) and duplicates the
   native Claude meter + `/compact`. Salvage only a static "context weight" line in
   Nest's inspector (last turn's input tokens vs model max, clearly labeled, not a
   live gauge).
3. **Show tokens per chat in the chat window** — viable as a status-bar item and/or
   the tab icon's tooltip showing the active chat's token total (from its
   transcript), not inside the chat body. Tokens only, no USD.

---

## 6. Recommended build sequencing

- **Phase 1 (reader change + cheap riders):** retain bodies/tool_use/usage in the
  reader, then ship full-text search, rich preview, transcript archival + content
  export, token badge + folder/tag rollup, files-touched signal, and the explicit
  "lost chats" surfacing. Closes the search gap, delivers the 3 locked features,
  adds a novel cost-per-folder view, all read-only, off one enabling change.
- **Phase 1.5 (optional convenience layer):** a title-bar icon on Claude's chat tab
  + a status-bar "active chat" readout (token count, quick tag-add), built on the
  proven `editor/title` contribution + the Tabs API, with graceful degradation when
  the chat is unnamed or in the sidebar. Flag the `claudeVSCodePanel` dependency as
  known fragility before committing.
- **Phase 2 (deliberate):** reconstructed read-only diffs; then a Codex adapter if
  demand pulls.
- **Never:** full renderer, USD/dashboard, semantic/SQLite, anything that writes
  Claude's transcripts or drives the live session.

---

## 7. The read-only line (non-negotiable)

Nest stays strictly read-only on `~/.claude/projects/` transcripts. Permitted
writes: opening/resuming via the public URI handler; the one sanctioned single-key
edit of `cleanupPeriodDays`; and writing Nest's own artifacts (org metadata,
exports, archives, a search index) to user-chosen paths or the extension's storage,
never into `~/.claude/projects`. Out of scope (high complaint volume, wrong tool):
auto-compaction/context-loss prevention, in-session checkpoint/rewind, injecting
memory back into Claude, deleting/renaming Claude's actual sessions, live
running-session monitoring, model/cost-bug fixes.

---

## 8. Watch items / open questions

- **Biggest strategic risk:** an (unconfirmed) signal that Anthropic plans native
  Projects for Claude Code. If they ship native folders/tags, Nest's core gets
  commoditized — another reason to invest first in the read-only
  backup+search+preview layer their own "not planned" closures show they're
  deprioritizing.
- The title-bar icon rides the undocumented `claudeVSCodePanel` viewType.
- Identity-by-label is heuristic; there is no API path to the real session id.
- Token counts are good-faith estimates (upstream input/output counts can
  undercount; label them `~`).

---

## 9. Key evidence

- Spike: throwaway extension, `editor/title` + `activeWebviewPanelId ==
  'claudeVSCodePanel'`, rendered + fired over Claude's chat tab (2026-06-18).
- Token schema: live transcript on this machine — assistant lines carry
  `message.usage` + `message.model`, no `costUSD`, models mix (opus-4-7/4-8,
  fable-5).
- Competitor numbers read off live pages: ccusage ~16.3k, claude-monitor ~8.2k,
  agsoft ~7.7k installs (paid, telemetry-on, paywalled archive), Claude Chats ~6.6k
  (read-write), jhlee0409 ~1.6k.
- GitHub demand: #58161, #55291, #38235, #30916, #25130, #8701, #18645 (org/search/
  history requests, closed not-planned or duplicate).
- Cross-session memory note: `~/.claude/.../memory/nest-v2-chat-surface-findings.md`
  carries the condensed chat-surface finding for future sessions in this repo.
