# UI-SPEC.md: the binding UI contract (Sprint 3, "One Panel")

Status: BINDING for Sprint 3 and later. Supersedes the Sprint 2 UI-SPEC (which bound
slices to media/mockups/sidebar-mockup.html; that mockup is retired as a design
authority and kept only for history).

## The design authority

The definitive visual and behavioral reference is the Claude-design handoff bundle at
`media/design/`:

- `media/design/ChatSidebar.html`: the self-contained working prototype. Open it in a
  browser; it IS the spec. When prose and prototype disagree, the prototype wins unless
  the deviation table below says otherwise.
- `media/design/README.md`: the handoff prose (fidelity contract, design tokens, section
  anatomy, interactions, state model). All colors, spacing, typography, radii, shadows,
  and animations in it are FINAL and are to be matched verbatim.
- `media/design/reference/`: reference screenshots of the prototype rendered at 320px
  (produced by the visual harness slice; the fidelity comparison baseline).

The product is ONE VS Code sidebar view (the existing `claudeNest.orgPanel` webview,
rebuilt to this design). No other Nest view survives the sprint: the flat Chats tree,
Smart Groups tree, Archive tree, and the settings editor tab are all retired. Settings
and Archive live INSIDE the panel as full-panel overlay sub-pages per the handoff.

## Fidelity rules

- SUPERSEDED by deviation 13 (issue #118, owner decision 2026-07-08): the panel's
  surfaces, text, and borders now follow the active VS Code theme; only the accent
  family stays the hardcoded Claude orange. The original rule (palette hardcoded
  verbatim, user decision 2026-07-01) still describes the FALLBACK values and what
  the themeless fidelity harness renders.
- Section order, row anatomy, paddings, font sizes, colors, radii, shadows, the focus
  glows (orange main, gray archive), the drop highlight, and the popover styling follow
  `media/design/README.md` exactly.
- The Newsreader serif for sub-page headings is bundled in the VSIX and loaded from the
  extension's local resources (never from the network; CSP and the telemetry-free rule
  both forbid a Google Fonts fetch). If bundling fails, fall back to a local serif stack.
- Every UI slice must pass the screenshot harness comparison against
  `media/design/reference/` before its review is dry.

## Data mapping (design concept to Nest source)

