import * as assert from 'assert';
import { parseNestConfig } from '../../fleet/nestConfig';
import {
  CompiledRule,
  PlanChatState,
  RuleSubject,
  buildRuleSubjects,
  compileRules,
  expandFolderTemplate,
  firstMatch,
  planOrganize,
  planUndo,
} from '../../fleet/rules';
import { FleetEntry } from '../../fleet/types';
import type { Folder, OrganizeLedger, Tag } from '../../store/schema';

function subject(over: Partial<RuleSubject> = {}): RuleSubject {
  return {
    sessionId: 'aaaaaaaa-0001',
    title: 'Chat title',
    name: 'Chat title',
    ticket: null,
    role: null,
    agent: '',
    cwd: null,
    fleetTitle: '',
    subfolder: '',
    ...over,
  };
}

function compile(rules: unknown[]): { rules: readonly CompiledRule[]; problems: readonly string[] } {
  const parsed = parseNestConfig(JSON.stringify({ rules }));
  return compileRules(parsed.config.rules);
}

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({ id, name, parentId, order: 0 });
const tag = (id: string, label: string): Tag => ({ id, label });
const free: PlanChatState = { folderId: null, tagIds: [], starred: false };

describe('compileRules', () => {
  it('compiles a valid rule', () => {
    const { rules, problems } = compile([{ match: { role: 'QA', ticket: true }, folder: 'Reviews', tags: ['qa', 'qa'], pin: true }]);
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].role, 'qa');
    assert.strictEqual(rules[0].ticket, true);
    assert.deepStrictEqual(rules[0].tags, ['qa']);
    assert.strictEqual(rules[0].pin, true);
  });

  it('disables only the rule with an invalid regex', () => {
    const { rules, problems } = compile([
      { match: { name: '(' }, tags: ['x'] },
      { match: { role: 'qa' }, tags: ['qa'] },
    ]);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].index, 1);
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].includes('rules[0]'));
  });

  it('disables a rule whose pattern is longer than 200 characters', () => {
    const { rules, problems } = compile([{ match: { name: 'a'.repeat(201) }, tags: ['x'] }]);
    assert.strictEqual(rules.length, 0);
    assert.ok(problems[0].includes('200'));
  });

  it('accepts a pattern of exactly 200 characters', () => {
    const { rules } = compile([{ match: { name: 'a'.repeat(200) }, tags: ['x'] }]);
    assert.strictEqual(rules.length, 1);
  });

  it('turns off rules with an unknown key, no condition, no action or an unknown field', () => {
    const { rules, problems } = compile([
      { match: { colour: 'red' }, tags: ['x'] },
      { match: {}, tags: ['x'] },
      { match: { role: 'qa' } },
      { match: { role: 'qa' }, folder: '{nope}' },
      { match: { ticket: false }, tags: ['x'] },
      { folder: 'x' },
    ]);
    assert.strictEqual(rules.length, 0);
    assert.strictEqual(problems.length, 6);
  });

  it('drops a rule whose match carries a number so it cannot widen', () => {
    const parsed = parseNestConfig('{"rules":[{"match":{"role":"qa","name":5},"tags":["x"]}]}');
    assert.strictEqual(parsed.config.rules.length, 0);
    assert.ok(parsed.problems.some((p) => p.includes('rules[0].match')));
  });
});

