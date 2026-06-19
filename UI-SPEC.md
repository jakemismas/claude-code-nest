# Sprint 2 UI design reference (sidebar org panel)

The visual target for the sidebar work (slices 1, 2, and 6) is the mockup at
`media/mockups/sidebar-mockup.html`. Open it in a browser to see the two density frames
(Comfortable and Compact) rendered with the intended layout, palette, and card anatomy.

Scope: this spec covers the SIDEBAR / org panel only. The "Chat window" tab in the source
mockup (context-health bar, compact button, live token readout, transcript, composer) is
dropped as impossible for a third-party extension; see DECISIONS.md and V2-RESEARCH.md.

Fidelity rule: build to the INTENT below, not to the pixel. The build agent cannot see its
own rendered webview, so visual exactness is a human smoke check in TESTING.md, never an
automated gate. The adversarial review must not churn on cosmetic mismatches it cannot verify.

## Theme and palette

- Light theme, Claude clay accent `#d97757` as the single brand highlight (selection bar,
  active item, primary affordance).
- Prefer VS Code theme CSS variables for surfaces, text, and borders so the panel adapts to
  the user's theme; use the clay accent as the deliberate brand overlay on top.
- Custom scrollbars and subtle card shadows are acceptable; keep contrast accessible.

## Density modes

- Two modes, toggled and persisted: Comfortable (spacious rows, visible tag labels, relaxed
  vertical rhythm) and Compact (dense rows, more chats on screen, smaller type).
- The same data and structure render in both; only spacing, type scale, and chip verbosity change.

## Row and card anatomy

- A chat row shows: title (truncated, single line), relative time, and a `~`token badge.
- Colored tag chips on the row (labels in Comfortable, dots or compressed chips in Compact).
- Hover preview card adds: folder, age, `~`token total, full tag set, and a first/last message
  snippet. This is the rich preview from slice 1; it is a preview, not a transcript renderer.

## Sections (top to bottom)

1. Starred (pinned chats; hidden entirely when none).
2. Questions (chats awaiting your reply; a scan-time heuristic labelled as such, not live;
   hidden when none). See slice 6.
3. Folders (nested, collapsible; each folder shows its color and chat count; a "collapse one
   level" control).
4. Unsorted (catch-all for chats with no folder; always present).

A flat recency grouping (Today, This week, and so on) is the existing chatsPreview behavior and
is the home for search results.

## Controls

- Full-text search box; results show a matching snippet under the title (slice 2).
- Tag filter chips: clickable, colored, combinable with search.
- Sort: Newest first, Oldest first, Name (A-Z).
- Folders: create via name prompt; double-click to rename; right-click to set color;
  drag-and-drop chats between folders; drop on Unsorted to unfile.
- Click a row to open or resume the chat through the existing URI handler.

## Accessibility (acceptance criteria for slice 6, not polish)

- ARIA tree semantics (role tree / treeitem / group), correct focus order, roving tabindex.
- Full keyboard navigation: arrow keys to move, Enter or Space to activate, a visible focus ring.
- The native flat Chats TreeView is kept as the accessible fallback while the org panel is the
  primary webview surface.
