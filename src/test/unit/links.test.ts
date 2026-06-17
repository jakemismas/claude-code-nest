import * as assert from 'assert';
import { Link } from '../../store/schema';
import {
  LinkGraphInput,
  MAX_LINK_DEPTH,
  buildLinkForest,
  canExpandChild,
  canReuseLinkedChildItem,
  childrenOf,
  designatedParentOf,
  hasCycleFrom,
  hasLinkedChildren,
  linkedChildId,
  linksFromChats,
  parentSourcesOf,
  parseLinkedChildId,
} from '../../model/links';

// Pure-logic unit tests for the link graph model and its composite-id grammar
// `${parentChatId}>link>${chatId}`. No vscode import, no filesystem (unit-gate
// rule). Covers the slice-5 acceptance: graph build, transitive-cycle and diamond
// detection, parent-child nesting, broken-target handling, the deterministic
// single-parent tie-break, and unique ids.

// Build a links map (source chat id -> Link[]) from a compact spec.
function linksOf(spec: {
  [sourceChatId: string]: { to: string; kind: Link['kind'] }[];
}): { [sourceChatId: string]: Link[] } {
  const out: { [sourceChatId: string]: Link[] } = {};
  for (const [source, list] of Object.entries(spec)) {
    out[source] = list.map((l) => ({ targetChatId: l.to, kind: l.kind }));
  }
  return out;
}

function parentLink(to: string): { to: string; kind: Link['kind'] } {
  return { to, kind: 'parent' };
}

function inputOf(
  links: { [sourceChatId: string]: Link[] },
  known: string[],
): LinkGraphInput {
  return { links, knownChatIds: new Set(known) };
}

describe('linkedChildId / parseLinkedChildId (composite-id round-trip)', () => {
  it('builds and round-trips a linked-child id splitting on the first >', () => {
    const id = linkedChildId('parent-uuid', 'child-uuid');
    assert.strictEqual(id, 'parent-uuid>link>child-uuid');
    assert.deepStrictEqual(parseLinkedChildId(id), {
      parentChatId: 'parent-uuid',
      chatId: 'child-uuid',
    });
  });

  it('round-trips when both ids are real UUID shapes', () => {
    const parent = '123e4567-e89b-12d3-a456-426614174000';
    const child = '00000000-0000-0000-0000-000000000abc';
    const parsed = parseLinkedChildId(linkedChildId(parent, child));
    assert.ok(parsed);
    assert.strictEqual(parsed.parentChatId, parent);
    assert.strictEqual(parsed.chatId, child);
  });

  it('returns null for a value that is not a well-formed linked-child id', () => {
    assert.strictEqual(parseLinkedChildId('no-separator'), null);
    assert.strictEqual(parseLinkedChildId('>link>child'), null, 'empty parent side');
    assert.strictEqual(parseLinkedChildId('parent>link>'), null, 'empty child side');
    assert.strictEqual(parseLinkedChildId('parent>nope>child'), null, 'wrong infix');
    assert.strictEqual(parseLinkedChildId(''), null);
  });
});

describe('parentSourcesOf / designatedParentOf (deterministic single-parent selector)', () => {
  it('collects every source holding a parent link to a child, ignoring self-links and related links', () => {
    const links = linksOf({
      A: [parentLink('X'), { to: 'Y', kind: 'related' }],
      B: [parentLink('X')],
      X: [parentLink('X')], // self-link: ignored
      C: [{ to: 'X', kind: 'related' }], // related: not a parent source
    });
    const sources = parentSourcesOf(links, 'X').sort();
    assert.deepStrictEqual(sources, ['A', 'B']);
  });

  it('picks the lexicographically smallest source chat id as the designated parent (DECISIONS slice-5 tie-break)', () => {
    // X is the target of parent links from C, A, B. The smallest id (A) wins,
    // independent of insertion/iteration order.
    const links = linksOf({
      C: [parentLink('X')],
      A: [parentLink('X')],
      B: [parentLink('X')],
    });
    assert.strictEqual(designatedParentOf(links, 'X'), 'A');
  });

  it('returns null when no parent link points at the child', () => {
    const links = linksOf({ A: [{ to: 'X', kind: 'related' }] });
    assert.strictEqual(designatedParentOf(links, 'X'), null);
  });
});

