import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { ProjectMeta } from '../../store/schema';
import { buildSections, FolderSection, UNSORTED_FOLDER_ID } from '../../views/orgPanelModel';
import { UNFILED_FOLDER_ID } from '../../model/folderTree';

// Headless unit tests for the PURE org-panel section assembler. It imports no
// vscode types (only plain data in/out and the pure schema shape), so this test
// never transitively requires the vscode module (ARCHITECTURE.md unit-gate rule).
// It covers section assembly, the awaiting-reply heuristic (lastMessageRole ===
// 'user' ONLY), single-home folder placement with per-folder color, the synthetic
// Unsorted bucket, empty sections, tag chips, and the sentinel contract.

function totals(over: Partial<TokenTotals> = {}): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...over };
}

function record(over: Partial<ChatRecord> & { sessionId: string }): ChatRecord {
  return {
    sessionId: over.sessionId,
    title: over.title ?? over.sessionId,
    timestamp: over.timestamp ?? 0,
    filePath: over.filePath ?? '/x.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: over.messageCount ?? 0,
    firstMessageText: over.firstMessageText ?? null,
    firstMessageRole: over.firstMessageRole ?? null,
    lastMessageText: over.lastMessageText ?? null,
    lastMessageRole: over.lastMessageRole ?? null,
    tokenTotals: over.tokenTotals ?? totals(),
    filesTouched: over.filesTouched ?? [],
    models: over.models ?? [],
  };
}

function meta(over: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    schemaVersion: 1,
    folders: over.folders ?? {},
    tags: over.tags ?? {},
    chats: over.chats ?? {},
    updatedAt: 0,
    deviceId: 'd',
  };
}

// A token-badge stub: a simple non-zero formatter so the row carries a badge when
// there are tokens, mirroring the real tokenBadge contract (empty for zero).
function badge(r: ChatRecord): string {
  const t = r.tokenTotals;
  const sum = t.input + t.output + t.cacheCreation + t.cacheRead;
  return sum > 0 ? '~' + sum + ' tokens' : '';
}

describe('orgPanelModel sentinel contract', () => {
  it('the Unsorted sentinel matches the dropReducer/folderTree UNFILED sentinel', () => {
    // The org-panel Unsorted bucket must reduce to an unfile when dropped onto, so
    // its id must equal the folder-tree/reducer UNFILED sentinel.
    assert.strictEqual(UNSORTED_FOLDER_ID, '__unfiled__');
    assert.strictEqual(UNSORTED_FOLDER_ID, UNFILED_FOLDER_ID);
  });
});

describe('orgPanelModel Questions section (status-driven, replaces lastMessageRole heuristic)', () => {
  it('flags ONLY unread assistant-last chats that ask something (not user-last)', () => {
    const records = [
      // user-last: no longer in Questions (superseded-by-user is status 'none')
      record({ sessionId: 'u', lastMessageRole: 'user', lastMessageText: 'Please fix this?' }),
      // unread assistant asking: in Questions
      record({ sessionId: 'q', lastMessageRole: 'assistant', lastMessageText: 'Which do you want?' }),
      // unread assistant NOT asking: not in Questions (it is the 'done' dot)
      record({ sessionId: 'd', lastMessageRole: 'assistant', lastMessageText: 'All done.' }),
      record({ sessionId: 'n', lastMessageRole: null }),
    ];
    const sections = buildSections(records, meta(), badge);
    assert.deepStrictEqual(
      sections.questions.map((r) => r.sessionId),
      ['q'],
      'only the unread assistant-asking chat is in Questions',
    );
    assert.strictEqual(sections.questions[0].awaitingReply, true);
    assert.strictEqual(sections.questions[0].status, 'question');
  });

  it('a SEEN assistant-asking chat is NOT in Questions (lastSeenAt gate)', () => {
    const records = [
      record({ sessionId: 'q', timestamp: 100, lastMessageRole: 'assistant', lastMessageText: 'Which one?' }),
    ];
    // Seen AFTER the last activity -> read -> not a question.
    const seen = new Map<string, number>([['q', 200]]);
    const sections = buildSections(records, meta(), badge, seen);
    assert.strictEqual(sections.questions.length, 0, 'seen chat drops out of Questions');
  });
});

