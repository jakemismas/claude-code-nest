import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import { parseNestConfig } from '../../fleet/nestConfig';
import { RuleSubject } from '../../fleet/rules';
import {
  OrganizeDeps,
  applyOrganize,
  idleOrganizeReport,
  previewOrganize,
  undoOrganize,
} from '../../commands/organizeCommands';

const PK = 'c--proj-organize';

function subject(id: string, over: Partial<RuleSubject> = {}): RuleSubject {
  return {
    sessionId: id,
    title: `Chat ${id}`,
    name: `Chat ${id}`,
    ticket: null,
    role: null,
    agent: '',
    cwd: null,
    fleetTitle: '',
    subfolder: '',
    ...over,
  };
}

interface Harness {
  store: MetadataStore;
  memento: FakeMemento;
  deps: OrganizeDeps;
  calls: string[];
  setSubjects(s: RuleSubject[]): void;
}

function harness(rulesJson: unknown[], tagColors: { [n: string]: string } = {}): Harness {
  const memento = new FakeMemento();
  const store = new MetadataStore(memento, { deviceId: 'dev-org', debounceMs: 0 });
  const calls: string[] = [];
  let subjects: RuleSubject[] = [];
  const rules = parseNestConfig(JSON.stringify({ rules: rulesJson })).config.rules;
  const deps: OrganizeDeps = {
    store,
    getProjectKey: () => PK,
    getSubjects: () => subjects,
    getRules: () => rules,
    getTagColors: () => tagColors,
    homedir: '/h',
    barrier: async () => {
      calls.push('barrier');
    },
    refresh: () => {
      calls.push('refresh');
    },
  };
  return { store, memento, deps, calls, setSubjects: (s) => (subjects = s) };
}

const QA_RULE = { match: { role: 'qa' }, folder: 'QA', tags: ['qa'], pin: true };

