import * as assert from 'assert';
import {
  FleetSections,
  GroupModelInput,
  ModelChat,
  buildFleetSections,
  dateGroupIndex,
  groupId,
} from '../../fleet/groupModel';
import { ChatStatus } from '../../fleet/status';
import { FleetEntry, FleetState } from '../../fleet/types';
import { RESERVED_SENTINELS } from '../../model/idFactory';

const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime(); // Wednesday
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entry(id: string, extra: Partial<FleetEntry> = {}): FleetEntry {
  return {
    sessionId: id, name: '', ticket: null, role: null, agent: '', launchedBy: '', cwd: '', client: '', folder: null,
    tags: [], stage: null, ended: false, outcome: null, firstAt: null, lastAt: null, isBackfill: false, ...extra,
  };
}
function chat(id: string, extra: Partial<ModelChat> = {}): ModelChat {
  return { sessionId: id, title: 'chat ' + id, timestamp: NOW - HOUR, cwd: null, handFiledFolderId: null, archived: false, ...extra };
}
function fleet(entries: FleetEntry[], current: FleetEntry | null = null): FleetState {
  return {
    entries,
    currentOrchestrator: current,
    pastOrchestrators: entries.filter((e) => e.role === 'orchestrator' && e !== current),
  };
}
function build(extra: Partial<GroupModelInput>): FleetSections {
  return buildFleetSections({
    chats: [], userFolders: [], fleet: fleet([]), statuses: new Map(), attachableIds: new Set(), queueRows: [], groupBy: 'tickets',
    workspaceRoot: '/ws', now: NOW, active: false, ...extra,
  });
}
const st = (pairs: Record<string, ChatStatus>) => new Map(Object.entries(pairs));

describe('groupModel tickets mode', () => {
  const orch = entry('aaaa0001', { role: 'orchestrator', name: 'orch', firstAt: '2026-06-17T08:00:00Z' });
  const oldOrch = entry('aaaa0002', { role: 'orchestrator', name: 'old orch', firstAt: '2026-06-10T08:00:00Z' });
  const older = entry('aaaa0003', { role: 'orchestrator', name: 'older orch', firstAt: '2026-06-01T08:00:00Z' });

  it('pins the current orchestrator and lists past ones newest first', () => {
    const out = build({
      chats: [chat('aaaa0001'), chat('aaaa0002'), chat('aaaa0003', { timestamp: NOW - 20 * DAY })],
      fleet: fleet([orch, oldOrch, older], orch),
    });
    assert.strictEqual(out.orchestrator?.sessionId, 'aaaa0001');
    assert.deepStrictEqual(out.pastOrchestrators.map((r) => r.sessionId), ['aaaa0002', 'aaaa0003']);
    assert.strictEqual(out.groups.length, 0);
  });

  it('groups chats per ticket with queue title and stage, rollup and agent tag', () => {
    const a = entry('bbbb0001', { ticket: 'TKT-1', name: 'TKT-1 build round 2', agent: 'build', stage: 'review' });
    const b = entry('bbbb0002', { ticket: 'TKT-1', name: 'TKT-1 qa', role: 'qa' });
    const out = build({
      chats: [chat('bbbb0001'), chat('bbbb0002', { timestamp: NOW - 2 * HOUR })],
      fleet: fleet([a, b]),
      statuses: st({ bbbb0001: 'idle', bbbb0002: 'working' }),
      queueRows: [{ key: 'tkt-1', stage: 'Testing', title: 'Import data' }],
    });
    const g = out.groups[0];
    assert.strictEqual(g.ticket, 'TKT-1');
    assert.strictEqual(g.title, 'Import data');
    assert.strictEqual(g.stage, 'Testing');
    assert.strictEqual(g.rollup, 'working');
    assert.deepStrictEqual(g.rows.map((r) => [r.agentTag, r.suffix]), [['build', 'round 2'], ['qa', '']]);
  });

  it('derives title from the newest chat name and stage from the newest organize stage', () => {
    const a = entry('bbbb0001', { ticket: 'TKT-1', name: 'TKT-1 Import data', stage: 'old' });
    const b = entry('bbbb0002', { ticket: 'TKT-1', name: 'TKT-1 Newer name', stage: 'new' });
    const out = build({
      chats: [chat('bbbb0001', { timestamp: NOW - DAY }), chat('bbbb0002')],
      fleet: fleet([a, b]),
    });
    assert.strictEqual(out.groups[0].title, 'Newer name');
    assert.strictEqual(out.groups[0].stage, 'new');
  });

  it('falls back to the newest chat when the queue title is empty', () => {
    const a = entry('bbbb0001', { ticket: 'TKT-1', name: 'TKT-1 Fallback' });
    const out = build({
      chats: [chat('bbbb0001')], fleet: fleet([a]),
      queueRows: [{ key: 'TKT-1', stage: '', title: null }],
    });
    assert.strictEqual(out.groups[0].title, 'Fallback');
  });

  it('puts chats without a ticket in Unsorted and counts archived ones', () => {
    const out = build({
      chats: [chat('cccc0001'), chat('cccc0002', { archived: true })],
      fleet: fleet([]),
    });
    assert.deepStrictEqual(out.unsorted.map((r) => r.sessionId), ['cccc0001']);
    assert.strictEqual(out.archivedCount, 1);
  });

  it('includes a fleet entry with no transcript as a queued chat', () => {
    const e = entry('dddd0001', { ticket: 'TKT-2', name: 'TKT-2 queued' });
    const out = build({ fleet: fleet([e]), statuses: st({ dddd0001: 'queued' }) });
    assert.strictEqual(out.groups[0].rows[0].status, 'queued');
    assert.strictEqual(out.groups[0].rollup, 'queued');
  });
});

