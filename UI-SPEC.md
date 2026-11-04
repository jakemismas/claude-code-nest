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

## Sprint 5 fleet view (binding for Sprint 5 UI slices)

Status: BINDING for slices s5b-fleet-panel, s5b-open-running, s5c-robin and
s5c-settings. It adds the fleet view on top of the Sprint 3 contract above; where
they disagree for a fleet surface, this section wins. The owner's design boards
(ticket view, any-folder view, Settings, icon and wordmark, robin animations) are
private and are copied per machine to `.claude-working/mockup/` (gitignored). This
section restates every binding token from them so no private file is needed. Never
copy names or data from the boards; use made-up data only.

### Look

- Light theme first, theme-following (deviation 13 applies). Fallback light
  tokens: panel `#FBFAF8`, text `#1F1D1A`, border `#E6E2DA`, divider `#EDE9E2`,
  muted text `#6A645B`, quiet icon `#8A847A`, row hover `#F1EEE8`, input border
  `#DDD8CF`, input fill `#FFFFFF`. Dark fallbacks: panel `#1E1D1B`, text `#ECE9E3`,
  border `#3A3733`, divider `#2E2C29`, muted `#A39D93`, row hover `#2A2825`.
- Minimal text: names, agent tags, stage tags, status. No snippets in fleet rows.
- Font: the panel's UI font for text (13px rows, 11px counts and pills). The
  robin and the wordmark use the editor's monospace font
  (`var(--vscode-editor-font-family), Menlo, monospace`); see deviation 15.
- Header: centered robin plus wordmark, padding 26px 16px 16px, gap 14px. Wordmark
  20px, weight 700, letter-spacing -0.3px, the text "Nest" in the accent orange
  `#C2571A` (dark: `#E07B3C`).
- Controls row: padding 0 12px 10px, gap 6px. Search input 34px high, radius 8px.
  Active and Queue buttons 34px high, radius 8px, 1px border, padding 0 10px,
  weight 500, a 7px dot before the label. Active pressed: fill `#E3F4E8`, border
  `#8CCB9F`, text `#1C6E37`. Queue pressed: fill `#E2ECFB`, border `#9DBDEB`, text
  `#1A55AD`.
- Pinned orchestrator: card row, margin 2px 12px 0, min-height 40px, radius 10px,
  1px border, pin icon in accent, label "Orchestrator" weight 600, status dot at
  the end. "Past orchestrators": a 32px muted row with a chevron below it.
- Group row: min-height 36px, padding 4px 12px 4px 14px, gap 8px, 12px chevron
  rotating 90 degrees when open (0.15s), 16px status slot, muted id then title,
  then the stage pill. Any-folder groups use a 15x13 folder icon (accent stroke) or
  a 14px clock icon (date groups), a count in 11px muted text, and an 8px pulsing
  dot when any chat inside is live.
- Chat row inside a group: min-height 30px, padding 3px 12px 3px 40px (54px for a
  child chat, which also shows a muted `└`), gap 8px, status slot, agent tag, muted
  suffix.
- Queue list: card under the controls (margin 0 12px 8px, radius 10px, 1px
  border), rows 36px with an 8px blue dot, position number, muted key, title, stage
  pill. Read-only: no buttons on rows.
- Footer: "Archived" text button left, gear button right, top divider.

### Status dots (D16)

| Status | Mark |
|---|---|
| working | 8px dot `#2E9E57`, `pulse` 1.4s (box-shadow ring 0 to 5px, opacity 1 to .45) |
| needs | 15px amber circle `#E9A100` with a bold 10px "?" in `#2B1E00`, `qblink` 1s steps(2) |
| queued | 8px steady dot `#3B82D6` |
| done | 12px check, stroke `#3F8F5C` 1.6 |
| idle | 8px hollow ring, 1.5px `#9A948B` |

A group shows its most urgent chat's mark (needs, working, queued, done, idle).

### Pills and tags

- Stage pill: 11px, weight 500, padding 2px 8px, radius 999px. Colors by stage
  family: teal (fill `#DDF3EE`, text `#0E6656`), orange (`#FCE6D6`, `#9A410C`),
  blue (`#E2ECFB`, `#1A55AD`), green (`#DFF3E5`, `#1C6E37`). Default mapping:
  stages matching /fail/i are orange, `doneStages` green, /uat|review|test/i teal,
  everything else blue. The layout file's `tags` colors override by stage name.
- Agent tag (D18): 11px, weight 600, padding 1px 7px, radius 5px. build (fill
  `#E2ECFB`, text `#1A55AD`), fix (`#FCE6D6`, `#9A410C`), qa (`#ECE5F8`,
  `#55389A`), spike (`#DDF3EE`, `#0E6656`), review (`#F1EEE8`, `#4A453E`), capture
  (`#FBE3EC`, `#9A2A55`), orchestrator and other roles use review's colors.
- Dark theme: same hues, fills at 22 percent opacity over the panel, text lightened
  to keep 4.5:1.

### The robin (D15)

Block-character art, one span per colored segment, line-height 1, header size 9px.
Colors: head and back `#5B4A42`, wing `#8A7469`, breast `#D9692E`, beak `#C99413`,
branch `#8A5A3B`, leaf `#4E9A5B`. Rows (the eye glyph `▙` becomes `█` during a
170ms blink every 3.4s; the tail glyph `▀▀▀█` becomes `▝▀▀█` on a tail flick):

