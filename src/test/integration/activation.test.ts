import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { FoldersProvider } from '../../views/foldersProvider';
import { TagsProvider } from '../../views/tagsProvider';
import { MetadataStore, SyncMemento } from '../../store/metadataStore';

// Extension Development Host test of activation and empty-state rendering. It needs the real vscode module and
// the loaded manifest, so it never runs in the headless `npm test`. Unit tests cover the pure empty paths;
// this confirms the contract against the real host and that the empty-state contributions ship in the manifest.

// Minimal in-memory SyncMemento for the store.
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
  const manifestPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

describe('activation and empty-state (electron host)', () => {
  it('is present as an installed extension in the host', () => {
    // The publisher.name id proves the host loaded this manifest; activation fires on view events the unattended host does not drive.
    const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
    assert.ok(ext, 'expected jakemismas.claude-code-nest to be loaded in the host');
  });

  it('registers the claudeNest views and the activitybar container', () => {
    const manifest = readManifest();
    const contributes = manifest.contributes as Record<string, unknown>;
    const views = (contributes.views as Record<string, Array<{ id: string }>>).claudeNest;
    const ids = views.map((v) => v.id).sort();
    // The org panel webview is the only contributed view; archived chats live in its Archive overlay.
    // The exact set is asserted so adding or dropping a view forces a revisit.
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
    // The org panel owns its empty state and no tree view remains, so viewsWelcome is empty.
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
    // Point the services at a workspace with no project dir so each renders empty instead of throwing.
    const noProject = path.join(__dirname, 'no-such-workspace-' + Date.now());
    const store = new MetadataStore(new FakeMemento(), { deviceId: 'test-device' });

    const folders = new FoldersProvider(noProject, store, { projectsRoot: noProject });
    const tags = new TagsProvider(noProject, store, { projectsRoot: noProject });

    assert.deepStrictEqual(folders.getChildren(undefined), []);
    assert.deepStrictEqual(tags.getChildren(undefined), []);

    assert.doesNotThrow(() => folders.primeSnapshot({}));
    assert.doesNotThrow(() => tags.primeSnapshot({}));

    void store.dispose();
  });
});