describe('matching', () => {
  const rules = compile([
    { match: { role: 'qa' }, tags: ['qa'] },
    { match: { ticket: '^T-1' }, folder: '{ticket}' },
    { match: { name: 'spike', agent: 'Ada' }, tags: ['spike'] },
    { match: { cwd: '/work/*/api' }, tags: ['api'] },
    { match: { ticket: true }, tags: ['ticketed'] },
  ]).rules;

  it('first match wins in file order', () => {
    const s = subject({ role: 'qa', ticket: 'T-100' });
    assert.strictEqual(firstMatch(rules, s, '/h')?.index, 0);
    assert.strictEqual(firstMatch(rules, subject({ ticket: 'T-100' }), '/h')?.index, 1);
    assert.strictEqual(firstMatch(rules, subject({ ticket: 'U-9' }), '/h')?.index, 4);
  });

  it('requires every condition and matches regexes case-insensitively', () => {
    assert.strictEqual(firstMatch(rules, subject({ name: 'SPIKE one', agent: 'ada' }), '/h')?.index, 2);
    assert.strictEqual(firstMatch(rules, subject({ name: 'spike one', agent: 'bob' }), '/h'), null);
  });

  it('matches a cwd glob and expands a leading tilde', () => {
    assert.strictEqual(firstMatch(rules, subject({ cwd: '/work/x/api' }), '/h')?.index, 3);
    const home = compile([{ match: { cwd: '~/proj/*' }, tags: ['p'] }]).rules;
    assert.ok(firstMatch(home, subject({ cwd: '/h/proj/a' }), '/h'));
    assert.strictEqual(firstMatch(home, subject({ cwd: '/h/other/a' }), '/h'), null);
  });

  it('does not match a missing ticket or cwd', () => {
    assert.strictEqual(firstMatch(rules, subject(), '/h'), null);
  });
});

describe('expandFolderTemplate', () => {
  it('expands fleet fields', () => {
    const s = subject({ ticket: 'T-7', role: 'build', agent: 'ada', fleetTitle: 'Fix login', subfolder: 'api-core' });
    assert.deepStrictEqual(expandFolderTemplate('{ticket}', s), { kind: 'path', path: 'T-7' });
    assert.deepStrictEqual(expandFolderTemplate('Work/{ticket} {title}', s), { kind: 'path', path: 'Work/T-7 Fix login' });
    assert.deepStrictEqual(expandFolderTemplate('{agent}-{role}-{subfolder}', s), { kind: 'path', path: 'ada-build-api-core' });
  });

  it('turns slashes inside a value into hyphens so a value adds no level', () => {
    const s = subject({ ticket: 'A/B' });
    assert.deepStrictEqual(expandFolderTemplate('{ticket}', s), { kind: 'path', path: 'A-B' });
  });

  it('reports an empty field', () => {
    assert.deepStrictEqual(expandFolderTemplate('{ticket}', subject()), { kind: 'empty' });
  });

  it('refuses more than two levels', () => {
    assert.deepStrictEqual(expandFolderTemplate('a/b/c', subject()), { kind: 'tooDeep' });
  });

  it('caps each name at the folder name limit and strips control characters', () => {
    const s = subject({ ticket: 'x'.repeat(300) + '\u0007' });
    const r = expandFolderTemplate('{ticket}', s);
    assert.strictEqual(r.kind, 'path');
    if (r.kind === 'path') {
      assert.strictEqual(r.path.length, 200);
    }
  });
});

describe('unsafe regex patterns', () => {
  const bad = ['^(a+)+$', '(a|aa)*b', '.*.*.*.*x', '(a)\\1', '(?=a)b', 'a{1,9}(b){2}', '(?<n>a)', '.*.*.*x', 'a*a*a*b', '[a-z]*[a-z]*[a-z]*\\d', '\\w+\\w+\\w+!', 'a.*b.*c', '^a*a*a*b', 'a*a{0,19}a{0,19}c', '\\w*\\w*\\w*!', '^x|.*.*b'];
  for (const pattern of bad) {
    for (const key of ['name', 'ticket']) {
      it(`rejects match.${key} ${pattern}`, () => {
        const c = compile([{ match: { [key]: pattern }, folder: 'X' }]);
        assert.strictEqual(c.rules.length, 0);
        assert.strictEqual(c.problems.length, 1);
      });
    }
  }
  it('keeps ordinary patterns and bounds the tested text', () => {
    const c = compile([{ match: { name: '^T-\\d+.*(?:build|qa)$' }, folder: 'X' }]);
    assert.strictEqual(c.rules.length, 1);
    assert.ok(firstMatch(c.rules, subject({ name: 'T-12 x build' }), '/h') !== null);
    const slow = compile([{ match: { name: '^a.*b.*c' }, folder: 'X' }]);
    const start = Date.now();
    firstMatch(slow.rules, subject({ name: 'a'.repeat(100000) }), '/h');
    assert.ok(Date.now() - start < 1000);
  });
  it('keeps the worst accepted pattern fast on a hostile subject', () => {
    const c = compile([{ match: { name: '.*a{0,4}b' }, folder: 'X' }]);
    const start = Date.now();
    firstMatch(c.rules, subject({ name: 'a'.repeat(500) }), '/h');
    assert.ok(Date.now() - start < 200);
  });
  it('rejects overlapping quantifiers quickly and matches a long subject fast', () => {
    const start = Date.now();
    const c = compile([{ match: { name: 'a*x' }, folder: 'X' }]);
    firstMatch(c.rules, subject({ name: 'a'.repeat(500) }), '/h');
    assert.ok(Date.now() - start < 500);
  });
});