| Design concept | Nest source |
|---|---|
| Chat title, age | Existing scan snapshot (`ChatRecord`); age formatted 35m / 3h / 1d / 2w / 1mo |
| Full-text search over messages | Tier-A text plus the MiniSearch index over on-demand bodies (`src/search/`) |
| Body-match snippet (`You: ... / Claude: ...`) | Search result snippet builder, role-prefixed |
| Tags, tag colors | Metadata store tags (synced); the 8-color handoff palette becomes the swatch picker |
| Folders, subfolders, folder color | Metadata store folders (synced). Data supports deeper nesting; the UI renders and creates at most one sublevel per the design; deeper legacy folders render clamped at depth 2, never destroyed |
| Starred | `ChatMeta.starred` (synced) |
| Archived | `ChatMeta.userArchived` + `archivedAt` (synced) plus the Nest-owned body copy in globalStorage |
| `status: 'question'` (blinking ? badge) | Unread assistant turn whose text asks something (question mark or input request near the end) |
| `status: 'done'` (solid dot) | Unread assistant turn that is not a question (see read-state below) |
| Token totals (`~NNk`) | Tier-A `tokenTotals`, labeled approximate; surfaced in the token rollup only (the per-row badge was removed in s3a and the hover card was retired by #117) |
| New session button | Best-effort launch of a new Claude Code chat via the `claude-vscode.*` contributed commands or the public URI handler, with a graceful failure message |
| Open chat (row click sets active) | Existing resume-by-URI launch; active detection is the Tabs-API label-match heuristic (named chats only) |
| Auto-archive ("chats older than N days move to Archive") | Nest org-layer auto-archive at the keep-window setting; default keep-window follows the user's effective Claude `cleanupPeriodDays` (30 if unset); a body copy is taken at archive time; starred chats are never auto-archived but receive a protective body copy before Claude's deletion age |

## Read state (new, local-only)

Per-device `lastSeenAt` per chat, stored in workspace/global Memento state, NEVER synced
(like sort and collapse state). The unread dot and the Questions badge show when the last
message is an assistant turn newer than `lastSeenAt`. Cleared by: opening the chat
through Nest, the chat's tab gaining focus (label-match, named chats only), or a newer
user message in the transcript. Known accepted gap: reading an unnamed chat directly in
Claude's UI without replying does not clear it.

## Agreed deviations from the handoff (do not flag these in review)

1. Panel width: 320px is the design target, but VS Code controls sidebar width; the
   layout must stay sane from about 260px to 480px. Reference screenshots are 320px.
2. The `status: 'done'` dot maps to "unread assistant reply that is not a question"
   (user decision, 2026-07-01); rows the user has seen show an empty status slot.
3. The blinking `?` animation is disabled under `prefers-reduced-motion` (static badge).
4. Active-row highlight is best-effort (tab label heuristic); when no active chat can be
   identified, no row is highlighted.
5. The webview keeps its full keyboard and ARIA tree implementation (focus order, roles,
   Enter/Space activation, arrow navigation, visible focus ring) even though the handoff
   does not mention accessibility; the panel is now Nest's only surface.
6. "New session" and "open chat" ride undocumented Claude Code contact points and may
   degrade gracefully (toast on failure) rather than being guaranteed.
7. Export downloads become VS Code save dialogs through the existing exportIO chokepoint.
8. The prototype's in-memory state is replaced by the existing metadata store, sync, and
   settings machinery; UI-only state (sort, collapsed set, section toggles, read state,
   archive search) is local Memento state, never synced.
9. Sort-popover focus ring on open (slice s3c-fidelity-sweep). When the sort popover
   opens, the panel programmatically focuses the active item, so the fidelity capture
   shows a focus ring (the `:focus-visible` inset accent box) around "Newest first" that
   the prototype does not draw (the prototype does not move focus into its popover). The
   at-rest chrome matches the handoff exactly (checkmark `#d97757` on the active item;
   README line 25); the ring is correct ARIA focus behavior for a keyboard-opened menu,
   not a styling deviation from the tokens. Do not flag it as a mismatch against
   `sort-popover-320.png`.
10. New-folder popover anchor position and baseline framing (slice s3c-fidelity-sweep).
    The shipped panel anchors the New folder popover to the FOLDERS-header `＋` button
    (mid-panel); the prototype floats it to the viewport top-left, above and left of the
    320px sidebar box. The popover CONTENT and chrome (NEW FOLDER title, "Folder name"
    input with the accent focus ring, filled `#d97757` Create button, text Cancel) match
    the handoff (README line 73); only the anchor offset differs, driven by each surface's
    own layout. Because the prototype floats the popover outside the sidebar box, the
    committed `newfolder-popover-320.png` baseline is clipped to the UNION of the sidebar
    column and the floating popover (not the sidebar alone), so the whole popover chrome is
    in frame; this makes that one baseline wider than the other 640px references and makes
    it include a thin sliver of the mock activity-bar rail and window title bar under the
    floated popover. Compare the popover chrome against the harness capture; do not flag the
    anchor offset, the wider frame, or the surrounding mock chrome against
    `newfolder-popover-320.png`.
11. Four fidelity states have NO prototype-side (`ChatSidebar.html`) baseline and are
    captured harness-only (slice s3c-fidelity-sweep; originally five until the hover
    card's retirement, deviation 12): the chat context menu (tag-list mode), the
    context menu (create-tag mode), the drag drop-highlight, and the inline folder
    rename. This narrows issue #88 AC #2 ("the same states are captured from
    `media/design/ChatSidebar.html`") for these four: the compiled prototype exposes
    no headless path to them. The two interaction states (drop-highlight, rename) are
    pure mid-drag / transient in-list states with no reachable prototype path; the
    body-level overlays (both context-menu modes) follow the s3a-visual-harness
    harness-only convention for transient overlays. Their committed baselines are the
    REAL shipped-asset harness captures (`drop-highlight-320.png`, `rename-320.png` in
    `media/design/reference/`; the menu overlays are eye-compared against the
    prototype at review time), since the shipped asset is the authority for its own
    chrome and each is styled to the exact README tokens. The other six states
    (default, filtered results, settings overlay, archive overlay, sort popover,
    new-folder popover) do get a `ChatSidebar.html` clip, but only three of them are
    FROZEN as committed baselines under `media/design/reference/` (default, sort popover,
    new-folder popover); the remaining three (filtered results, settings overlay, archive
    overlay) are headlessly drivable and are compared each run against a runtime-fresh
    prototype clip written to the gitignored `.claude-working/fidelity/`, with no frozen
    committed baseline, by design per the `media/design/reference/README.md` methodology
    (the committed set is a curated frozen baseline, not a per-state mirror). Full probe
    evidence is in DECISIONS.md Slice s3c-fidelity-sweep. Do not flag the absence of a
    prototype-side baseline for these four states, nor the intentional absence of a frozen
    committed baseline for filtered results / settings / archive, in review.
12. The rich hover preview card is RETIRED (issue #117, owner verify-gate decision,
    2026-07-08). The prototype and issue #84 specify a floating preview card on chat-row
    hover; the shipped panel intentionally renders NO hover card, and the `previewBody`
    host round-trip was removed with it. The owner's post-mockup decisions supersede the
    prototype here. Do not flag the missing hover card against `ChatSidebar.html`, and do
    not re-introduce a hover surface without a new decision.
13. Theme-driven surfaces (issue #118, owner verify-gate decision, 2026-07-08),
    superseding the hardcoded-palette fidelity rule. Every surface, text, border, and
    quiet-control token in media/orgPanel.css now reads the active VS Code theme
    (sideBar/list/input/editorWidget/descriptionForeground and friends); the accent
    family (`#d97757` and its hover/deep/soft variants) and content colors (tag and
    folder swatches) stay hardcoded. Each theme token falls back to the original
    handoff value, so the fidelity harness, which defines no `--vscode-*` variables,
    still renders the handoff palette and the committed reference baselines remain
    the comparison authority for GEOMETRY and for accent usage. In a live VS Code the
    panel intentionally does NOT match the prototype's colors on non-matching themes.
    Do not flag theme-following surface colors against `ChatSidebar.html`; do flag a
    wrong accent, wrong geometry, or unreadable text on a light or dark theme.

## The read-only line (unchanged, sacred)

Nothing in this design writes, renames, moves, or deletes under `~/.claude/projects/`.
Auto-archive is an org-layer flag plus a Nest-owned body copy in globalStorage. All file
writes go through the settings chokepoint or exportIO behind
`assertNotUnderClaudeProjects`.
