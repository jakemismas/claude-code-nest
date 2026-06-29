import * as assert from 'assert';
import { ProjectMeta, emptyProjectMeta } from '../../store/schema';
import { buildImportPlan, mergeProjectMeta } from '../../store/exportImport';
import { NormalizedEnvelope } from '../../store/schemaMigrate';

// Pure-logic unit tests for the ADDITIVE per-project merge, the pinned COLLISION
// IDENTITY RULE, and the never-delete-absent rule. No vscode, no filesystem.

const DEVICE = 'dev-A';
const NOW = 1_700_000_000_000;

function proj(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(DEVICE, NOW), ...overrides };
}

describe('exportImport mergeProjectMeta: folders union by id', () => {
  it('adds file-only folders and keeps live-only folders', () => {
    const live = proj({
      folders: { a: { id: 'a', name: 'A', parentId: null, order: 0 } },
      updatedAt: 10,
    });
    const file = proj({
      folders: { b: { id: 'b', name: 'B', parentId: null, order: 1 } },
      updatedAt: 20,
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.ok('a' in r.merged.folders);
    assert.ok('b' in r.merged.folders);
    assert.strictEqual(r.changed, true);
  });

  it('on a same-id folder conflict the higher document updatedAt wins', () => {
    const live = proj({
      folders: { a: { id: 'a', name: 'LIVE', parentId: null, order: 0 } },
      updatedAt: 10,
    });
    const file = proj({
      folders: { a: { id: 'a', name: 'FILE', parentId: null, order: 0 } },
      updatedAt: 20,
    });
    assert.strictEqual(mergeProjectMeta('pk', live, file).merged.folders.a.name, 'FILE');

    // Lower file updatedAt loses: live keeps its name.
    const file2 = proj({
      folders: { a: { id: 'a', name: 'FILE', parentId: null, order: 0 } },
      updatedAt: 5,
    });
    assert.strictEqual(mergeProjectMeta('pk', live, file2).merged.folders.a.name, 'LIVE');
  });

  it('identical same-id folder is not a change', () => {
    const f = { a: { id: 'a', name: 'A', parentId: null, order: 0 } };
    const live = proj({ folders: { ...f }, updatedAt: 10 });
    const file = proj({ folders: { ...f }, updatedAt: 20 });
    assert.strictEqual(mergeProjectMeta('pk', live, file).changed, false);
  });
});

describe('exportImport mergeProjectMeta: tags union by id', () => {
  it('unions tags and resolves a same-id conflict by document updatedAt', () => {
    const live = proj({
      tags: { t: { id: 't', label: 'LIVE' } },
      updatedAt: 10,
    });
    const file = proj({
      tags: {
        t: { id: 't', label: 'FILE', color: '#aabbcc' },
        u: { id: 'u', label: 'NEW' },
      },
      updatedAt: 20,
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.tags.t.label, 'FILE');
    assert.strictEqual(r.merged.tags.t.color, '#aabbcc');
    assert.strictEqual(r.merged.tags.u.label, 'NEW');
  });
});

describe('exportImport mergeProjectMeta: chat tags and links union', () => {
  it('unions chat tags (set union, first-seen order) and dedupes', () => {
    const live = proj({
      chats: {
        c: { folderId: null, tags: ['x', 'y'], links: [], updatedAt: 10, deviceId: 'd' },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: null, tags: ['y', 'z'], links: [], updatedAt: 5, deviceId: 'd' },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.deepStrictEqual(r.merged.chats.c.tags, ['x', 'y', 'z']);
  });

  it('unions chat links deduped on the exact (targetChatId, kind) pair', () => {
    const live = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [{ targetChatId: 't1', kind: 'parent' }],
          updatedAt: 10,
          deviceId: 'd',
        },
      },
    });
    const file = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [
            { targetChatId: 't1', kind: 'parent' }, // dup, dropped
            { targetChatId: 't1', kind: 'related' }, // different kind, kept
            { targetChatId: 't2', kind: 'parent' }, // new target, kept
          ],
          updatedAt: 5,
          deviceId: 'd',
        },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.deepStrictEqual(r.merged.chats.c.links, [
      { targetChatId: 't1', kind: 'parent' },
      { targetChatId: 't1', kind: 'related' },
      { targetChatId: 't2', kind: 'parent' },
    ]);
  });
});

