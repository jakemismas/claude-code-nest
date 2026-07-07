# Fidelity reference screenshots

These are the frozen visual baseline for the Sprint 3 "One Panel" redesign. Every
UI slice must pass a by-eye comparison against them before its review is dry
(UI-SPEC.md "Fidelity rules").

## Files

Each baseline is a 320px reference width capture (UI-SPEC.md deviation 1) at a 2x
device scale, so most files are 640px wide. The one exception is
`newfolder-popover-320.png`: the prototype floats that popover outside the 320px
sidebar box, so its baseline is clipped to the union of the sidebar and the popover
and is wider than 640px (see its entry below).

- `prototype-320.png` - the default sectioned state, from the design authority
  (`media/design/ChatSidebar.html`), captured after the embedded React bundle mounts
  and its `#__bundler_thumbnail` unpack placeholder is removed, then clipped to the
  320px sidebar column (the mock VS Code window chrome and activity-bar rail are
  cropped out).
- `sort-popover-320.png` - the Sort popover open, from the prototype (its `⇅` Sort
  glyph clicked), clipped to the sidebar. Baseline for the sort-open state.
- `newfolder-popover-320.png` - the New folder popover open, from the prototype (its
  `＋` New folder glyph clicked). Baseline for the new-folder-open state. The prototype
  floats this popover to the viewport top-left, ABOVE and LEFT of the sidebar clip origin,
  so this one baseline is clipped to the UNION of the sidebar column and the floating
  popover (not the sidebar alone) to keep the whole popover chrome in frame; the union
  therefore includes a thin sliver of the mock activity-bar rail and window title bar under
  the floated popover. Compare the popover chrome (NEW FOLDER title, Folder name input,
  filled Create, text Cancel), not that surrounding mock chrome. See UI-SPEC deviation 10.
- `drop-highlight-320.png` - a folder row showing the drag drop target highlight
  (background `#FAE6DC`, inset ring `#d97757`; design README line 70). Captured from
  the REAL shipped panel asset through the harness, because the drop highlight is a
  pure mid-drag interaction state with no headlessly reproducible path in the compiled
  prototype (see DECISIONS.md Slice s3c-fidelity-sweep). The shipped asset is the
  authority for its own drop-highlight chrome, styled to the README tokens.
- `rename-320.png` - a folder header in its in-place inline rename state (the
  `.nest-rename-input` with the accent border replacing the folder name). Captured
  from the REAL shipped panel asset through the harness, for the same reason as
  `drop-highlight-320.png` (the rename input is a transient in-list state with no
  reproducible prototype path).

## How these are produced and used

`npm run fidelity` (see `scripts/fidelity/`) renders both the design prototype and
the real org-panel webview asset headlessly and writes fresh screenshots to
`.claude-working/fidelity/` (gitignored). For each state it writes a `harness-*.png`
(the REAL shipped panel asset, `media/orgPanel.css` + `media/orgPanel.js`, driven by
synthetic mock data through `scripts/fidelity/harness.html`) and, for the states the
prototype can be driven to headlessly, a matching `prototype-*.png` (a fresh clip of
the design authority).

The reviewer (and the build agent) open each `harness-*.png` beside its baseline in
this directory and eyeball the panel against the handoff. The visual-fidelity review
lens is exactly this: run the harness, read the images, and judge convergence. Pixel
diffing is a deliberate non-goal (issue #79); the gate is reviewer-eye plus the human
check.

## Re-baselining (promotion path)

Re-capture a baseline only when the prototype itself changes (for a prototype-side
baseline) or when the shipped asset's chrome for a harness-only state changes
intentionally (for a harness baseline). Run `npm run fidelity`, then copy the fresh
capture from `.claude-working/fidelity/` over the matching file here:

- `prototype.png` -> `prototype-320.png`
- `prototype-sort-popover.png` -> `sort-popover-320.png`
- `prototype-newfolder-popover.png` -> `newfolder-popover-320.png`
- `harness-drop-highlight.png` -> `drop-highlight-320.png`
- `harness-rename.png` -> `rename-320.png`

All mock data in the harness is synthetic. No real transcript content is committed.
