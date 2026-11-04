// Unit tests for the fleet panel view model: stage colors, row labels and the attachable flag.

import * as assert from 'assert';
import { FleetGroup, FleetRow, FleetSections } from '../../fleet/groupModel';
import {
  agentTagKind,
  buildFleetMessage,
  coerceSetActive,
  stageColor,
  stageFamily,
} from '../../views/fleetPanel';

function row(id: string, over: Partial<FleetRow> = {}): FleetRow {
  return {
    id,
    sessionId: id,
    title: `Chat ${id}`,
    timestamp: null,
    status: 'idle',
    attachable: false,
    agentTag: '',
    suffix: '',
    ticket: null,
    children: [],
    ...over,
  };
}

function group(id: string, rows: FleetRow[], over: Partial<FleetGroup> = {}): FleetGroup {
  return {
    id,
    kind: 'ticket',
    label: id,
    ticket: id,
    title: 'A title',
    stage: 'In build',
    rollup: 'working',
    hasLive: true,
    forceOpen: false,
    rows,
    ...over,
  };
}

function sections(over: Partial<FleetSections> = {}): FleetSections {
  return {
    mode: 'tickets',
    active: false,
    orchestrator: null,
    pastOrchestrators: [],
    groups: [],
    userFolders: [],
    unsorted: [],
    archivedCount: 0,
    activeCount: 0,
    queue: [],
    ...over,
  };
}

describe('fleetPanel', () => {
  it('maps stage names to color families', () => {
    assert.strictEqual(stageFamily('UAT failed', ['Done']), 'orange');
    assert.strictEqual(stageFamily('done', ['Done']), 'green');
    assert.strictEqual(stageFamily('Back for UAT', ['Done']), 'teal');
    assert.strictEqual(stageFamily('In build', ['Done']), 'blue');
    assert.strictEqual(stageFamily('', ['Done']), '');
  });

  it('takes a stage color only from a valid hex tag', () => {
    assert.strictEqual(stageColor('in build', { 'In build': '#112233' }), '#112233');
    assert.strictEqual(stageColor('In build', { 'In build': 'red' }), null);
    assert.strictEqual(stageColor('Other', { 'In build': '#112233' }), null);
  });

  it('keeps agent tag colors to a closed set', () => {
    assert.strictEqual(agentTagKind('QA'), 'qa');
    assert.strictEqual(agentTagKind('orchestrator'), 'review');
    assert.strictEqual(agentTagKind('"><x'), 'review');
    assert.strictEqual(agentTagKind(''), '');
  });

  it('carries ARIA levels, positions and labels for every row', () => {
    const parent = row('p', { agentTag: 'fix', suffix: 'round 2', status: 'needs', children: [row('k', { status: 'working' })] });
    const msg = buildFleetMessage(
      sections({
        orchestrator: row('o', { status: 'working' }),
        pastOrchestrators: [row('old')],
        groups: [group('T-1', [parent, row('q')])],
        unsorted: [row('u')],
      }),
    );
    assert.strictEqual(msg.type, 'fleet');
    assert.strictEqual(msg.orchestrator?.ariaLevel, 1);
    assert.strictEqual(msg.orchestrator?.ariaPosInSet, 1);
    assert.strictEqual(msg.orchestrator?.ariaSetSize, 4);
    assert.strictEqual(msg.pastOrchestrators?.ariaPosInSet, 2);
    assert.strictEqual(msg.pastOrchestrators?.rows[0].ariaLevel, 2);
    const g = msg.groups[0];
    assert.strictEqual(g.ariaLevel, 1);
    assert.strictEqual(g.ariaPosInSet, 3);
    assert.strictEqual(g.ariaSetSize, 4);
    assert.deepStrictEqual(
      g.rows.map((r) => [r.sessionId, r.ariaLevel, r.child]),
      [
        ['p', 2, false],
        ['k', 3, true],
        ['q', 2, false],
      ],
    );
    assert.strictEqual(g.rows[0].ariaLabel, 'fix round 2. Needs you.');
    assert.strictEqual(g.rows[0].tagKind, 'fix');
    assert.strictEqual(g.count, 3);
    assert.ok(g.ariaLabel.includes('Stage In build'));
    assert.strictEqual(msg.unsorted?.ariaPosInSet, 4);
    assert.strictEqual(msg.unsorted?.kind, 'unsorted');
  });

  it('counts the queue and keeps file order', () => {
    const msg = buildFleetMessage(
      sections({
        queue: [
          { key: 'A-1', title: 'First', stage: 'To build', live: false },
          { key: 'A-2', title: 'Second', stage: 'UAT failed', live: true },
        ],
        activeCount: 3,
        archivedCount: 2,
      }),
    );
    assert.strictEqual(msg.queueCount, 2);
    assert.strictEqual(msg.activeCount, 3);
    assert.strictEqual(msg.archivedCount, 2);
    assert.deepStrictEqual(
      msg.queue.map((q) => [q.position, q.key, q.stageFamily]),
      [
        [1, 'A-1', 'blue'],
        [2, 'A-2', 'orange'],
      ],
    );
  });

  it('applies layout colors and done stages to pills', () => {
    const msg = buildFleetMessage(sections({ groups: [group('T-1', [], { stage: 'Shipped' })] }), {
      tags: { Shipped: '#00aa00' },
      doneStages: ['Shipped'],
    });
    assert.strictEqual(msg.groups[0].stageFamily, 'green');
    assert.strictEqual(msg.groups[0].stageColor, '#00aa00');
  });

  it('forces Active groups open and passes the flag through', () => {
    const msg = buildFleetMessage(sections({ active: true, groups: [group('T-1', [row('a', { status: 'working' })], { forceOpen: true })] }));
    assert.strictEqual(msg.active, true);
    assert.strictEqual(msg.groups[0].forceOpen, true);
  });

  it('coerces the Active toggle to a strict boolean', () => {
    assert.deepStrictEqual(coerceSetActive({ type: 'setActive', active: true }), { type: 'setActive', active: true });
    assert.strictEqual(coerceSetActive({ type: 'setActive', active: 'true' }), null);
    assert.strictEqual(coerceSetActive({ type: 'setActive' }), null);
    assert.strictEqual(coerceSetActive({ type: 'other', active: true }), null);
  });
});

describe('fleetPanel attachable flag', () => {
  it('passes the attachable flag through to the orchestrator, group rows and children', () => {
    const child = row('c1', { attachable: true });
    const msg = buildFleetMessage(
      sections({
        orchestrator: row('o1', { attachable: true }),
        groups: [group('T-1', [row('r1', { attachable: true, children: [child] }), row('r2')])],
      }),
    );
    assert.strictEqual(msg.orchestrator?.attachable, true);
    assert.deepStrictEqual(
      msg.groups[0].rows.map((r) => [r.sessionId, r.attachable]),
      [
        ['r1', true],
        ['c1', true],
        ['r2', false],
      ],
    );
  });
});