describe('buildLinkForest (graph build + parent-child nesting)', () => {
  it('nests a child under its single parent at depth 1', () => {
    const forest = buildLinkForest(inputOf(linksOf({ A: [parentLink('B')] }), ['A', 'B']));
    const childrenA = forest.childrenByParent.get('A') ?? [];
    assert.strictEqual(childrenA.length, 1);
    assert.strictEqual(childrenA[0].chatId, 'B');
    assert.strictEqual(childrenA[0].parentChatId, 'A');
    assert.strictEqual(childrenA[0].depth, 1);
    assert.strictEqual(childrenA[0].broken, false);
    assert.strictEqual(childrenA[0].id, 'A>link>B');
    assert.strictEqual(forest.designatedParentByChild.get('B'), 'A');
    assert.strictEqual(hasLinkedChildren(forest, 'A'), true);
    assert.strictEqual(hasLinkedChildren(forest, 'B'), false);
  });

  it('places a child under only ONE designated parent even when several sources link it', () => {
    const forest = buildLinkForest(
      inputOf(linksOf({ B: [parentLink('C')], A: [parentLink('C')] }), ['A', 'B', 'C']),
    );
    // Smallest source A is the parent; B is NOT given C as a child.
    assert.deepStrictEqual(
      (forest.childrenByParent.get('A') ?? []).map((c) => c.chatId),
      ['C'],
    );
    assert.strictEqual((forest.childrenByParent.get('B') ?? []).length, 0);
    assert.strictEqual(forest.designatedParentByChild.get('C'), 'A');
  });

  it('sorts a parent\'s children by child chat id for a stable order', () => {
    const forest = buildLinkForest(
      inputOf(linksOf({ A: [parentLink('Z'), parentLink('M'), parentLink('B')] }), [
        'A',
        'B',
        'M',
        'Z',
      ]),
    );
    assert.deepStrictEqual(
      (forest.childrenByParent.get('A') ?? []).map((c) => c.chatId),
      ['B', 'M', 'Z'],
    );
  });
});

describe('broken-target handling', () => {
  it('marks a child whose target is not a known chat as broken', () => {
    const forest = buildLinkForest(inputOf(linksOf({ A: [parentLink('GONE')] }), ['A']));
    const child = (forest.childrenByParent.get('A') ?? [])[0];
    assert.ok(child);
    assert.strictEqual(child.broken, true);
    // A broken child is never expandable (its record is unknown -> leaf).
    assert.strictEqual(canExpandChild(child, new Set(['A'])), false);
  });

  it('a present target is not broken and is expandable when it has its own children', () => {
    const forest = buildLinkForest(
      inputOf(linksOf({ A: [parentLink('B')], B: [parentLink('C')] }), ['A', 'B', 'C']),
    );
    const b = (forest.childrenByParent.get('A') ?? [])[0];
    assert.strictEqual(b.broken, false);
    assert.strictEqual(canExpandChild(b, new Set(['A'])), true);
  });
});

describe('childrenOf (visited-set traversal: transitive cycles and diamonds)', () => {
  it('renders a deep chain via repeated childrenOf calls (A -> B -> C)', () => {
    const forest = buildLinkForest(
      inputOf(linksOf({ A: [parentLink('B')], B: [parentLink('C')] }), ['A', 'B', 'C']),
    );
    const fromA = childrenOf(forest, 'A', new Set(['A']), 0);
    assert.deepStrictEqual(fromA.map((c) => c.chatId), ['B']);
    assert.strictEqual(fromA[0].depth, 1);
    const fromB = childrenOf(forest, 'B', new Set(['A', 'B']), 1);
    assert.deepStrictEqual(fromB.map((c) => c.chatId), ['C']);
    assert.strictEqual(fromB[0].depth, 2);
  });

  it('blocks a TRANSITIVE cycle: A -> B -> C -> A prunes A on the path', () => {
    const forest = buildLinkForest(
      inputOf(
        linksOf({ A: [parentLink('B')], B: [parentLink('C')], C: [parentLink('A')] }),
        ['A', 'B', 'C'],
      ),
    );
    // Walk down to C, carrying the path; C's child A is already on the path and is
    // pruned, so the traversal terminates rather than looping.
    const fromC = childrenOf(forest, 'C', new Set(['A', 'B', 'C']), 2);
    assert.deepStrictEqual(fromC.map((c) => c.chatId), [], 'A is on the path -> pruned');
    // hasCycleFrom reports the cycle from any node on it.
    assert.strictEqual(hasCycleFrom(forest, 'A'), true);
    assert.strictEqual(hasCycleFrom(forest, 'B'), true);
  });

  it('handles a DIAMOND without duplicating or looping (A->B, A->C, B->D, C->D)', () => {
    // D has two parent links (from B and C); the designated parent is the smaller
    // (B), so D nests under B, NOT under C. The diamond collapses to a single
    // nesting path A->B->D, and C has no child D.
    const forest = buildLinkForest(
      inputOf(
        linksOf({
          A: [parentLink('B'), parentLink('C')],
          B: [parentLink('D')],
          C: [parentLink('D')],
        }),
        ['A', 'B', 'C', 'D'],
      ),
    );
    assert.strictEqual(forest.designatedParentByChild.get('D'), 'B', 'smaller source B owns D');
    assert.deepStrictEqual(
      (forest.childrenByParent.get('B') ?? []).map((c) => c.chatId),
      ['D'],
    );
    assert.deepStrictEqual(
      (forest.childrenByParent.get('C') ?? []).map((c) => c.chatId),
      [],
      'C does not also get D (single designated parent)',
    );
    // No cycle in a diamond.
    assert.strictEqual(hasCycleFrom(forest, 'A'), false);
  });

  it('caps depth: childrenOf returns nothing once the next depth exceeds MAX_LINK_DEPTH', () => {
    const forest = buildLinkForest(inputOf(linksOf({ A: [parentLink('B')] }), ['A', 'B']));
    // Simulate being at the cap: currentDepth == MAX_LINK_DEPTH means nextDepth
    // would exceed the cap, so no children are returned regardless of the forest.
    const atCap = childrenOf(forest, 'A', new Set(['A']), MAX_LINK_DEPTH);
    assert.deepStrictEqual(atCap, []);
    // One below the cap still returns the child.
    const belowCap = childrenOf(forest, 'A', new Set(['A']), MAX_LINK_DEPTH - 1);
    assert.deepStrictEqual(belowCap.map((c) => c.chatId), ['B']);
  });

  it('a self-cycle (A -> A) never nests A under itself', () => {
    const forest = buildLinkForest(inputOf(linksOf({ A: [parentLink('A')] }), ['A']));
    assert.strictEqual((forest.childrenByParent.get('A') ?? []).length, 0);
    assert.strictEqual(forest.designatedParentByChild.has('A'), false);
  });
});