describe('groupModel precedence', () => {
  it('keeps a hand-filed chat in its user folder in every mode', () => {
    const e = entry('eeee0001', { ticket: 'TKT-1', folder: 'Virtual' });
    for (const mode of ['tickets', 'folders', 'date', 'auto'] as const) {
      const out = build({
        groupBy: mode,
        chats: [chat('eeee0001', { handFiledFolderId: 'f1' })],
        userFolders: [{ folderId: 'f1', name: 'Mine' }],
        fleet: fleet([e]),
      });
      assert.deepStrictEqual(out.userFolders[0].rows.map((r) => r.sessionId), ['eeee0001'], mode);
      assert.strictEqual(out.groups.length, 0, mode);
    }
  });

  it('a stale hand-filed folder id does not hide the chat', () => {
    const out = build({ chats: [chat('eeee0002', { handFiledFolderId: 'gone' })] });
    assert.strictEqual(out.unsorted.length, 1);
  });

  it('a fleet organize folder wins over the ticket and is a virtual group', () => {
    const e = entry('eeee0003', { ticket: 'TKT-1', folder: 'Virtual' });
    const out = build({ chats: [chat('eeee0003')], fleet: fleet([e]) });
    assert.strictEqual(out.groups[0].kind, 'folder');
    assert.strictEqual(out.groups[0].label, 'Virtual');
  });
});

describe('groupModel folders mode', () => {
  it('groups by the working subfolder relative to the root, fleet cwd first', () => {
    const e = entry('ffff0001', { cwd: '/ws/api' });
    const out = build({
      groupBy: 'folders',
      chats: [chat('ffff0001', { cwd: '/ws/other' }), chat('ffff0002', { cwd: '/ws/web/app' }), chat('ffff0003', { cwd: '/ws' }), chat('ffff0004', { cwd: '/elsewhere' }), chat('ffff0005')],
      fleet: fleet([e]),
    });
    assert.deepStrictEqual(out.groups.map((g) => g.label).sort(), ['Workspace root', 'api', 'web/app']);
    assert.deepStrictEqual(out.unsorted.map((r) => r.sessionId).sort(), ['ffff0004', 'ffff0005']);
  });

  it('nests a chat under the chat that launched it, one level', () => {
    const p = entry('ffff0010', { cwd: '/ws/api' });
    const c = entry('ffff0011', { cwd: '/ws/api', launchedBy: 'ffff0010' });
    const gc = entry('ffff0012', { cwd: '/ws/api', launchedBy: 'ffff0011' });
    const far = entry('ffff0013', { cwd: '/ws/web', launchedBy: 'ffff0010' });
    const out = build({
      groupBy: 'folders',
      chats: ['ffff0010', 'ffff0011', 'ffff0012', 'ffff0013'].map((id) => chat(id)),
      fleet: fleet([p, c, gc, far]),
    });
    const api = out.groups.find((g) => g.label === 'api');
    assert.deepStrictEqual(api?.rows.map((r) => r.sessionId), ['ffff0010']);
    assert.deepStrictEqual(api?.rows[0].children.map((r) => r.sessionId).sort(), ['ffff0011', 'ffff0012']);
    assert.strictEqual(out.groups.find((g) => g.label === 'web')?.rows[0].sessionId, 'ffff0013');
  });

  it('survives a launch cycle', () => {
    const x = entry('ffff0020', { cwd: '/ws/a', launchedBy: 'ffff0021' });
    const y = entry('ffff0021', { cwd: '/ws/a', launchedBy: 'ffff0020' });
    const out = build({ groupBy: 'folders', chats: [chat('ffff0020'), chat('ffff0021')], fleet: fleet([x, y]) });
    assert.strictEqual(out.groups[0].rows.length, 2);
    assert.ok(out.groups[0].rows.every((r) => r.children.length === 0));
  });
});