describe('exportImport mergeProjectMeta: folderId LWW scalar and the conflict floor', () => {
  it('folderId follows the higher per-record updatedAt', () => {
    const live = proj({
      chats: {
        c: { folderId: 'fLive', tags: [], links: [], updatedAt: 10, deviceId: 'd' },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: 'fFile', tags: [], links: [], updatedAt: 20, deviceId: 'd2' },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.chats.c.folderId, 'fFile');
    // Both set a different non-null home: this is the irreducible conflict floor.
    assert.deepStrictEqual(r.folderConflicts, ['c']);
  });

  it('a tie keeps the live folderId (local-wins bias)', () => {
    const live = proj({
      chats: {
        c: { folderId: 'fLive', tags: [], links: [], updatedAt: 10, deviceId: 'd' },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: 'fFile', tags: [], links: [], updatedAt: 10, deviceId: 'd2' },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.chats.c.folderId, 'fLive');
    assert.deepStrictEqual(r.folderConflicts, ['c']);
  });

  it('a null-vs-set folderId is NOT a conflict (filing an unfiled chat)', () => {
    const live = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd' },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: 'fFile', tags: [], links: [], updatedAt: 20, deviceId: 'd2' },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.chats.c.folderId, 'fFile');
    assert.deepStrictEqual(r.folderConflicts, []);
  });

  it('takes the MAX record updatedAt on the merged chat', () => {
    const live = proj({
      chats: {
        c: { folderId: null, tags: ['x'], links: [], updatedAt: 10, deviceId: 'd' },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: null, tags: ['y'], links: [], updatedAt: 30, deviceId: 'd2' },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.chats.c.updatedAt, 30);
  });
});

describe('exportImport mergeProjectMeta: __unknown escrow and schemaVersion', () => {
  it('keeps the higher schemaVersion and unions the unknown escrow', () => {
    const live = proj({ updatedAt: 10 });
    const file: ProjectMeta = {
      ...proj({ updatedAt: 20 }),
      schemaVersion: 99,
      __unknown: { newField: true },
    };
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.schemaVersion, 99);
    assert.deepStrictEqual(r.merged.__unknown, { newField: true });
    assert.strictEqual(r.changed, true);
  });
});

describe('exportImport buildImportPlan: never deletes a project absent from the file', () => {
  it('only enumerates projects present in the envelope; absent live projects are untouched', () => {
    const stored: { [k: string]: ProjectMeta } = {
      keepMe: proj({ folders: { z: { id: 'z', name: 'Z', parentId: null, order: 0 } } }),
      mergeMe: proj({ updatedAt: 10 }),
    };
    const envelope: NormalizedEnvelope = {
      version: 1,
      exportedAt: NOW,
      // Only mergeMe is in the file; keepMe is NOT.
      projects: {
        mergeMe: proj({
          folders: { a: { id: 'a', name: 'A', parentId: null, order: 0 } },
          updatedAt: 20,
        }),
      },
    };
    const plan = buildImportPlan(envelope, (pk) => stored[pk] ?? emptyProjectMeta(DEVICE, NOW));
    // The plan has exactly one result: mergeMe. keepMe never appears, so the
    // command module never calls putProjectMeta for it and it is never deleted.
    assert.strictEqual(plan.results.length, 1);
    assert.strictEqual(plan.results[0].projectKey, 'mergeMe');
    assert.ok('a' in plan.results[0].merged.folders);
  });

  it('merges a file-only project onto an empty live document', () => {
    const envelope: NormalizedEnvelope = {
      version: 1,
      exportedAt: NOW,
      projects: {
        brandNew: proj({
          tags: { t: { id: 't', label: 'New' } },
          updatedAt: 5,
        }),
      },
    };
    const plan = buildImportPlan(envelope, () => emptyProjectMeta(DEVICE, NOW));
    assert.strictEqual(plan.results.length, 1);
    assert.strictEqual(plan.results[0].merged.tags.t.label, 'New');
    assert.strictEqual(plan.results[0].changed, true);
  });

  it('sums folder conflicts across projects for the LWW warning', () => {
    const conflictChat = (home: string, ts: number) => ({
      c: { folderId: home, tags: [], links: [], updatedAt: ts, deviceId: 'd' },
    });
    const stored: { [k: string]: ProjectMeta } = {
      p1: proj({ chats: conflictChat('live1', 10) }),
      p2: proj({ chats: conflictChat('live2', 10) }),
    };
    const envelope: NormalizedEnvelope = {
      version: 1,
      exportedAt: NOW,
      projects: {
        p1: proj({ chats: conflictChat('file1', 20) }),
        p2: proj({ chats: conflictChat('file2', 20) }),
      },
    };
    const plan = buildImportPlan(envelope, (pk) => stored[pk]);
    assert.strictEqual(plan.totalFolderConflicts, 2);
  });
});

describe('exportImport mergeProjectMeta: inputs are not mutated', () => {
  it('does not mutate live or file', () => {
    const live = proj({
      folders: { a: { id: 'a', name: 'A', parentId: null, order: 0 } },
      updatedAt: 10,
    });
    const file = proj({
      folders: { b: { id: 'b', name: 'B', parentId: null, order: 0 } },
      updatedAt: 20,
    });
    const liveSnap = JSON.stringify(live);
    const fileSnap = JSON.stringify(file);
    mergeProjectMeta('pk', live, file);
    assert.strictEqual(JSON.stringify(live), liveSnap);
    assert.strictEqual(JSON.stringify(file), fileSnap);
  });
});