describe('unique ids when a chat is both a folder member and a linked child', () => {
  it('the linked-child composite id differs from the folder-member composite id for the SAME chat', () => {
    // A chat B is homed in folder F (folder-member id `F#B`) AND linked under chat A
    // (linked-child id `A>link>B`). The two on-screen occurrences carry DISTINCT
    // tree-wide ids, so VSCode never collapses them, and both dereference the one
    // shared record.
    const folderMemberId = 'F' + '#' + 'B'; // chatNodeId grammar (folderTree.ts)
    const linkedId = linkedChildId('A', 'B');
    assert.notStrictEqual(folderMemberId, linkedId);
    assert.strictEqual(linkedId, 'A>link>B');
    // The linked-child id parses back to its parent CHAT (A), not a folder.
    const parsed = parseLinkedChildId(linkedId);
    assert.ok(parsed);
    assert.strictEqual(parsed.parentChatId, 'A');
    assert.strictEqual(parsed.chatId, 'B');
  });
});

describe('canReuseLinkedChildItem (memoization reuse predicate)', () => {
  it('reuses only when title, timestamp, AND broken state all match', () => {
    const cached = { title: 'Child', timestamp: 100, broken: false };
    assert.strictEqual(
      canReuseLinkedChildItem(cached, { title: 'Child', timestamp: 100, broken: false }),
      true,
    );
    assert.strictEqual(
      canReuseLinkedChildItem(cached, { title: 'Renamed', timestamp: 100, broken: false }),
      false,
      'a title change must rebuild',
    );
    assert.strictEqual(
      canReuseLinkedChildItem(cached, { title: 'Child', timestamp: 200, broken: false }),
      false,
      'a timestamp change must rebuild',
    );
    assert.strictEqual(
      canReuseLinkedChildItem(cached, { title: 'Child', timestamp: 100, broken: true }),
      false,
      'a broken-state flip must rebuild',
    );
    assert.strictEqual(
      canReuseLinkedChildItem(undefined, { title: 'Child', timestamp: 100, broken: false }),
      false,
      'no cached object => rebuild',
    );
  });

  it('treats a broken child (null title/timestamp) as stable across refreshes', () => {
    const cached = { title: null, timestamp: null, broken: true };
    assert.strictEqual(
      canReuseLinkedChildItem(cached, { title: null, timestamp: null, broken: true }),
      true,
    );
    // The target comes back (broken -> false, gains a title): must rebuild.
    assert.strictEqual(
      canReuseLinkedChildItem(cached, { title: 'Back', timestamp: 5, broken: false }),
      false,
    );
  });
});

describe('linksFromChats (chats-map projection)', () => {
  it('projects only chats that have links, preserving their link lists', () => {
    const projected = linksFromChats({
      A: { folderId: null, tags: [], links: [{ targetChatId: 'B', kind: 'parent' }], updatedAt: 1, deviceId: 'd' },
      B: { folderId: null, tags: [], links: [], updatedAt: 1, deviceId: 'd' },
    });
    assert.deepStrictEqual(Object.keys(projected), ['A']);
    assert.deepStrictEqual(projected.A, [{ targetChatId: 'B', kind: 'parent' }]);
  });
});
