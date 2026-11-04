---
name: sprint-ops
description: Project parameters for the advanced sprint suite in the Nest repo. Load whenever running any sprint phase, build part, or engine invocation here.
---
# Sprint ops parameters for claude-code-nest

- identity: Jake Mismas <jake@jakemismas.com>
- trailerPrefix: Nest
  (Never change it: exact-match resume would orphan every existing trailer.)
- testCommand: npm run lint && npm run compile && npm test
- installCheck: npx @vscode/vsce package --no-dependencies -o build-check.vsix
- packageCommand: npx @vscode/vsce package --no-dependencies
- visualReference: UI-SPEC.md (binding), with the private mockup boards copied
  per machine to .claude-working/mockup/ (gitignored; never commit them)
- sacredConstraints:
  - Nothing writes under ~/.claude/projects/ (transcripts are read-only).
  - Nest never writes a fleet record (dev/fleet.jsonl) or a queue file; it only reads them.
  - No client names, people names, ticket numbers or client paths in code, tests, fixtures, docs or screenshots.
  - The extension is not renamed and not published to the Marketplace.
- planDoc: SPRINT-<N>-PLAN.md (pass it as args.planDoc every sprint)
- engine: .claude/workflows/nest-slice-build.js
- landing: Sprint 5 lands on the local integration branch named in its plan
  (args.integrationBranch); pushes and pull requests happen only inside a
  posting window Jake opens, and nothing merges to main without Jake.
