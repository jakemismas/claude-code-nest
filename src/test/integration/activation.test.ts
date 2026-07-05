import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { FoldersProvider } from '../../views/foldersProvider';
import { TagsProvider } from '../../views/tagsProvider';
import { MetadataStore, SyncMemento } from '../../store/metadataStore';

// The DEFERRED electron-host integration test the Polish slice calls for:
// activation and empty-state rendering. It runs ONLY in the Extension Development
// Host (out/test/integration via runTest.js), never in the headless `npm test`
// gate, because it needs a real vscode module: a real TreeItem prototype, the real
// package.json the host loaded as the Extension Manifest, and real view
// registration. The headless unit suite already covers the pure scan/empty paths
// (chatScanner.test.ts returns [] for an unresolved workspace; each provider's
// ensureSnapshot returns []/null on a failed/absent scan); this spec confirms the
// same contract holds against the real host and that the empty-state contributions
// ship in the manifest.

// A minimal in-memory SyncMemento for the store (mirrors the unit suite).
class FakeMemento implements SyncMemento {
  private readonly map = new Map<string, unknown>();
  private readonly synced = new Set<string>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.map.keys());
  }
  setKeysForSync(keys: readonly string[]): void {
    for (const k of keys) {
      this.synced.add(k);
    }
  }
}

function readManifest(): Record<string, unknown> {
  // The extension root is two dirs up from out/test/integration.
  const manifestPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

describe('Polish: activation and empty-state (electron host)', () => {
  it('is present as an installed extension in the host', () => {
    // The publisher.name id from package.json. Proves the host loaded this
    // extension's manifest (activation itself fires on the onView:* events when a
    // view is opened, which the unattended host does not drive; presence is the
    // assertion the deferred host run can make without a UI).
    const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
    assert.ok(ext, 'expected jakemismas.claude-code-nest to be loaded in the host');
  });

  it('registers the claudeNest views and the activitybar container', () => {
    const manifest = readManifest();
    const contributes = manifest.contributes as Record<string, unknown>;
    const views = (contributes.views as Record<string, Array<{ id: string }>>).claudeNest;
    const ids = views.map((v) => v.id).sort();
    // The contributed view set after slice s3b-archive-overlay (issue #87): the org
    // panel webview is now the SOLE contributed view. The Archive tree was retired this
    // slice (its rows moved into the in-panel Archive overlay reached from the bottom
    // "Archived (N)" row); the flat Chats and Smart Groups trees, and the native
    // Folders/Tags trees, went in earlier slices. Asserted as the exact set so adding or
    // dropping a view forces this gate to be revisited.
    assert.deepStrictEqual(ids, ['claudeNest.orgPanel']);
    const containers = contributes.viewsContainers as {
      activitybar: Array<{ id: string; icon: string }>;
    };
    const container = containers.activitybar.find((c) => c.id === 'claudeNest');
    assert.ok(container, 'expected the claudeNest activitybar container');
    assert.strictEqual(container.icon, 'media/nest.svg');
  });

  it('ships no viewsWelcome now that every tree view is retired', () => {
    const manifest = readManifest();
    const contributes = manifest.contributes as Record<string, unknown>;
    const welcome = contributes.viewsWelcome as Array<{ view: string; contents: string }>;
    // After slice s3b-archive-overlay (issue #87) the Archive tree is retired and the org
    // panel is a webview that owns its own empty state, so NO tree view remains to back a
    // viewsWelcome. The array is empty; any entry would target a retired view id.
    assert.deepStrictEqual(welcome, [], 'no viewsWelcome after the last tree view retired');
  });

  it('ships the raster gallery icon and the getting-started walkthrough', () => {
    const manifest = readManifest();
    assert.strictEqual(manifest.icon, 'media/icon.png');
    const iconPath = path.resolve(__dirname, '..', '..', '..', 'media', 'icon.png');
    assert.ok(fs.existsSync(iconPath), 'expected media/icon.png to ship');
    const contributes = manifest.contributes as Record<string, unknown>;
    const walkthroughs = contributes.walkthroughs as Array<{ id: string; steps: unknown[] }>;
    const gs = walkthroughs.find((w) => w.id === 'claudeNest.gettingStarted');
    assert.ok(gs, 'expected the getting-started walkthrough');
    assert.ok(gs.steps.length >= 3, 'walkthrough should have multiple steps');
  });

  it('getChildren(undefined) returns [] and never throws when no project resolves', () => {
    // Point the kept non-view services at a workspace path that has no on-disk
    // project dir, so the scan resolves nothing. Each must render empty rather
    // than throw (the same contract the retired trees honored).
    const noProject = path.join(__dirname, 'no-such-workspace-' + Date.now());
    const store = new MetadataStore(new FakeMemento(), { deviceId: 'test-device' });

    const folders = new FoldersProvider(noProject, store, { projectsRoot: noProject });
    const tags = new TagsProvider(noProject, store, { projectsRoot: noProject });

    assert.deepStrictEqual(folders.getChildren(undefined), []);
    assert.deepStrictEqual(tags.getChildren(undefined), []);

    // Priming under a (no-op) progress scan also must not throw on an absent project.
    assert.doesNotThrow(() => folders.primeSnapshot({}));
    assert.doesNotThrow(() => tags.primeSnapshot({}));

    void store.dispose();
  });
});