describe('groupModel date mode', () => {
  it('buckets by the local calendar week', () => {
    assert.strictEqual(dateGroupIndex(NOW - HOUR, NOW), 0);
    assert.strictEqual(dateGroupIndex(NOW - DAY, NOW), 1); // Tuesday
    assert.strictEqual(dateGroupIndex(new Date(2026, 5, 15, 0, 0, 1).getTime(), NOW), 1); // Monday
    assert.strictEqual(dateGroupIndex(new Date(2026, 5, 14, 23, 0, 0).getTime(), NOW), 2); // Sunday before
    assert.strictEqual(dateGroupIndex(null, NOW), 2);
  });
  it('on Monday earlier this week is empty', () => {
    const monday = new Date(2026, 5, 15, 12, 0, 0).getTime();
    assert.strictEqual(dateGroupIndex(monday - HOUR * 20, monday), 2);
  });
  it('builds groups in Today, Earlier this week, Older order and skips empty ones', () => {
    const out = build({
      groupBy: 'date',
      chats: [chat('1111aaaa', { timestamp: NOW - 30 * DAY }), chat('1111bbbb'), chat('1111cccc', { timestamp: null })],
    });
    assert.deepStrictEqual(out.groups.map((g) => g.label), ['Today', 'Older']);
    assert.strictEqual(out.groups[1].rows.length, 2);
  });
});

describe('groupModel auto mode', () => {
  it('picks tickets when any fleet entry has a ticket', () => {
    const e = entry('2222aaaa', { ticket: 'TKT-1' });
    assert.strictEqual(build({ groupBy: 'auto', chats: [chat('2222aaaa')], fleet: fleet([e]) }).mode, 'tickets');
  });
  it('picks folders when chats span more than one subfolder', () => {
    const out = build({ groupBy: 'auto', chats: [chat('2222bbbb', { cwd: '/ws/a' }), chat('2222cccc', { cwd: '/ws/b' })] });
    assert.strictEqual(out.mode, 'folders');
  });
  it('picks date otherwise', () => {
    const out = build({ groupBy: 'auto', chats: [chat('2222dddd', { cwd: '/ws/a' }), chat('2222eeee', { cwd: '/ws/a' })] });
    assert.strictEqual(out.mode, 'date');
  });
});

describe('groupModel active projection and queue', () => {
  const orch = entry('3333aaaa', { role: 'orchestrator', name: 'orch' });
  const a = entry('3333bbbb', { ticket: 'TKT-1', name: 'TKT-1 a' });
  const b = entry('3333cccc', { ticket: 'TKT-1', name: 'TKT-1 b' });
  const c = entry('3333dddd', { ticket: 'TKT-2', name: 'TKT-2 c' });
  const base = {
    chats: ['3333aaaa', '3333bbbb', '3333cccc', '3333dddd', '3333eeee'].map((id) => chat(id)),
    fleet: fleet([orch, a, b, c], orch),
    statuses: st({ '3333aaaa': 'working', '3333bbbb': 'needs', '3333cccc': 'idle', '3333dddd': 'done', '3333eeee': 'idle' }),
  };

  it('keeps only working and needs chats and opens their groups', () => {
    const out = build({ ...base, active: true });
    assert.deepStrictEqual(out.groups.map((g) => g.ticket), ['TKT-1']);
    assert.deepStrictEqual(out.groups[0].rows.map((r) => r.sessionId), ['3333bbbb']);
    assert.strictEqual(out.groups[0].forceOpen, true);
    assert.strictEqual(out.unsorted.length, 0);
    assert.strictEqual(out.orchestrator?.sessionId, '3333aaaa');
  });

  it('counts the orchestrator in the Active count', () => {
    assert.strictEqual(build({ ...base, active: false }).activeCount, 2);
    assert.strictEqual(build({ ...base, active: true }).activeCount, 2);
  });

  it('does not force groups open outside the projection', () => {
    assert.ok(build({ ...base }).groups.every((g) => !g.forceOpen));
  });

  it('lists queue rows in file order and marks tickets with a live chat', () => {
    const out = build({
      ...base,
      queueRows: [
        { key: 'TKT-2', stage: 'Build', title: 'Two' },
        { key: 'tkt-1', stage: 'QA', title: null },
        { key: 'TKT-9', stage: '', title: 'Nine' },
      ],
    });
    assert.deepStrictEqual(out.queue, [
      { key: 'TKT-2', title: 'Two', stage: 'Build', live: false },
      { key: 'tkt-1', title: '', stage: 'QA', live: true },
      { key: 'TKT-9', title: 'Nine', stage: '', live: false },
    ]);
  });
});