describe('pattern cost budget and subject cap', () => {
  const accepted = ['^PROJ-\\d+$', '^(?:fix|feat)/', 'ticket-(\\d{3,5})', '.*review.*', 'release.*v\\d+', '.*\\d+.*', '\\b(fix|bug)\\b.*\\d+', '.*a{0,19}a{0,19}b'];
  for (const pattern of accepted) {
    it(`accepts ${pattern}`, () => {
      const c = compile([{ match: { name: pattern }, folder: 'X' }]);
      assert.strictEqual(c.rules.length, 1, c.problems.join('; '));
    });
  }

  it('matches the same names after redundant dot-star is dropped', () => {
    const lead = compile([{ match: { name: '.*review.*' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(lead, subject({ name: 'Code Review now' }), '/h') !== null);
    assert.ok(firstMatch(lead, subject({ name: 'nothing' }), '/h') === null);
    const rel = compile([{ match: { name: 'release.*v\\d+' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(rel, subject({ name: 'release candidate v2' }), '/h') !== null);
    assert.ok(firstMatch(rel, subject({ name: 'release candidate v' }), '/h') === null);
  });

  it('keeps a trailing dot-star that is escaped or follows a dollar anchor', () => {
    const esc = compile([{ match: { name: 'a\\.*' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(esc, subject({ name: 'b' }), '/h') === null);
    assert.ok(firstMatch(esc, subject({ name: 'xa.' }), '/h') !== null);
  });

  it('refuses a cost problem with a hint on how to simplify it', () => {
    const c = compile([{ match: { name: '.*.*.*x' }, folder: 'X' }]);
    assert.strictEqual(c.rules.length, 0);
    assert.ok(/drop a leading or trailing \.\*/.test(c.problems[0]));
  });

  it('refuses seven repeated four-way alternations', () => {
    const c = compile([{ match: { name: '(a|b|c|d)'.repeat(7) }, folder: 'X' }]);
    assert.strictEqual(c.rules.length, 0);
    assert.ok(/alternation/.test(c.problems[0]));
  });

  it('treats ^a|b as unanchored and ^(a|b) as anchored', () => {
    const branch = '(a|b|c|d)'.repeat(6);
    assert.strictEqual(compile([{ match: { name: `^a|${branch}` }, folder: 'X' }]).rules.length, 0);
    assert.strictEqual(compile([{ match: { name: `^${branch}` }, folder: 'X' }]).rules.length, 1);
    const alt = compile([{ match: { name: '^a|b' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(alt, subject({ name: 'xb' }), '/h') !== null);
    assert.ok(firstMatch(alt, subject({ name: 'xa' }), '/h') === null);
    const grouped = compile([{ match: { name: '^(a|b)' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(grouped, subject({ name: 'xb' }), '/h') === null);
  });

  it('keeps every accepted pattern fast on a hostile 64-char subject', () => {
    const hostile = ['a'.repeat(64), 'release'.repeat(9) + 'v', ('fix 1 ').repeat(10) + 'zzzz', '1'.repeat(63) + 'x', 'ab'.repeat(32)];
    for (const pattern of accepted) {
      const c = compile([{ match: { name: pattern }, folder: 'X' }]).rules;
      for (const name of hostile) {
        // Best of three keeps a GC pause from failing the run; real backtracking costs seconds.
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const start = process.hrtime.bigint();
          firstMatch(c, subject({ name }), '/h');
          best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
        }
        assert.ok(best < 50, `${pattern} took ${best} ms`);
      }
    }
  });

  it('tests the last 64 characters when the pattern ends with $ and has no ^', () => {
    const long = 'a'.repeat(63) + 'x' + 'b'.repeat(40);
    const end = compile([{ match: { name: 'x$' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(end, subject({ name: long }), '/h') === null);
    assert.ok(firstMatch(end, subject({ name: 'c'.repeat(100) + 'x' }), '/h') !== null);
  });

  it('reports no match for text over the cap when the pattern has both anchors', () => {
    const both = compile([{ match: { name: '^a.*x$' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(both, subject({ name: 'a' + 'b'.repeat(80) + 'x' }), '/h') === null);
    assert.ok(firstMatch(both, subject({ name: 'abx' }), '/h') !== null);
  });

  it('tests the first 64 characters when the pattern has no $', () => {
    const start = compile([{ match: { name: '^a' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(start, subject({ name: 'a' + 'b'.repeat(100) }), '/h') !== null);
    const tail = compile([{ match: { name: 'zz' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(tail, subject({ name: 'a'.repeat(70) + 'zz' }), '/h') === null);
    assert.ok(firstMatch(tail, subject({ name: 'zz' + 'a'.repeat(70) }), '/h') !== null);
  });

  it('applies the cap to the ticket condition too', () => {
    const t = compile([{ match: { ticket: 'x$' }, folder: 'X' }]).rules;
    assert.ok(firstMatch(t, subject({ ticket: 'a'.repeat(63) + 'x' + 'b'.repeat(40) }), '/h') === null);
  });
});

describe('buildRuleSubjects with backfill entries', () => {
  it('gives a scanned chat joined to a backfill-only fleet record a subject with its fleet fields', () => {
    const entry = {
      sessionId: 'old1',
      name: 'Old build',
      ticket: null,
      role: 'build',
      agent: '',
      cwd: '',
      isBackfill: true,
    } as unknown as FleetEntry;
    const subjects = buildRuleSubjects([{ sessionId: 'old1', title: 'raw', cwd: null }], [entry], null);
    assert.strictEqual(subjects.length, 1);
    assert.strictEqual(subjects[0].role, 'build');
    const plan = planOrganize({
      chats: subjects.map((s) => ({ subject: s, state: free })),
      rules: compile([{ match: { role: 'build' }, folder: 'Old' }]).rules,
      folders: {},
      tags: {},
      applied: {},
      homedir: '/h',
    });
    assert.strictEqual(plan.moves.length, 1);
  });
});

describe('buildRuleSubjects', () => {
  it('joins fleet entries and derives the subfolder', () => {
    const entry = {
      sessionId: 's1',
      name: 'T-9 Build login',
      ticket: 'T-9',
      role: 'build',
      agent: 'ada',
      cwd: '/ws/api/core',
    } as unknown as FleetEntry;
    const subjects = buildRuleSubjects(
      [
        { sessionId: 's1', title: 'raw', cwd: null },
        { sessionId: 's2', title: 'other', cwd: '/ws/web' },
      ],
      [entry],
      '/ws',
    );
    assert.strictEqual(subjects[0].ticket, 'T-9');
    assert.strictEqual(subjects[0].subfolder, 'api-core');
    assert.strictEqual(subjects[0].fleetTitle, 'Build login');
    assert.strictEqual(subjects[0].name, 'T-9 Build login');
    assert.strictEqual(subjects[1].ticket, null);
    assert.strictEqual(subjects[1].name, 'other');
    assert.strictEqual(subjects[1].subfolder, 'web');
    assert.strictEqual(subjects[1].fleetTitle, '');
  });
});

describe('planOrganize', () => {
  const rules = compile([
    { match: { role: 'qa' }, folder: 'QA', tags: ['qa'], pin: true },
    { match: { ticket: true }, folder: '{ticket}' },
  ]).rules;

  const base = (chats: { subject: RuleSubject; state: PlanChatState }[], extra: Partial<Parameters<typeof planOrganize>[0]> = {}) =>
    planOrganize({ chats, folders: {}, tags: {}, rules, applied: {}, homedir: '/h', ...extra });

  it('lists every move, marks folders that do not exist yet and writes nothing', () => {
    const plan = base([
      { subject: subject({ sessionId: 'a', role: 'qa' }), state: free },
      { subject: subject({ sessionId: 'b', ticket: 'T-1' }), state: free },
      { subject: subject({ sessionId: 'c' }), state: free },
    ]);
    assert.strictEqual(plan.matched, 2);
    assert.strictEqual(plan.moves.length, 2);
    assert.deepStrictEqual(plan.moves[0], {
      sessionId: 'a',
      title: 'Chat title',
      fromFolder: null,
      toFolder: 'QA',
      createsFolder: true,
      tagsAdded: ['qa'],
      pin: true,
      ruleIndex: 0,
    });
    assert.strictEqual(plan.moves[1].toFolder, 'T-1');
  });

  it('skips a chat already in place and tags it already carries', () => {
    const folders = { f1: folder('f1', 'QA') };
    const tags = { t1: tag('t1', 'QA') };
    const plan = base([{ subject: subject({ role: 'qa' }), state: { folderId: 'f1', tagIds: ['t1'], starred: true } }], {
      folders,
      tags,
      applied: { 'aaaaaaaa-0001': 'f1' },
    });
    assert.strictEqual(plan.moves.length, 0);
    assert.strictEqual(plan.matched, 1);
  });

  it('never moves or retags a chat filed by hand', () => {
    const folders = { f9: folder('f9', 'Mine') };
    const plan = base([{ subject: subject({ role: 'qa' }), state: { folderId: 'f9', tagIds: [], starred: false } }], { folders });
    assert.strictEqual(plan.moves.length, 0);
    assert.strictEqual(plan.skippedHandFiled, 1);
  });

  it('moves a chat whose folder is the one the last Apply chose', () => {
    const folders = { f1: folder('f1', 'Old') };
    const plan = base([{ subject: subject({ ticket: 'T-5' }), state: { folderId: 'f1', tagIds: [], starred: false } }], {
      folders,
      applied: { 'aaaaaaaa-0001': 'f1' },
    });
    assert.strictEqual(plan.moves.length, 1);
    assert.strictEqual(plan.moves[0].fromFolder, 'Old');
    assert.strictEqual(plan.moves[0].toFolder, 'T-5');
  });

  it('files into an existing sublevel path without creating it', () => {
    const r = compile([{ match: { role: 'qa' }, folder: 'Work/QA' }]).rules;
    const folders = { w: folder('w', 'Work'), q: folder('q', 'QA', 'w') };
    const plan = planOrganize({ chats: [{ subject: subject({ role: 'qa' }), state: free }], folders, tags: {}, rules: r, applied: {}, homedir: '/h' });
    assert.strictEqual(plan.moves[0].createsFolder, false);
    assert.strictEqual(plan.moves[0].toFolder, 'Work/QA');
  });

  it('still applies tags when the folder template is empty for a chat', () => {
    const r = compile([{ match: { name: '.' }, folder: '{ticket}', tags: ['x'] }]).rules;
    const plan = planOrganize({ chats: [{ subject: subject(), state: free }], folders: {}, tags: {}, rules: r, applied: {}, homedir: '/h' });
    assert.strictEqual(plan.moves[0].toFolder, null);
    assert.deepStrictEqual(plan.moves[0].tagsAdded, ['x']);
  });

  it('reports a template that is too deep once', () => {
    const r = compile([{ match: { name: '.' }, folder: 'a/b/c' }]).rules;
    const plan = planOrganize({
      chats: [
        { subject: subject({ sessionId: 'a' }), state: free },
        { subject: subject({ sessionId: 'b' }), state: free },
      ],
      folders: {},
      tags: {},
      rules: r,
      applied: {},
      homedir: '/h',
    });
    assert.strictEqual(plan.moves.length, 0);
    assert.strictEqual(plan.problems.length, 1);
  });
});

describe('planUndo', () => {
  const ledger = (over: Partial<OrganizeLedger> = {}): OrganizeLedger => ({
    at: 1,
    createdFolderIds: ['fNew'],
    createdTagIds: ['tNew'],
    snapshot: {
      a: { folderId: 'fNew', priorFolderId: 'fOld', tagsAdded: ['tNew'], pinned: true },
      b: { folderId: 'fNew', priorFolderId: null, tagsAdded: [], pinned: false },
    },
    applied: { a: 'fNew', b: 'fNew' },
    ...over,
  });
  const folders = { fNew: folder('fNew', 'New'), fOld: folder('fOld', 'Old') };
  const tags = { tNew: tag('tNew', 'new') };

  it('restores the snapshot and removes the empty folder and unused tag Apply created', () => {
    const plan = planUndo(
      ledger(),
      {
        a: { folderId: 'fNew', tagIds: ['tNew'], starred: true },
        b: { folderId: 'fNew', tagIds: [], starred: false },
      },
      folders,
      tags,
    );
    assert.strictEqual(plan.skipped.length, 0);
    const a = plan.actions.find((x) => x.sessionId === 'a');
    assert.strictEqual(a?.folderId, 'fOld');
    assert.deepStrictEqual(a?.removeTagIds, ['tNew']);
    assert.strictEqual(a?.unstar, true);
    assert.strictEqual(plan.actions.find((x) => x.sessionId === 'b')?.folderId, null);
    assert.deepStrictEqual(plan.removeFolderIds, ['fNew']);
    assert.deepStrictEqual(plan.removeTagIds, ['tNew']);
  });

  it('skips a chat the user moved since and keeps the folder that still holds it', () => {
    const plan = planUndo(
      ledger(),
      {
        a: { folderId: 'fOld', tagIds: ['tNew'], starred: true },
        b: { folderId: 'fNew', tagIds: [], starred: false },
      },
      folders,
      tags,
    );
    assert.deepStrictEqual(plan.skipped, ['a']);
    assert.strictEqual(plan.actions.length, 1);
    // Skipped chat a still carries tNew, so the tag stays.
    assert.deepStrictEqual(plan.removeTagIds, []);
  });

  it('keeps a created folder that a chat Undo skipped still uses', () => {
    const plan = planUndo(
      ledger(),
      {
        a: { folderId: 'fNew', tagIds: [], starred: false },
        b: { folderId: 'fNew', tagIds: [], starred: false },
      },
      folders,
      tags,
    );
    // a was unstarred by the user, so it is skipped and keeps fNew.
    assert.deepStrictEqual(plan.skipped, ['a']);
    assert.deepStrictEqual(plan.removeFolderIds, []);
  });

  it('restores to Unsorted when the prior folder is gone', () => {
    const plan = planUndo(ledger(), { a: { folderId: 'fNew', tagIds: [], starred: true } }, { fNew: folder('fNew', 'New') }, tags);
    assert.strictEqual(plan.actions[0].folderId, null);
  });

  it('removes a created sublevel before its parent', () => {
    const l = ledger({
      createdFolderIds: ['p', 'c'],
      createdTagIds: [],
      snapshot: { a: { folderId: 'c', priorFolderId: null, tagsAdded: [], pinned: false } },
      applied: { a: 'c' },
    });
    const plan = planUndo(l, { a: { folderId: 'c', tagIds: [], starred: false } }, { p: folder('p', 'P'), c: folder('c', 'C', 'p') }, {});
    assert.deepStrictEqual(plan.removeFolderIds, ['c', 'p']);
  });

  it('gives back the Apply-made prior folder so later rules can still move the chat', () => {
    const l = ledger({
      createdFolderIds: ['fNew'],
      createdTagIds: [],
      snapshot: { a: { folderId: 'fNew', priorFolderId: 'fOld', tagsAdded: [], pinned: false } },
      applied: { a: 'fNew' },
    });
    const plan = planUndo(l, { a: { folderId: 'fNew', tagIds: [], starred: false } }, folders, {});
    assert.strictEqual(plan.actions[0].appliedFolderId, 'fOld');
    const none = planUndo(ledger(), { b: { folderId: 'fNew', tagIds: [], starred: false } }, folders, tags);
    assert.strictEqual(none.actions[0].appliedFolderId, undefined);
  });
});
