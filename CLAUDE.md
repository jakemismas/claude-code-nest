# Claude Code - Nest

## Project tracking — GitHub Issues are the source of truth

This repo tracks all work in GitHub Issues. Before starting any task, read the
relevant issue; if none exists, create one. Status lives on the project board,
not in chat or code.

- Hierarchy: feature = parent issue (`type: feature`); tasks/sub-bugs = native
  sub-issues (`gh issue create --parent <n>`). Branch with
  `gh issue develop <n> --checkout`.
- Labels: one `type:` (feature|bug|task|chore), one `priority:`, one `area:`.
- Issue bodies use Description / Acceptance criteria (testable checkboxes) /
  Non-goals, written in AWS docs style: active voice, present tense, second
  person, concise, sentence-case headings, no "please/simply/just".
- On starting: comment the plan, move the card to In Progress. On finishing:
  comment implementation notes and open a PR with `Fixes #<n>`.
- Log discovered work as new issues. Never leave a code-only TODO.

## Sprint operations - advanced suite

This repo runs as autonomous sprints (advanced-sprint-orchestration).
- Read .claude/sprint/STATE.md before doing anything. It names the active
  sprint, phase, part, chat assignments, and the next action.
- One chat per work unit (R&D, planning, each build part, verification,
  release). At 60 percent context, write your handoff into STATE.md and stop.
  Rotate to a fresh chat; never rely on /compact to keep working. In this
  repo the rotation rule replaces any global compact-at-70-to-80-percent
  protocol: do not compact, rotate.
- All work lands through the slice engine or as PR-per-change with Fixes #n.
  Done means evidence observed on the landing branch named in STATE.md
  (origin/main unless the sprint plan names an integration branch), never a
  claimed success.
- Project parameters (trailer prefix, testCommand, installCheck, sacred
  constraints) live in .claude/skills/sprint-ops/SKILL.md.
- Public repo: no client names, people names, ticket numbers or client paths
  in code, tests, fixtures, docs or screenshots. The pre-push check in
  scripts/ refuses a push containing any word from the untracked list at
  ~/.config/nest/private-words.txt.
