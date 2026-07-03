import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { ProjectMeta } from '../../store/schema';
import { buildSections, UNSORTED_FOLDER_ID } from '../../views/orgPanelModel';
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

describe('orgPanelModel awaiting-reply heuristic', () => {
  it('flags ONLY chats whose lastMessageRole === "user"', () => {
    const records = [
      record({ sessionId: 'u', lastMessageRole: 'user' }),
      record({ sessionId: 'a', lastMessageRole: 'assistant' }),
      record({ sessionId: 'n', lastMessageRole: null }),
    ];
    const sections = buildSections(records, meta(), badge);
    assert.deepStrictEqual(
      sections.questions.map((r) => r.sessionId),
      ['u'],
      'only the user-last chat is in Questions',
    );
    assert.strictEqual(sections.questions[0].awaitingReply, true);
  });

  it('does not flag an assistant-last or role-less chat', () => {
    const sections = buildSections(
      [record({ sessionId: 'a', lastMessageRole: 'assistant' })],
      meta(),
      badge,
    );
    assert.strictEqual(sections.questions.length, 0);
  });
});

describe('orgPanelModel row status slot', () => {
  it("marks an assistant-last chat whose text asks a question as status 'question'", () => {
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

  it("leaves a non-question assistant-last chat as status 'none' (no fabricated unread dot)", () => {
    // The 'done' dot needs the not-yet-built lastSeenAt read-state gate; the pure
    // model must NOT emit a dot for every assistant-last chat.
    const sections = buildSections(
      [record({ sessionId: 'a', lastMessageRole: 'assistant', lastMessageText: 'Done, all green.' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].status, 'none');
  });

  it("leaves a user-last chat as status 'none' (it is surfaced via Questions instead)", () => {
    const sections = buildSections(
      [record({ sessionId: 'u', lastMessageRole: 'user', lastMessageText: 'Can you fix this?' })],
      meta(),
      badge,
    );
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.strictEqual(unsorted && unsorted.rows[0].status, 'none');
  });

  it("leaves a role-less or text-less chat as status 'none'", () => {
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
    for (const r of unsorted.rows) {
      assert.strictEqual(r.status, 'none');
    }
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
      record({ sessionId: 'gone', lastMessageRole: 'user' }),
    ];
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Work', parentId: null, order: 0 } },
      tags: { t1: { id: 't1', label: 'bug' } },
      chats: {
        live: { folderId: 'f1', tags: ['t1'], links: [], updatedAt: 0, deviceId: 'd' },
        // archived AND filed AND tagged AND user-last: it must appear in NONE of the
        // sections/chips and be counted once instead.
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
    // Not in Starred (even though starred), not in Questions (even though user-last).
    assert.deepStrictEqual(sections.starred.map((r) => r.sessionId), [], 'archived starred chat is not in Starred');
    assert.deepStrictEqual(sections.questions.map((r) => r.sessionId), [], 'archived user-last chat is not in Questions');
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
  it('with no meta, every chat is unfiled/untagged/unstarred, heuristic still applied', () => {
    const records = [
      record({ sessionId: 'u', lastMessageRole: 'user', tokenTotals: totals({ input: 5 }) }),
      record({ sessionId: 'a', lastMessageRole: 'assistant' }),
    ];
    const sections = buildSections(records, undefined, badge);
    assert.strictEqual(sections.starred.length, 0);
    assert.strictEqual(sections.tags.length, 0);
    assert.deepStrictEqual(sections.questions.map((r) => r.sessionId), ['u']);
    const unsorted = sections.folders.find((f) => f.folderId === UNSORTED_FOLDER_ID);
    assert.ok(unsorted, 'Unsorted section exists');
    assert.strictEqual(unsorted.rows.length, 2, 'both chats land in Unsorted');
    const uRow = unsorted.rows.find((r) => r.sessionId === 'u');
    assert.ok(uRow, 'the user-last chat is in Unsorted');
    assert.strictEqual(uRow.tokens, '~5 tokens', 'the badge fn is applied');
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