describe('orgPanelModel row status slot (lastSeenAt-driven)', () => {
  it("marks an unread assistant-last chat whose text asks a question as status 'question'", () => {
    const sections = buildSections(
      [record({ sessionId: 'q', lastMessageRole: 'assistant', lastMessageText: 'Which option do you want?' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted);
    assert.strictEqual(unsorted.rows[0].status, 'question');
  });

  it('tolerates trailing whitespace after the question mark', () => {
    const sections = buildSections(
      [record({ sessionId: 'q', lastMessageRole: 'assistant', lastMessageText: 'Ready to proceed?  \n' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].status, 'question');
  });

  it("marks an UNREAD non-question assistant-last chat as status 'done' (unread dot)", () => {
    // With an empty lastSeenAt map the assistant turn is unread; a non-question turn
    // is the solid 'done' dot.
    const sections = buildSections(
      [record({ sessionId: 'a', lastMessageRole: 'assistant', lastMessageText: 'Done, all green.' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].status, 'done');
  });

  it("marks a SEEN assistant-last chat as status 'none' (no fabricated unread affordance)", () => {
    // The lastSeenAt gate: a chat seen after its last activity shows an empty slot,
    // whether or not the assistant text asks something.
    const records = [
      record({ sessionId: 'q', timestamp: 100, lastMessageRole: 'assistant', lastMessageText: 'Which one?' }),
      record({ sessionId: 'd', timestamp: 100, lastMessageRole: 'assistant', lastMessageText: 'All done.' }),
    ];
    const seen = new Map<string, number>([
      ['q', 500],
      ['d', 500],
    ]);
    const sections = buildSections(records, meta(), badge, seen);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted);
    for (const r of unsorted.rows) {
      assert.strictEqual(r.status, 'none');
    }
  });

  it("an assistant turn NEWER than lastSeenAt is unread again (status re-appears)", () => {
    const records = [
      record({ sessionId: 'q', timestamp: 900, lastMessageRole: 'assistant', lastMessageText: 'Which one?' }),
    ];
    const seen = new Map<string, number>([['q', 500]]); // seen before the newer turn
    const sections = buildSections(records, meta(), badge, seen);
    assert.deepStrictEqual(sections.questions.map((r) => r.sessionId), ['q']);
  });

  it("leaves a user-last chat as status 'none' (superseded by a newer user message)", () => {
    const sections = buildSections(
      [record({ sessionId: 'u', lastMessageRole: 'user', lastMessageText: 'Can you fix this?' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].status, 'none');
  });

  it("marks an unread text-less assistant turn as 'done' (asks nothing) and a role-less chat as 'none'", () => {
    const sections = buildSections(
      [
        record({ sessionId: 'n', lastMessageRole: null, lastMessageText: null }),
        record({ sessionId: 't', lastMessageRole: 'assistant', lastMessageText: null }),
      ],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted);
    const n = unsorted.rows.find((r) => r.sessionId === 'n');
    const t = unsorted.rows.find((r) => r.sessionId === 't');
    assert.strictEqual(n && n.status, 'none', 'role-less is none');
    assert.strictEqual(t && t.status, 'done', 'unread text-less assistant asks nothing -> done');
  });

  it("recognizes an input-request assistant turn with no '?' as a question", () => {
    const sections = buildSections(
      [record({ sessionId: 'r', lastMessageRole: 'assistant', lastMessageText: 'I can do it. Let me know which approach you prefer.' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].status, 'question');
  });
});

describe('orgPanelModel row breadcrumb', () => {
  it('carries the folder path breadcrumb for a filed chat (Parent / Child)', () => {
    const records = [record({ sessionId: 'a' })];
    const m = meta({
      folders: {
        p: { id: 'p', name: 'Work', parentId: null, order: 0 },
        c: { id: 'c', name: 'Backend API', parentId: 'p', order: 0 },
      },
      chats: { a: { folderId: 'c', tags: [], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    const sections = buildSections(records, m, badge);
    const child = sections.folders.find((f) => f.folderId === 'c');
    assert.strictEqual(child && child.rows[0].breadcrumb, 'Work / Backend API');
  });

  it('leaves the breadcrumb null for an unfiled chat', () => {
    const records = [record({ sessionId: 'a' })];
    const sections = buildSections(records, meta(), badge);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].breadcrumb, null);
  });
});

describe('orgPanelModel starred section', () => {
  it('lists starred chats and hides nothing else by starring', () => {
    const records = [record({ sessionId: 's1' }), record({ sessionId: 's2' })];
    const m = meta({
      chats: {
        s1: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd', starred: true },
        s2: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd' },
      },
    });
    const sections = buildSections(records, m, badge);
    assert.deepStrictEqual(sections.starred.map((r) => r.sessionId), ['s1']);
    assert.strictEqual(sections.starred[0].starred, true);
  });

  it('a starred chat ALSO appears in its folder (cross-cutting, not single-home)', () => {
    const records = [record({ sessionId: 's1' })];
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Work', parentId: null, order: 0 } },
      chats: {
        s1: { folderId: 'f1', tags: [], links: [], updatedAt: 0, deviceId: 'd', starred: true },
      },
    });
    const sections = buildSections(records, m, badge);
    assert.deepStrictEqual(sections.starred.map((r) => r.sessionId), ['s1']);
    const work = sections.folders.find((f) => f.folderId === 'f1');
    assert.ok(work, 'folder f1 section exists');
    assert.deepStrictEqual(work.rows.map((r) => r.sessionId), ['s1'], 'and the chat is also in its folder');
  });
});

describe('orgPanelModel folder placement and color', () => {
  it('places each chat once in its single home folder; the Unsorted bucket holds the rest', () => {
    const records = [
      record({ sessionId: 'a' }),
      record({ sessionId: 'b' }),
      record({ sessionId: 'c' }),
    ];
    const m = meta({
      folders: { f1: { id: 'f1', name: 'F1', parentId: null, order: 0 } },
      chats: {
        a: { folderId: 'f1', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        b: { folderId: 'f1', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        // c is unfiled
      },
    });
    const sections = buildSections(records, m, badge);
    const f1 = sections.folders.find((f) => f.folderId === 'f1');
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.deepStrictEqual((f1 && f1.rows.map((r) => r.sessionId)) || [], ['a', 'b']);
    assert.deepStrictEqual((unsorted && unsorted.rows.map((r) => r.sessionId)) || [], ['c']);
    assert.strictEqual(unsorted && unsorted.synthetic, true);
  });

  it('routes a chat with a STALE folderId (folder deleted) to Unsorted', () => {
    const records = [record({ sessionId: 'a' })];
    const m = meta({
      folders: {}, // the folder 'gone' no longer exists
      chats: {
        a: { folderId: 'gone', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
      },
    });
    const sections = buildSections(records, m, badge);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.deepStrictEqual((unsorted && unsorted.rows.map((r) => r.sessionId)) || [], ['a']);
  });

  it('carries per-folder color onto the section', () => {
    const m = meta({
      folders: { f1: { id: 'f1', name: 'F1', parentId: null, order: 0, color: '#ff0000' } },
    });
    const sections = buildSections([], m, badge);
    const f1 = sections.folders.find((f) => f.folderId === 'f1');
    assert.strictEqual(f1 && f1.color, '#ff0000');
  });

  it('renders an empty folder section (no chats) and always includes Unsorted', () => {
    const m = meta({ folders: { f1: { id: 'f1', name: 'Empty', parentId: null, order: 0 } } });
    const sections = buildSections([], m, badge);
    const f1 = sections.folders.find((f) => f.folderId === 'f1');
    assert.ok(f1, 'the empty folder still renders a section');
    assert.deepStrictEqual(f1.rows, []);
    assert.ok(
      sections.folders.some((f) => f.folderId === UNSORTED_FOLDER_ID),
      'Unsorted is always present',
    );
  });

  it('orders folders by the order hint, with the synthetic Unsorted bucket last', () => {
    const m = meta({
      folders: {
        b: { id: 'b', name: 'Bravo', parentId: null, order: 1 },
        a: { id: 'a', name: 'Alpha', parentId: null, order: 0 },
      },
    });
    const sections = buildSections([], m, badge);
    assert.deepStrictEqual(
      sections.folders.map((f) => f.folderId),
      ['a', 'b', UNSORTED_FOLDER_ID],
    );
  });

  it('nests a child folder under its parent with depth + 1 (pre-order)', () => {
    const m = meta({
      folders: {
        p: { id: 'p', name: 'Parent', parentId: null, order: 0 },
        c: { id: 'c', name: 'Child', parentId: 'p', order: 0 },
      },
    });
    const sections = buildSections([], m, badge);
    const ids = sections.folders.map((f) => f.folderId);
    assert.deepStrictEqual(ids, ['p', 'c', UNSORTED_FOLDER_ID]);
    const parent = sections.folders.find((f) => f.folderId === 'p');
    const child = sections.folders.find((f) => f.folderId === 'c');
    assert.strictEqual(parent && parent.depth, 0);
    assert.strictEqual(child && child.depth, 1);
    // treeDepth equals depth when within the render cap.
    assert.strictEqual(parent && parent.treeDepth, 0);
    assert.strictEqual(child && child.treeDepth, 1);
  });
});

describe('orgPanelModel one-visible-sublevel depth clamp (issue #82 AC4)', () => {
  // A four-tier legacy hierarchy: root(0) -> a(1) -> b(2) -> c(3). Rendering clamps
  // the emitted depth at MAX_FOLDER_RENDER_DEPTH (2); the stored parentId chain is
  // never touched and treeDepth carries the true depth.
  function deepMeta(): ProjectMeta {
    return meta({
      folders: {
        root: { id: 'root', name: 'root', parentId: null, order: 0 },
        a: { id: 'a', name: 'a', parentId: 'root', order: 0 },
        b: { id: 'b', name: 'b', parentId: 'a', order: 0 },
        c: { id: 'c', name: 'c', parentId: 'b', order: 0 },
      },
    });
  }

  it('clamps a deeper legacy folder to render depth 2 but preserves the true treeDepth', () => {
    const sections = buildSections([], deepMeta(), badge);
    const get = (id: string): FolderSection => {
      const f = sections.folders.find((s) => s.folderId === id);
      assert.ok(f, `section ${id} exists`);
      return f;
    };
    assert.strictEqual(get('root').depth, 0);
    assert.strictEqual(get('a').depth, 1);
    // b (stored depth 2) renders at 2; c (stored depth 3) is CLAMPED to 2.
    assert.strictEqual(get('b').depth, 2, 'depth-2 folder renders at 2');
    assert.strictEqual(get('c').depth, 2, 'depth-3 legacy folder is clamped to render depth 2');
    // The true structural depth is preserved for the collapse/hide bookkeeping.
    assert.strictEqual(get('b').treeDepth, 2);
    assert.strictEqual(get('c').treeDepth, 3, 'treeDepth keeps the uncapped depth');
  });

  it('never modifies the stored folder records (data preserved through the clamp)', () => {
    const m = deepMeta();
    // Snapshot the stored folders before assembling.
    const before = JSON.parse(JSON.stringify(m.folders));
    buildSections([], m, badge);
    // The model must not mutate the meta it was handed.
    assert.deepStrictEqual(m.folders, before, 'buildSections must not mutate stored folders');
    // parentId chain is intact: c -> b -> a -> root -> null.
    assert.strictEqual(m.folders.c.parentId, 'b');
    assert.strictEqual(m.folders.b.parentId, 'a');
    assert.strictEqual(m.folders.a.parentId, 'root');
    assert.strictEqual(m.folders.root.parentId, null);
  });

  it('keeps a chat homed in a clamped-deep folder (its rows are not lost)', () => {
    const m = deepMeta();
    m.chats = { x: { folderId: 'c', tags: [], links: [], updatedAt: 0, deviceId: 'd' } };
    const sections = buildSections(
      [record({ sessionId: 'x', lastMessageRole: 'assistant', lastMessageText: 'hi' })],
      m,
      badge,
    );
    const deep = sections.folders.find((f) => f.folderId === 'c');
    assert.ok(deep, 'the clamped-deep folder section still exists');
    assert.deepStrictEqual(deep.rows.map((r) => r.sessionId), ['x'], 'its chat is placed, not dropped');
  });
});

describe('orgPanelModel rolled-up folder count (issue #82 AC1)', () => {
  it('rolls a top folder count up over its subfolders (chats in it + descendants)', () => {
    // Work(2 direct) -> API(3 direct) -> Deep(1 direct); Personal(1 direct).
    const m = meta({
      folders: {
        work: { id: 'work', name: 'Work', parentId: null, order: 0 },
        api: { id: 'api', name: 'API', parentId: 'work', order: 0 },
        deep: { id: 'deep', name: 'Deep', parentId: 'api', order: 0 },
        personal: { id: 'personal', name: 'Personal', parentId: null, order: 1 },
      },
      chats: {
        w1: { folderId: 'work', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        w2: { folderId: 'work', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        a1: { folderId: 'api', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        a2: { folderId: 'api', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        a3: { folderId: 'api', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        d1: { folderId: 'deep', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        p1: { folderId: 'personal', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
      },
    });
    const records = ['w1', 'w2', 'a1', 'a2', 'a3', 'd1', 'p1'].map((id) => record({ sessionId: id }));
    const sections = buildSections(records, m, badge);
    const get = (id: string): FolderSection => {
      const f = sections.folders.find((s) => s.folderId === id);
      assert.ok(f, `section ${id} exists`);
      return f;
    };
    // Deep: 1 own. API: 3 own + 1 (Deep) = 4. Work: 2 own + 4 (API subtree) = 6.
    assert.strictEqual(get('deep').rolledUpCount, 1);
    assert.strictEqual(get('api').rolledUpCount, 4);
    assert.strictEqual(get('work').rolledUpCount, 6, 'top folder count includes all descendants');
    assert.strictEqual(get('personal').rolledUpCount, 1);
  });

  it('excludes archived chats from the rolled-up count (they are hidden)', () => {
    const m = meta({
      folders: { f: { id: 'f', name: 'F', parentId: null, order: 0 } },
      chats: {
        keep: { folderId: 'f', tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        gone: { folderId: 'f', tags: [], links: [], updatedAt: 0, deviceId: 'd', userArchived: true },
      },
    });
    const records = [record({ sessionId: 'keep' }), record({ sessionId: 'gone' })];
    const sections = buildSections(records, m, badge);
    const f = sections.folders.find((s) => s.folderId === 'f');
    // The archived chat is excluded from visible rows AND the rollup count.
    assert.strictEqual(f && f.rolledUpCount, 1, 'archived chat not counted in the rollup');
  });

  it('the synthetic Unsorted count is its own rows only (no descendants)', () => {
    const m = meta({
      chats: { u: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    const sections = buildSections([record({ sessionId: 'u' })], m, badge);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rolledUpCount, 1);
  });
});

describe('orgPanelModel tag chips and row tags', () => {
  it('builds one chip per tag carried by a scanned chat, with label, color, and count', () => {
    const records = [record({ sessionId: 'a' }), record({ sessionId: 'b' })];
    const m = meta({
      tags: {
        t1: { id: 't1', label: 'urgent', color: '#aabbcc' },
        t2: { id: 't2', label: 'idea' },
        t3: { id: 't3', label: 'unused' },
      },
      chats: {
        a: { folderId: null, tags: ['t1', 't2'], links: [], updatedAt: 0, deviceId: 'd' },
        b: { folderId: null, tags: ['t1'], links: [], updatedAt: 0, deviceId: 'd' },
      },
    });
    const sections = buildSections(records, m, badge);
    const byId = new Map(sections.tags.map((c) => [c.tagId, c]));
    const t1 = byId.get('t1');
    const t2 = byId.get('t2');
    assert.ok(t1 && t2, 'chips for t1 and t2 exist');
    assert.strictEqual(t1.count, 2);
    assert.strictEqual(t1.color, '#aabbcc');
    assert.strictEqual(t2.count, 1);
    assert.ok(!byId.has('t3'), 'a tag with zero carrying chats is omitted');
  });

  it('allTags lists EVERY tag (including a zero-chat tag the chip row omits) for the context menu', () => {
    const records = [record({ sessionId: 'a' }), record({ sessionId: 'b' })];
    const m = meta({
      tags: {
        t1: { id: 't1', label: 'urgent', color: '#aabbcc' },
        t2: { id: 't2', label: 'idea' },
        t3: { id: 't3', label: 'unused' },
        t4: { id: 't4', label: '' }, // blank label: unusable menu row, dropped
      },
      chats: {
        a: { folderId: null, tags: ['t1', 't2'], links: [], updatedAt: 0, deviceId: 'd' },
        b: { folderId: null, tags: ['t1'], links: [], updatedAt: 0, deviceId: 'd' },
      },
    });
    const sections = buildSections(records, m, badge);
    // The chip row omits the zero-chat tag; allTags keeps it (issue #85 AC #1).
    const chipIds = new Set(sections.tags.map((c) => c.tagId));
    assert.ok(!chipIds.has('t3'), 'chip row omits the zero-chat tag');
    const allById = new Map(sections.allTags.map((c) => [c.tagId, c]));
    assert.ok(allById.has('t3'), 'allTags KEEPS the zero-chat tag');
    assert.strictEqual(allById.get('t3')?.count, 0, 'the zero-chat tag reports count 0');
    assert.strictEqual(allById.get('t1')?.count, 2, 'a carried tag reports its count');
    assert.strictEqual(allById.get('t1')?.color, '#aabbcc', 'allTags carries the tag color');
    assert.ok(!allById.has('t4'), 'a blank-label tag is dropped from allTags');
    // Sorted by label case-insensitive: idea, unused, urgent (blank t4 dropped).
    assert.deepStrictEqual(
      sections.allTags.map((c) => c.tagId),
      ['t2', 't3', 't1'],
      'allTags is sorted by label (case-insensitive) then id',
    );
  });

  it('allTags is empty when meta is undefined', () => {
    const sections = buildSections([record({ sessionId: 'a' })], undefined, badge);
    assert.deepStrictEqual(sections.allTags, []);
  });

  it('row carries both tagIds (for the chip filter and DnD) and resolved labels', () => {
    const records = [record({ sessionId: 'a' })];
    const m = meta({
      tags: { t1: { id: 't1', label: 'urgent' } },
      chats: { a: { folderId: null, tags: ['t1', 'gone'], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    const sections = buildSections(records, m, badge);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted, 'Unsorted section exists');
    const row = unsorted.rows[0];
    assert.deepStrictEqual(row.tagIds, ['t1', 'gone'], 'all stored ids, including unresolved');
    assert.deepStrictEqual(row.tags, ['urgent'], 'only resolved labels');
  });

  it('row carries tagColors aligned to tags: color or null per resolved tag, unresolved dropped', () => {
    const records = [record({ sessionId: 'a' })];
    const m = meta({
      tags: {
        t1: { id: 't1', label: 'bug', color: '#B14F36' },
        t2: { id: 't2', label: 'idea' }, // no color
      },
      chats: { a: { folderId: null, tags: ['t1', 't2', 'gone'], links: [], updatedAt: 0, deviceId: 'd' } },
    });
    const sections = buildSections(records, m, badge);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted, 'Unsorted section exists');
    const row = unsorted.rows[0];
    assert.deepStrictEqual(row.tags, ['bug', 'idea'], 'only resolved labels, in order');
    assert.deepStrictEqual(
      row.tagColors,
      ['#B14F36', null],
      'colors are parallel to tags: a hue for t1, null for the colorless t2, and the unresolved id contributes nothing',
    );
    assert.strictEqual(row.tags.length, row.tagColors.length, 'tags and tagColors stay the same length');
  });
});

describe('orgPanelModel archived exclusion and count', () => {
  it('excludes a userArchived chat from every visible section and counts it in archivedCount', () => {
    const records = [
      record({ sessionId: 'live' }),
      // unread assistant-asking: WITHOUT archiving this would be in Questions, so the
      // exclusion is genuinely exercised.
      record({ sessionId: 'gone', lastMessageRole: 'assistant', lastMessageText: 'Which one?' }),
    ];
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Work', parentId: null, order: 0 } },
      tags: { t1: { id: 't1', label: 'bug' } },
      chats: {
        live: { folderId: 'f1', tags: ['t1'], links: [], updatedAt: 0, deviceId: 'd' },
        // archived AND filed AND tagged AND starred AND unread-asking: it must appear
        // in NONE of the sections/chips and be counted once instead.
        gone: {
          folderId: 'f1',
          tags: ['t1'],
          links: [],
          updatedAt: 0,
          deviceId: 'd',
          starred: true,
          userArchived: true,
        },
      },
    });
    const sections = buildSections(records, m, badge);
    assert.strictEqual(sections.archivedCount, 1, 'one archived chat counted');
    // Not in Starred (even though starred), not in Questions (even though unread-asking).
    assert.deepStrictEqual(sections.starred.map((r) => r.sessionId), [], 'archived starred chat is not in Starred');
    assert.deepStrictEqual(sections.questions.map((r) => r.sessionId), [], 'archived unread-asking chat is not in Questions');
    // Not in its folder; only the live chat remains.
    const f1 = sections.folders.find((f) => f.folderId === 'f1');
    assert.deepStrictEqual((f1 && f1.rows.map((r) => r.sessionId)) || [], ['live'], 'folder holds only the live chat');
    // The tag chip counts only the live carrier (the archived carrier is excluded).
    const chip = sections.tags.find((c) => c.tagId === 't1');
    assert.strictEqual(chip && chip.count, 1, 'the tag chip counts only the visible carrier');
  });

  it('archivedCount is 0 and all chats render when nothing is archived', () => {
    const records = [record({ sessionId: 'a' }), record({ sessionId: 'b' })];
    const sections = buildSections(records, meta(), badge);
    assert.strictEqual(sections.archivedCount, 0);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows.length, 2);
  });

  it('a userArchived:false chat is treated as visible (not archived)', () => {
    const records = [record({ sessionId: 'a' })];
    const m = meta({
      chats: { a: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd', userArchived: false } },
    });
    const sections = buildSections(records, m, badge);
    assert.strictEqual(sections.archivedCount, 0);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows.length, 1, 'the non-archived chat still renders');
  });
});

describe('orgPanelModel absent-meta tolerance', () => {
  it('with no meta, every chat is unfiled/untagged/unstarred, status still derived', () => {
    const records = [
      record({ sessionId: 'u', lastMessageRole: 'user', tokenTotals: totals({ input: 5 }) }),
      // unread assistant asking -> Questions even with no meta
      record({ sessionId: 'a', lastMessageRole: 'assistant', lastMessageText: 'Which one?' }),
    ];
    const sections = buildSections(records, undefined, badge);
    assert.strictEqual(sections.starred.length, 0);
    assert.strictEqual(sections.tags.length, 0);
    assert.deepStrictEqual(
      sections.questions.map((r) => r.sessionId),
      ['a'],
      'the unread assistant-asking chat is in Questions even with no meta',
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted, 'Unsorted section exists');
    assert.strictEqual(unsorted.rows.length, 2, 'both chats land in Unsorted');
    const uRow = unsorted.rows.find((r) => r.sessionId === 'u');
    assert.ok(uRow, 'the user-last chat is in Unsorted');
    assert.strictEqual(uRow.tokens, '~5 tokens', 'the badge seam fn is still applied');
    assert.strictEqual(uRow.breadcrumb, null, 'no breadcrumb without a folder');
  });
});

describe('orgPanelModel row sort', () => {
  it('sorts folder rows newest-first by timestamp (no timestamp last)', () => {
    const records = [
      record({ sessionId: 'old', timestamp: 100 }),
      record({ sessionId: 'new', timestamp: 300 }),
      record({ sessionId: 'none', timestamp: null }),
    ];
    const sections = buildSections(records, meta(), badge);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted, 'Unsorted section exists');
    assert.deepStrictEqual(unsorted.rows.map((r) => r.sessionId), ['new', 'old', 'none']);
  });
});