describe('groupModel ids', () => {
  it('never mints a separator or a reserved sentinel', () => {
    const e = entry('4444aaaa', { ticket: 'A:B#C>D', folder: null });
    const out = build({ chats: [chat('4444aaaa')], fleet: fleet([e]) });
    for (const g of out.groups) {
      assert.ok(!/[:#>]/.test(g.id), g.id);
      assert.ok(!RESERVED_SENTINELS.has(g.id));
    }
    assert.strictEqual(groupId('ticket', 'A:B#C>D'), 'ticket.A%3AB%23C%3ED');
  });
  it('keeps folder names that differ only by a forbidden character apart', () => {
    assert.notStrictEqual(groupId('folder', 'a:b'), groupId('folder', 'a-b'));
    assert.notStrictEqual(groupId('folder', 'a%3Ab'), groupId('folder', 'a:b'));
    const a = entry('5555aaaa', { folder: 'a:b' });
    const b = entry('5555bbbb', { folder: 'a-b' });
    const out = build({ chats: [chat('5555aaaa'), chat('5555bbbb')], fleet: fleet([a, b]) });
    assert.strictEqual(out.groups.length, 2);
  });
  it('groups ticket keys case-insensitively and shows the first spelling', () => {
    const a = entry('6666aaaa', { ticket: 'TKT-1', name: 'a' });
    const b = entry('6666bbbb', { ticket: 'tkt-1', name: 'b' });
    const out = build({ chats: [chat('6666aaaa'), chat('6666bbbb')], fleet: fleet([a, b]) });
    assert.strictEqual(out.groups.length, 1);
    assert.strictEqual(out.groups[0].ticket, 'TKT-1');
    assert.strictEqual(out.groups[0].rows.length, 2);
  });
  it('reserves the fleet panel sentinels', () => {
    for (const id of ['__orchestrator__', '__past_orchestrators__', '__archived__', '__queue__']) {
      assert.ok(RESERVED_SENTINELS.has(id), id);
    }
  });
});

describe('groupModel attachable rows', () => {
  it('marks only the rows whose session id is in the attachable set', () => {
    const a = entry('cccc0001', { ticket: 'TKT-9', name: 'TKT-9 build' });
    const b = entry('cccc0002', { ticket: 'TKT-9', name: 'TKT-9 qa' });
    const out = build({
      chats: [chat('cccc0001'), chat('cccc0002')],
      fleet: fleet([a, b]),
      statuses: st({ cccc0001: 'working', cccc0002: 'needs' }),
      attachableIds: new Set(['cccc0001']),
    });
    const flags = Object.fromEntries(out.groups[0].rows.map((r) => [r.sessionId, r.attachable]));
    assert.deepStrictEqual(flags, { cccc0001: true, cccc0002: false });
  });

  it('marks a fleet-only queued row and an unsorted row from the same set', () => {
    const queued = entry('dddd0001', { ticket: 'TKT-8', name: 'TKT-8 build' });
    const out = build({
      chats: [chat('dddd0002')],
      fleet: fleet([queued]),
      attachableIds: new Set(['dddd0001', 'dddd0002']),
    });
    assert.strictEqual(out.groups[0].rows[0].attachable, true);
    assert.strictEqual(out.unsorted[0].attachable, true);
  });
});
