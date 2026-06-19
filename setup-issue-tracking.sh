#!/usr/bin/env bash
set -euo pipefail

# One-time GitHub Issues tracking setup for jakemismas/claude-code-nest.
# Labels are server-side (run once, any machine). The board needs the
# 'project' token scope: gh auth refresh -s project

# --- Labels (must exist before issue forms can apply them) ----------------
mklabel() { gh label create "$1" --color "$2" --description "$3" --force; }
mklabel "type: feature"  "a2eeef" "New capability"
mklabel "type: bug"      "d73a4a" "Defect or incorrect behavior"
mklabel "type: task"     "bfdadc" "Unit of work under a feature"
mklabel "type: chore"    "fef2c0" "Maintenance, deps, version bumps"
mklabel "priority: high" "d93f0b" "Do next"
mklabel "priority: med"  "fbca04" "Normal"
mklabel "priority: low"  "0e8a16" "Someday"
mklabel "blocked"        "000000" "Waiting on something"
# area: labels — one per code area
mklabel "area: ui"       "1d76db" "Webviews, views, rendering"
mklabel "area: chat"     "5319e7" "Claude chat surface integration"
mklabel "area: commands" "0052cc" "Command palette commands"
mklabel "area: store"    "006b75" "Persistence, model, settings state"
mklabel "area: dnd"      "b60205" "Drag and drop"
mklabel "area: build"    "5319e7" "Extension wiring, packaging, VSIX"
mklabel "area: docs"     "c5def5" "Documentation"

# --- Status board ---------------------------------------------------------
# Needs the 'project' token scope: gh auth refresh -s project
gh project create --owner "@me" --title "claude-code-nest tracking"
echo "Board created. Three one-time steps in the Project UI (no reliable CLI):"
echo "  1. Add a Status option 'In Review' between In Progress and Done."
echo "  2. Workflows -> enable 'Auto-add to project' for this repo's issues."
echo "  3. Workflows -> enable 'Item closed -> Status: Done'."

# --- Keep per-machine settings out of git --------------------------------
grep -qxF '.claude/settings.local.json' .gitignore 2>/dev/null \
  || echo '.claude/settings.local.json' >> .gitignore
