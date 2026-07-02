import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard for the s3a-view-consolidation docs findings: retiring a view
// must not leave README advertising a command that no longer has any UI surface
// (the "Export Chat..." case), and a command left surfaceless must be an
// explicitly accepted interim gap rather than a silent orphan. Both checks read
// the same package.json the extension ships, so a future slice that removes a
// menu or view contribution fails here and forces a docs decision.
//
// Compiled tests run from out/test/unit and sources live in src/test/unit; the
// repo root is three levels up from either.
const repoRoot = path.resolve(__dirname, '..', '..', '..');

interface CommandContribution {
  command: string;
  title: string;
}

interface MenuEntry {
  command?: string;
  when?: string;
}

interface Manifest {
  engines: { vscode: string };
  activationEvents: string[];
  contributes: {
    commands: CommandContribution[];
    menus: Record<string, MenuEntry[]>;
  };
}

// The lowest VS Code version whose declared engines floor grants contributed
// commands an implicit onCommand activation event. Below it, a command whose
// only surface is the Command Palette must declare onCommand explicitly or a
// palette invocation before first activation fails with "command not found".
const IMPLICIT_COMMAND_ACTIVATION_MAJOR = 1;
const IMPLICIT_COMMAND_ACTIVATION_MINOR = 74;

function enginesFloorHasImplicitActivation(range: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(range);
  if (!m) {
    return false;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return (
    major > IMPLICIT_COMMAND_ACTIVATION_MAJOR ||
    (major === IMPLICIT_COMMAND_ACTIVATION_MAJOR &&
      minor >= IMPLICIT_COMMAND_ACTIVATION_MINOR)
  );
}

// Commands contributed to a non-palette menu (view/title, view/item/context)
// activate the extension through their view's onView event, so only commands
// whose sole surface is the palette need an explicit onCommand activation.
function paletteOnlyCommandIds(manifest: Manifest): string[] {
  const menus = manifest.contributes.menus;
  const paletteHidden = new Set(
    (menus.commandPalette ?? [])
      .filter((e) => e.when === 'false' && typeof e.command === 'string')
      .map((e) => e.command as string),
  );
  const inNonPaletteMenu = new Set<string>();
  for (const [menuId, entries] of Object.entries(menus)) {
    if (menuId === 'commandPalette') {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry.command === 'string') {
        inNonPaletteMenu.add(entry.command);
      }
    }
  }
  return manifest.contributes.commands
    .map((c) => c.command)
    .filter((id) => !paletteHidden.has(id) && !inNonPaletteMenu.has(id))
    .sort();
}

function loadManifest(): Manifest {
  const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

// A command counts as UI-reachable when it is visible in the Command Palette
// (no commandPalette entry hiding it with when "false") or contributed to any
// non-palette menu (view/title buttons, view/item/context row actions).
function reachableCommandIds(manifest: Manifest): Set<string> {
  const contributed = manifest.contributes.commands.map((c) => c.command);
  const paletteHidden = new Set(
    (manifest.contributes.menus.commandPalette ?? [])
      .filter((e) => e.when === 'false' && typeof e.command === 'string')
      .map((e) => e.command as string),
  );
  const reachable = new Set(contributed.filter((id) => !paletteHidden.has(id)));
  for (const [menuId, entries] of Object.entries(manifest.contributes.menus)) {
    if (menuId === 'commandPalette') {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry.command === 'string') {
        reachable.add(entry.command);
      }
    }
  }
  return reachable;
}

describe('command surfaces stay honest after the s3a view consolidation', () => {
  it('every command README lists in its Commands section has a UI surface', () => {
    const manifest = loadManifest();
    const reachable = reachableCommandIds(manifest);
    const idByTitle = new Map(
      manifest.contributes.commands.map((c) => [c.title, c.command]),
    );

    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const start = readme.indexOf('\n## Commands');
    assert.ok(start >= 0, 'README has a "## Commands" section');
    const rest = readme.slice(start + 1);
    const end = rest.indexOf('\n## ');
    const section = end >= 0 ? rest.slice(0, end) : rest;

    // Bold spans in the section that exactly match a contributed command title
    // are the commands README promises the user can run.
    const listed: Array<{ title: string; id: string }> = [];
    for (const match of section.matchAll(/\*\*([^*]+?)\*\*/g)) {
      const id = idByTitle.get(match[1]);
      if (id) {
        listed.push({ title: match[1], id });
      }
    }
    // Sanity floor so a section rename cannot green this test by matching nothing.
    assert.ok(
      listed.length >= 8,
      'expected README to list several commands, found ' + String(listed.length),
    );
    for (const { title, id } of listed) {
      assert.ok(
        reachable.has(id),
        'README lists "' +
          title +
          '" (' +
          id +
          ') but it is palette-hidden and contributed to no menu; ' +
          'either restore a surface or move it to a documented interim gap',
      );
    }
  });

  it('surfaceless commands are exactly the accepted interim gaps', () => {
    const manifest = loadManifest();
    const reachable = reachableCommandIds(manifest);
    const surfaceless = manifest.contributes.commands
      .map((c) => c.command)
      .filter((id) => !reachable.has(id))
      .sort();

    // The accepted set as of s3a-view-consolidation (CHANGELOG Unreleased /
    // Removed). Three groups: invoked programmatically (openChat rides the org
    // panel row click; the refresh pair services the kept non-view providers),
    // panel-internal equivalents kept registered for programmatic callers
    // (folder/tag mutation and the smart-group promotes), and the s3b interim
    // gaps that wait for the in-panel hover card and context menu (previewChat,
    // exportChat, archiveChat of a live chat). Adding an id here means
    // deliberately shipping a command with no UI surface: record it in
    // CHANGELOG and keep README silent about it.
    assert.deepStrictEqual(surfaceless, [
      'claudeNest.addTagToChat',
      'claudeNest.archiveChat',
      'claudeNest.assignChatToFolder',
      'claudeNest.deleteFolder',
      'claudeNest.deleteTag',
      'claudeNest.exportChat',
      'claudeNest.openChat',
      'claudeNest.previewChat',
      'claudeNest.promoteSmartGroupToFolder',
      'claudeNest.promoteSmartGroupToTag',
      'claudeNest.refreshFolders',
      'claudeNest.refreshTags',
      'claudeNest.removeTagFromChat',
      'claudeNest.renameFolder',
      'claudeNest.tagChats',
    ]);
  });

  // Retiring the flat and smart-groups trees stripped the view/title and
  // view/item/context menus off refresh, linkToChat, and unlinkChat, leaving the
  // palette as their only surface. Under the declared engines floor those need an
  // explicit onCommand activation event or a cold palette invocation errors.
  it('every palette-only command declares an onCommand activation event', () => {
    const manifest = loadManifest();
    if (enginesFloorHasImplicitActivation(manifest.engines.vscode)) {
      return;
    }
    const declared = new Set(
      (manifest.activationEvents ?? [])
        .filter((e) => e.startsWith('onCommand:'))
        .map((e) => e.slice('onCommand:'.length)),
    );
    const missing = paletteOnlyCommandIds(manifest).filter(
      (id) => !declared.has(id),
    );
    assert.deepStrictEqual(
      missing,
      [],
      'palette-only commands missing an onCommand activation event under engines ' +
        manifest.engines.vscode +
        ': ' +
        missing.join(', ') +
        ' (add "onCommand:<id>" to activationEvents or raise the engines floor to ^1.74.0)',
    );
  });
});
