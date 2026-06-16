# Changelog

All notable changes to Claude Code Nest are recorded here. The format follows
Keep a Changelog, and the project adheres to semantic versioning.

## [Unreleased]

### Added

- Slice 0 (scaffold, read JSONL, flat list): the namespaced claudeNest Activity
  Bar view container and the claudeNest.flat tree view listing every chat for the
  active workspace as a title plus a relative time. Clicking a chat fires Claude
  Code's documented URI handler (vscode://Anthropic.claude-code/open?session=...)
  through an injectable openExternal. New modules: src/model/types.ts,
  src/claude/jsonlReader.ts (tolerant line-type scan), src/claude/chatScanner.ts
  (read-only *.jsonl glob under ~/.claude/projects), src/claude/projectKeyResolver.ts
  (encodes every non-[A-Za-z0-9-] character to a hyphen, matching Claude's on-disk
  rule, plus case-insensitive drive-letter match and cwd-scan fallback),
  src/launch/uriLauncher.ts, src/views/relativeTime.ts (vscode-free relative-time
  formatter), src/views/flatProvider.ts. Headless unit tests cover the reader,
  resolver (including a non-separator special-character row), relative-time
  boundaries, launcher, and scanner against scratch fixtures.
- Read-only chokepoint lint guard: a bank of eslint no-restricted-syntax
  selectors bans every write-capable fs call outside the sanctioned settings-IO
  module (src/settings/claudeSettingsIO.ts) and the test fixtures, at every entry
  point a write can take: member call (fs.writeFileSync), computed access
  (fs['writeFileSync']), named/destructured import from fs/node:fs/fs/promises,
  require destructure, alias (const w = fs.writeFileSync), and the bare call once
  in scope. A namespace import (import * as fs) stays legal because writes through
  it are member or computed calls already covered. Lint is wired into pretest, so
  it runs as part of the headless `npm test` gate, enforcing the "nothing writes
  under ~/.claude/projects/" invariant in CI rather than by review alone.
- Initial repository scaffold: minimal TypeScript VSCode extension (package.json
  with engines.vscode ^1.66.0, tsconfig, eslint, mocha unit harness), the
  PLAN.md slice cut, the ARCHITECTURE.md binding design rules and sync
  architecture, an empty DECISIONS.md, and the .claude/workflows/nest-slice-build.js
  autonomous build-orchestration workflow.
