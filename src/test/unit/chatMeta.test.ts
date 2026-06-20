import * as assert from 'assert';
import { ProjectMeta } from '../../store/schema';
import { resolveFolderName, resolveTagLabels } from '../../views/chatMeta';

// Headless unit tests for the pure folder-name / tag-label resolvers that feed the
// hover card. No vscode, no filesystem: they operate on the plain ProjectMeta
// shape the providers already read.

function meta(partial: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    schemaVersion: 1,
    folders: {},
    tags: {},
    chats: {},
    updatedAt: 0,
    deviceId: 'd',
    ...partial,
  };
}

describe('resolveFolderName', () => {
  it('returns the home folder name for a filed chat', () => {
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Work', parentId: null, order: 0 } },
      chats: { c1: { folderId: 'f1', tags: [], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    assert.strictEqual(resolveFolderName(m, 'c1'), 'Work');
  });

  it('returns null for an unfiled chat, an unknown folder id, an unknown chat, or no meta', () => {
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Work', parentId: null, order: 0 } },
      chats: {
        unfiled: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        dangling: { folderId: 'gone', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
      },
    });
    assert.strictEqual(resolveFolderName(m, 'unfiled'), null);
    assert.strictEqual(resolveFolderName(m, 'dangling'), null, 'unresolvable folder id -> null');
    assert.strictEqual(resolveFolderName(m, 'never-seen'), null);
    assert.strictEqual(resolveFolderName(undefined, 'c1'), null);
  });
});

describe('resolveTagLabels', () => {
  it('returns the full tag label set in stored order, dropping unresolved ids', () => {
    const m = meta({
      tags: {
        t1: { id: 't1', label: 'urgent' },
        t2: { id: 't2', label: 'review' },
      },
      chats: { c1: { folderId: null, tags: ['t1', 'gone', 't2'], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    assert.deepStrictEqual(resolveTagLabels(m, 'c1'), ['urgent', 'review']);
  });

  it('returns [] for an untagged chat, an unknown chat, or no meta', () => {
    const m = meta({
      chats: { c1: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    assert.deepStrictEqual(resolveTagLabels(m, 'c1'), []);
    assert.deepStrictEqual(resolveTagLabels(m, 'never-seen'), []);
    assert.deepStrictEqual(resolveTagLabels(undefined, 'c1'), []);
  });
});