describe('organize commands', () => {
  it('Preview lists moves and writes nothing', async () => {
    const h = harness([QA_RULE]);
    h.setSubjects([subject('a', { role: 'qa' }), subject('b')]);
    const before = h.memento.updateCount;
    const report = previewOrganize(h.deps);
    await h.store.flush();
    assert.strictEqual(report.kind, 'preview');
    assert.strictEqual(report.moves.length, 1);
    assert.strictEqual(report.rulesActive, 1);
    assert.strictEqual(h.memento.updateCount, before);
    assert.deepStrictEqual(h.calls, []);
    assert.deepStrictEqual(Object.keys(h.store.getProjectMeta(PK).folders), []);
  });

  it('Apply awaits the barrier first, then files, tags and stars the chat', async () => {
    const h = harness([QA_RULE], { qa: '#112233' });
    h.setSubjects([subject('a', { role: 'qa' }), subject('b')]);
    const report = await applyOrganize(h.deps);
    assert.strictEqual(h.calls[0], 'barrier');
    assert.ok(h.calls.includes('refresh'));
    assert.strictEqual(report.kind, 'applied');
    assert.strictEqual(report.undoCount, 1);
    const meta = h.store.getProjectMeta(PK);
    const folders = Object.values(meta.folders);
    assert.strictEqual(folders.length, 1);
    assert.strictEqual(folders[0].name, 'QA');
    const tags = Object.values(meta.tags);
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0].label, 'qa');
    assert.strictEqual(tags[0].color, '#112233');
    assert.strictEqual(meta.chats.a.folderId, folders[0].id);
    assert.deepStrictEqual(meta.chats.a.tags, [tags[0].id]);
    assert.strictEqual(meta.chats.a.starred, true);
    assert.strictEqual(meta.chats.b, undefined);
  });

  it('Apply uses an existing tag by label instead of creating a duplicate', async () => {
    const h = harness([{ match: { role: 'qa' }, tags: ['QA'] }]);
    h.store.upsertTag(PK, { id: 'tag-existing', label: 'qa' });
    h.setSubjects([subject('a', { role: 'qa' })]);
    await applyOrganize(h.deps);
    const meta = h.store.getProjectMeta(PK);
    assert.deepStrictEqual(Object.keys(meta.tags), ['tag-existing']);
    assert.deepStrictEqual(meta.chats.a.tags, ['tag-existing']);
  });

  it('Undo restores the prior state exactly and removes what Apply created', async () => {
    const h = harness([QA_RULE]);
    h.store.upsertFolder(PK, { id: 'f-old', name: 'Old', parentId: null, order: 0 });
    h.store.upsertTag(PK, { id: 't-keep', label: 'keep' });
    h.store.setChatFolder(PK, 'a', 'f-old');
    h.store.addChatTag(PK, 'a', 't-keep');
    await h.store.flush();
    // a is in a folder no rule chose, so it is filed by hand and untouched.
    h.setSubjects([subject('a', { role: 'qa' }), subject('c', { role: 'qa' })]);
    const applied = await applyOrganize(h.deps);
    assert.strictEqual(applied.undoCount, 1);
    let meta = h.store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.a.folderId, 'f-old');
    assert.strictEqual(meta.chats.a.starred, undefined);
    assert.ok(meta.chats.c.folderId !== null);

    const undone = await undoOrganize(h.deps);
    assert.strictEqual(undone.kind, 'undone');
    meta = h.store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.c.folderId, null);
    assert.deepStrictEqual(meta.chats.c.tags, []);
    assert.strictEqual(meta.chats.c.starred, false);
    assert.deepStrictEqual(Object.keys(meta.folders), ['f-old']);
    assert.deepStrictEqual(Object.keys(meta.tags), ['t-keep']);
    assert.strictEqual(h.store.getOrganizeLedger(PK), null);
    assert.strictEqual(idleOrganizeReport(h.deps).canUndo, false);
  });

  it('Undo skips a chat the user moved since and keeps the folder that holds it', async () => {
    const h = harness([QA_RULE]);
    h.store.upsertFolder(PK, { id: 'f-mine', name: 'Mine', parentId: null, order: 0 });
    h.setSubjects([subject('a', { role: 'qa' }), subject('b', { role: 'qa' })]);
    await applyOrganize(h.deps);
    h.store.setChatFolder(PK, 'a', 'f-mine');
    const undone = await undoOrganize(h.deps);
    assert.strictEqual(undone.skippedOnUndo, 1);
    const meta = h.store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.a.folderId, 'f-mine');
    assert.strictEqual(meta.chats.b.folderId, null);
    // Apply created QA; no chat uses it after Undo, so it is gone.
    assert.deepStrictEqual(Object.keys(meta.folders), ['f-mine']);
    // The skipped chat now counts as filed by hand: a second Preview leaves it alone.
    const preview = previewOrganize(h.deps);
    assert.ok(!preview.moves.some((m) => m.sessionId === 'a'));
    assert.strictEqual(preview.skippedHandFiled, 1);
  });

  it('Undo keeps an Apply-created folder and tag that a chat outside the snapshot now uses', async () => {
    const h = harness([QA_RULE]);
    h.setSubjects([subject('a', { role: 'qa' })]);
    await applyOrganize(h.deps);
    const meta0 = h.store.getProjectMeta(PK);
    const folderId = Object.keys(meta0.folders)[0];
    const tagId = Object.keys(meta0.tags)[0];
    h.store.setChatFolder(PK, 'other', folderId);
    h.store.addChatTag(PK, 'other', tagId);
    await undoOrganize(h.deps);
    const meta = h.store.getProjectMeta(PK);
    assert.ok(meta.folders[folderId] !== undefined);
    assert.ok(meta.tags[tagId] !== undefined);
    assert.strictEqual(meta.chats.other.folderId, folderId);
    assert.deepStrictEqual(meta.chats.other.tags, [tagId]);
    assert.strictEqual(meta.chats.a.folderId, null);
  });

  it('Undoing a second Apply keeps folders the first Apply filed chats into', async () => {
    const h = harness([QA_RULE, { match: { role: 'build' }, folder: 'Build' }]);
    h.setSubjects([subject('a', { role: 'qa' })]);
    await applyOrganize(h.deps);
    h.setSubjects([subject('b', { role: 'build' })]);
    await applyOrganize(h.deps);
    await undoOrganize(h.deps);
    const meta = h.store.getProjectMeta(PK);
    const qa = Object.values(meta.folders).find((f) => f.name === 'QA');
    assert.ok(qa !== undefined);
    assert.strictEqual(meta.chats.a.folderId, qa.id);
    assert.strictEqual(meta.chats.b.folderId, null);
  });

  it('a hand move after Apply wins over a later Apply', async () => {
    const h = harness([QA_RULE]);
    h.store.upsertFolder(PK, { id: 'f-mine', name: 'Mine', parentId: null, order: 0 });
    h.setSubjects([subject('a', { role: 'qa' })]);
    await applyOrganize(h.deps);
    h.store.setChatFolder(PK, 'a', 'f-mine');
    const second = await applyOrganize(h.deps);
    assert.strictEqual(second.message, 'Nothing to apply.');
    assert.strictEqual(h.store.getProjectMeta(PK).chats.a.folderId, 'f-mine');
  });

  it('a second Apply can re-move a chat the first Apply filed', async () => {
    const h = harness([{ match: { ticket: true }, folder: '{ticket}' }]);
    h.setSubjects([subject('a', { ticket: 'T-1' })]);
    await applyOrganize(h.deps);
    h.setSubjects([subject('a', { ticket: 'T-2' })]);
    const preview = previewOrganize(h.deps);
    assert.strictEqual(preview.moves.length, 1);
    await applyOrganize(h.deps);
    const meta = h.store.getProjectMeta(PK);
    const folder = meta.folders[meta.chats.a.folderId as string];
    assert.strictEqual(folder.name, 'T-2');
  });

  it('keeps the ledger in the local document only, never on the synced meta or sync keys', async () => {
    const h = harness([QA_RULE]);
    h.setSubjects([subject('a', { role: 'qa' })]);
    await applyOrganize(h.deps);
    await h.store.flushLocal();
    const synced = JSON.stringify(h.store.getProjectMeta(PK));
    assert.ok(!synced.includes('"applied"'));
    assert.ok(!synced.includes('snapshot'));
    for (const reg of h.memento.syncRegistrations) {
      assert.ok(reg.every((k) => k.startsWith('nest.meta.v1')));
    }
    const ledger = h.store.getOrganizeLedger(PK);
    assert.ok(ledger !== null);
    assert.deepStrictEqual(Object.keys(ledger.snapshot), ['a']);
    // A replacement local document without the ledger keeps it.
    await h.store.putLocalProjectMeta(PK, { schemaVersion: 1, chats: {} });
    assert.ok(h.store.getOrganizeLedger(PK) !== null);
  });

  it('Apply with nothing to do writes no ledger', async () => {
    const h = harness([QA_RULE]);
    h.setSubjects([subject('a')]);
    const report = await applyOrganize(h.deps);
    assert.strictEqual(report.moves.length, 0);
    assert.strictEqual(h.store.getOrganizeLedger(PK), null);
  });

  it('reports a missing project instead of throwing', async () => {
    const h = harness([QA_RULE]);
    const deps: OrganizeDeps = { ...h.deps, getProjectKey: () => undefined };
    assert.strictEqual(previewOrganize(deps).kind, 'error');
    assert.strictEqual((await applyOrganize(deps)).kind, 'error');
    assert.strictEqual((await undoOrganize(deps)).kind, 'error');
  });

  it('reports rule problems in Preview and keeps the valid rules active', () => {
    const h = harness([{ match: { name: '(' }, tags: ['x'] }, QA_RULE]);
    h.setSubjects([subject('a', { role: 'qa' })]);
    const report = previewOrganize(h.deps);
    assert.strictEqual(report.rulesActive, 1);
    assert.strictEqual(report.problems.length, 1);
    assert.strictEqual(report.moves.length, 1);
  });
});