```
head   "      ▄██▖  "
head   "     ▟█" + eye "▙" + "██" + beak "▛" + " "
body   " ▄▟█" + wing "██" + "█" + breast "██▌" + "  "
body   tail "▀▀▀█" + wing "██" + "█" + breast "██▘" + "  "
body   "    ▀▜▀" + breast "▜▘" + "   "
branch "   ▀▀▀▀▀▀▀" + leaf "▘" + " "
```

The two head rows sit in their own element (transform-origin 54% 100%) inside a
root element that carries the whole-body animation; the branch row stays still.
Pixel note (one per working chat, colors cycling `#C2571A`, `#8C6FE0`, `#C99413`,
`#2E9E57`, at 0.45em):

```
" ▐▀▖"
" ▐  "
"▟█  "
```

Keyframes (root class / head class per state): idle `breathe` 3.2s / `look` 6s;
working `breathe` / `peck` 0.8s (`peckfast` 0.42s at 3 or more working chats, and
0.3s at 6 or more); worm `breathe` / `gulp` 1.8s plus a pink `~` (`#D46A86`)
shrinking at the beak; needs `hopwait` 1.4s / `tiltq` 1.2s plus a pulsing "?"
(`#C98A00`, `qpulse` 1s); done `celebrate` 1.6s plus notes `♪ ♫` (`floatup` 1.6s)
and a `+ * ·` sparkle burst (`burst` 1.6s, staggered .25s); error `shake` 0.45s
plus a red "!" (`#C8462E`); sleep `snore` 3.4s / `tuck` (rotate 16deg) plus
`z Z` (`#6A8CC8`, `floatup`); handoff `handoff` 3.2s (fly up and out, land from
the other side). Exact keyframe bodies:

```
breathe   0%,100% scale(1); 50% scale(1.025)
look      0%,70%,100% rotate(0); 76%,88% rotate(-12deg)
peck      0%,100% rotate(0); 45% rotate(26deg); 60% rotate(22deg)
gulp      0%,35% rotate(0); 50% rotate(30deg); 65% rotate(-6deg); 80%,100% rotate(0)
tiltq     0%,100% rotate(-8deg); 50% rotate(-15deg)
hopwait   0%,55%,100% translateY(0); 65% -.5em; 75% 0; 82% -.22em; 90% 0
celebrate 0% 0; 20% translateY(-.9em) rotate(-6deg); 40% 0; 55% translateY(-.45em) rotate(4deg); 70%,100% 0
shake     0%,100% translateX(0); 25% translateX(-.12em) rotate(-2deg); 75% translateX(.12em) rotate(2deg)
snore     0%,100% scale(1); 50% scale(1.04,1.03)
handoff   0%,12% at rest; 42% translate(5em,-3em) rotate(-10deg) opacity 0; 58% translate(-5em,-3em) rotate(10deg) opacity 0; 88%,100% at rest
floatup   0% opacity 0 translate(0,.4em); 25% opacity 1; 100% opacity 0 translate(.7em,-1.8em)
burst     0% opacity 0 scale(.2); 30% opacity 1 scale(1.2); 100% opacity 0 scale(1.7)
qpulse    0%,100% scale(1); 50% scale(1.2)
pulse     0%,100% box-shadow 0 0 0 0 rgba(46,158,87,.55) opacity 1; 50% box-shadow 0 0 0 5px rgba(46,158,87,0) opacity .45
qblink    0% opacity 1; 100% opacity .35
```

New states this sprint (s5c-robin designs them in the same idiom): hatch (an egg
of block characters cracks, then the robin appears), milestone (double celebrate
with a larger burst), night (crescent moon `☾` in `#6A8CC8` beside the sleeping
robin, breathe slowed to 5s).

### Settings overlay additions

Three sections in this order, each with an 11px uppercase muted label
(letter-spacing 0.08em): "Group chats by" (a four-option segmented control in a
`#F1EEE8` track, radius 10px, options 32px high, radius 8px, the pressed option
white with a 0 1px 2px shadow and weight 600) with the caption "Auto: tickets when
an orchestrator records them, otherwise folders, then date."; "Layout file" (a 44px
white row, radius 10px, `.nest/config.json` in monospace 12px, an Open button 30px
high); "Robin" (a 44px row with "Animations" and a 34x20 switch, on = `#2E9E57`).

### Agreed deviations for the fleet view (do not flag these in review)

14. The wordmark reads "Nest", not the boards' local-build wordmark (D11: the
    public build drops the trademark from its name; the extension itself is not
    renamed).
15. No bundled JetBrains Mono: the robin and wordmark use the editor's monospace
    font, which renders the same block characters. A bundled font would need a new
    licensed asset.
16. The boards' fixed 380x960 frame is a mockup frame; the panel is fluid from
    260px to 480px (deviation 1).
17. Starred and Questions sections from Sprint 3 stay above the fleet layout and
    show only when non-empty, so no existing feature is removed.
18. Mock data in the harness and in screenshots is made up and differs from the
    boards' sample data on purpose.
