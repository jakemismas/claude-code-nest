# Fidelity reference screenshots

These are the frozen visual baseline for the Sprint 3 "One Panel" redesign. Every
UI slice must pass a by-eye comparison against them before its review is dry
(UI-SPEC.md "Fidelity rules").

## Files

- `prototype-320.png` - the design authority (`media/design/ChatSidebar.html`)
  rendered at the 320px reference width (UI-SPEC.md deviation 1), captured after the
  embedded React bundle mounts and its `#__bundler_thumbnail` unpack placeholder is
  removed, then clipped to the 320px sidebar column (the mock VS Code window chrome
  and activity-bar rail are cropped out). Captured at a 2x device scale, so the file
  is 640px wide.

## How these are produced and used

`npm run fidelity` (see `scripts/fidelity/`) renders both the design prototype and
the real org-panel webview asset headlessly and writes fresh screenshots to
`.claude-working/fidelity/` (gitignored):

- `.claude-working/fidelity/harness.png` - the REAL shipped panel asset
  (`media/orgPanel.css` + `media/orgPanel.js`) driven by synthetic mock data through
  `scripts/fidelity/harness.html`. This is what the panel actually renders.
- `.claude-working/fidelity/prototype.png` - a fresh render of the prototype,
  produced the same way as the committed baseline.

The reviewer (and the build agent) open `harness.png` beside `prototype-320.png`
and eyeball the panel against the handoff. The visual-fidelity review lens is
exactly this: run the harness, read the two images, and judge convergence. Pixel
diffing is a deliberate non-goal (issue #79); the gate is reviewer-eye plus the
human check.

Re-capture the baseline only when the prototype itself changes, by copying a fresh
`.claude-working/fidelity/prototype.png` over `prototype-320.png`.

All mock data in the harness is synthetic. No real transcript content is committed.
