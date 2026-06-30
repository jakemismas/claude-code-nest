import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { FlatProvider } from '../../views/flatProvider';
import { FoldersProvider } from '../../views/foldersProvider';
import { TagsProvider } from '../../views/tagsProvider';
import { SmartGroupsProvider } from '../../views/smartGroupsProvider';
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
    // The full contributed view set after the slice 6 retirement: the org panel
    // webview (the primary surface), the flat Chats tree (the accessible fallback),
    // Smart Groups, and Archive. The native Folders and Tags trees and the
    // chatsPreview POC were retired. Asserted as the exact set so adding or dropping
    // a view forces this gate to be revisited.
    assert.deepStrictEqual(ids, [
      'claudeNest.archive',
      'claudeNest.flat',
      'claudeNest.orgPanel',
      'claudeNest.smartGroups',
    ]);
    const containers = contributes.viewsContainers as {
      activitybar: Array<{ id: string; icon: string }>;
    };
    const container = containers.activitybar.find((c) => c.id === 'claudeNest');
    assert.ok(container, 'expected the claudeNest activitybar container');
    assert.strictEqual(container.icon, 'media/nest.svg');
  });

  it('ships a viewsWelcome empty-state for every view, never blaming Claude', () => {
    const manifest = readManifest();
    const contributes = manifest.contributes as Record<string, unknown>;
    const welcome = contributes.viewsWelcome as Array<{ view: string; contents: string }>;
    const byView = new Map(welcome.map((w) => [w.view, w.contents]));
    for (const view of [
      'claudeNest.flat',
      'claudeNest.smartGroups',
      'claudeNest.archive',
    ]) {
      const contents = byView.get(view);
      assert.ok(contents, 'expected a viewsWelcome for ' + view);
      assert.ok(
        contents.includes('No Claude Code chats found') ||
          contents.toLowerCase().includes('smart groups are read-only') ||
          contents.includes('No archived chats'),
        'empty-state for ' + view + ' should explain the no-sessions state',
      );
      // The empty state must not attribute the absence to a Claude failure.
      assert.ok(!/Claude (failed|broke|crashed|error)/i.test(contents));
    }
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
    // Point every provider at a workspace path that has no on-disk project dir, so
    // the scan resolves nothing. Each must render empty rather than throw, which is
    // exactly what the viewsWelcome contribution then surfaces.
    const noProject = path.join(__dirname, 'no-such-workspace-' + Date.now());
    const store = new MetadataStore(new FakeMemento(), { deviceId: 'test-device' });

    const flat = new FlatProvider(noProject, store, { projectsRoot: noProject });
    const folders = new FoldersProvider(noProject, store, { projectsRoot: noProject });
    const tags = new TagsProvider(noProject, store, { projectsRoot: noProject });
    const smart = new SmartGroupsProvider(noProject, { projectsRoot: noProject });

    assert.deepStrictEqual(flat.getChildren(undefined), []);
    assert.deepStrictEqual(folders.getChildren(undefined), []);
    assert.deepStrictEqual(tags.getChildren(undefined), []);
    assert.deepStrictEqual(smart.getChildren(undefined), []);

    // Priming under a (no-op) progress scan also must not throw on an absent project.
    assert.doesNotThrow(() => flat.primeSnapshot({}));
    assert.doesNotThrow(() => folders.primeSnapshot({}));
    assert.doesNotThrow(() => tags.primeSnapshot({}));
    assert.doesNotThrow(() => smart.primeSnapshot({}));

    void store.dispose();
  });
});
