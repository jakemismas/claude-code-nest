# Contributing

Thanks for helping improve Claude Code Nest. This guide covers setup, checks and the rules every change must keep.

## Setup

You need Node 20 or later and VS Code.

```sh
git clone https://github.com/jakemismas/claude-code-nest.git
cd claude-code-nest
npm ci
```

## Tests and lint

```sh
npm run lint              # ESLint, including the write-ban rules
npm run compile           # TypeScript build
npm test                  # lint, compile and unit tests
npm run test:integration  # extension host tests in a real VS Code
npm run fidelity          # panel screenshots in .claude-working/fidelity/
```

Add a test for new behavior. Prefer a real file or store over a mock when it is cheap to use one. Tests that read transcripts must use scratch copies, never real files.

## Invariants

A pull request that breaks one of these will not be merged. [docs/architecture.md](docs/architecture.md) explains each in more detail.

1. Never write under `~/.claude/projects`. Nest only reads transcripts.
2. No network access and no telemetry.
3. All file writes go through two chokepoints: `src/store/exportIO.ts` and `src/settings/claudeSettingsIO.ts`. Lint bans every other write-capable filesystem call in `src/`. Do not add exemptions.
4. No runtime dependencies. Dev dependencies are fine.
5. The webview keeps its Content Security Policy. Put data in the page with `textContent`, never `innerHTML`.

## Commit style

- Write the subject in the imperative mood, under 70 characters.
- Explain why in the body. Skip the body for trivial changes.
- Keep comments in code short and about why, not what.

## Pull requests

- Make one change per pull request.
- Link the issue with `Fixes #n` in the description.
- Make sure CI is green before you ask for review.
- Update `CHANGELOG.md` under Unreleased for user-visible changes.

## Optional: maintainer private-word check

Maintainers can run a local check that refuses a push containing words from a private list, such as names that must not appear in a public repo. The list lives outside the repo at `~/.config/nest/private-words.txt` (one word or phrase per line), or at the path in `NEST_PRIVATE_WORDS`.

```sh
npm run check:private -- origin/main..HEAD
```

It exits 0 when clean, 1 when a listed word is found, and 2 when the check cannot run, including when the list is missing. Contributors do not need it.
