import * as assert from 'assert';
import { Tag } from '../../store/schema';
import {
  UNTAGGED_TAG_ID,
  UNTAGGED_LABEL,
  assembleTagsTree,
  effectiveTagIds,
  isUntagged,
  isUntaggedId,
} from '../../model/untagged';
import { parseTagOccurrenceId } from '../../model/occurrence';

// Unit tests for the Untagged bucket and many-to-many tag-tree assembly: Untagged equals the effective
// empty-tag set (empty or all-dangling), composite ids are unique over a 50x8 set, and each has one owning tag.

function tagsByIdFrom(list: Tag[]): { [id: string]: Tag } {
  const map: { [id: string]: Tag } = {};
  for (const t of list) {
    map[t.id] = t;
  }
  return map;
}

describe('effectiveTagIds / isUntagged (membership == effective empty-tag set)', () => {
  const tags = tagsByIdFrom([
    { id: 't1', label: 'Bug' },
    { id: 't2', label: 'Feature' },
  ]);

  it('keeps only ids that resolve to a real tag, de-duped and order-preserving', () => {
    assert.deepStrictEqual(effectiveTagIds(tags, ['t2', 't1']), ['t2', 't1']);
    assert.deepStrictEqual(effectiveTagIds(tags, ['t1', 't1', 't2']), ['t1', 't2'], 'de-duped');
    assert.deepStrictEqual(effectiveTagIds(tags, ['t1', 'gone', 't2']), ['t1', 't2'], 'dangling dropped');
  });

  it('a chat with an EMPTY stored tag list is Untagged', () => {
    assert.strictEqual(isUntagged(tags, []), true);
    assert.strictEqual(isUntagged(tags, undefined), true);
  });

  it('a chat whose EVERY tag id is dangling is Untagged (effective set empty)', () => {
    // A chat that references only unknown tag ids falls into Untagged, like a dangling folderId into Unfiled.
    assert.strictEqual(isUntagged(tags, ['gone1', 'gone2']), true);
  });

  it('a chat with at least one resolving tag is NOT Untagged', () => {
    assert.strictEqual(isUntagged(tags, ['t1']), false);
    assert.strictEqual(isUntagged(tags, ['gone', 't2']), false, 'one live tag among dangling still tags it');
  });
});

describe('assembleTagsTree (many-to-many membership)', () => {
  const tags = tagsByIdFrom([
    { id: 't1', label: 'Bug' },
    { id: 't2', label: 'Feature' },
    { id: 't3', label: 'Archive' },
  ]);

  it('places a chat once under EACH tag in its effective set (many-to-many)', () => {
    const tree = assembleTagsTree({
      tags,
      chatTags: { c1: ['t1', 't2'], c2: ['t2'], c3: [] },
    });
    const byTag = new Map(tree.tags.map((n) => [n.id, n.occurrences.map((o) => o.chatId)]));
    assert.deepStrictEqual(byTag.get('t1'), ['c1']);
    assert.deepStrictEqual(new Set(byTag.get('t2')), new Set(['c1', 'c2']));
    assert.deepStrictEqual(byTag.get('t3'), []);
    assert.deepStrictEqual(tree.untagged.occurrences.map((o) => o.chatId), ['c3']);
  });

  it('routes a chat with ONLY dangling tag ids to Untagged, not lost and not under a real tag', () => {
    const tree = assembleTagsTree({ tags, chatTags: { c1: ['GONE', 'ALSO-GONE'] } });
    assert.deepStrictEqual(tree.untagged.occurrences.map((o) => o.chatId), ['c1']);
    const underReal = tree.tags.some((n) => n.occurrences.some((o) => o.chatId === 'c1'));
    assert.strictEqual(underReal, false, 'an all-dangling chat must not appear under any real tag');
  });

  it('Untagged is synthetic, last, and carries the sentinel id + label', () => {
    const tree = assembleTagsTree({ tags, chatTags: {} });
    assert.strictEqual(tree.untagged.synthetic, true);
    assert.strictEqual(tree.untagged.id, UNTAGGED_TAG_ID);
    assert.strictEqual(tree.untagged.label, UNTAGGED_LABEL);
    assert.strictEqual(isUntaggedId(UNTAGGED_TAG_ID), true);
    assert.strictEqual(isUntaggedId('t1'), false);
  });

  it('sorts real tags by label, case-insensitively', () => {
    const tree = assembleTagsTree({ tags, chatTags: {} });
    assert.deepStrictEqual(tree.tags.map((n) => n.label), ['Archive', 'Bug', 'Feature']);
  });

  it('an occurrence under each tag resolves to EXACTLY one owning tag (single parent)', () => {
    const tree = assembleTagsTree({ tags, chatTags: { c1: ['t1', 't2'] } });
    // The same chat under t1 and t2 yields two occurrences, each owned by the tag it renders under.
    const all = tree.tags.flatMap((n) => n.occurrences.map((o) => ({ owner: n.id, occ: o })));
    const c1 = all.filter((x) => x.occ.chatId === 'c1');
    assert.strictEqual(c1.length, 2, 'c1 has two occurrences (one per tag)');
    for (const { owner, occ } of c1) {
      const parsed = parseTagOccurrenceId(occ.id);
      assert.ok(parsed);
      assert.strictEqual(parsed.tagId, owner, 'occurrence id parent == its rendering tag (one parent)');
    }
    assert.notStrictEqual(c1[0].owner, c1[1].owner);
  });

  it('keeps the Untagged membership in lockstep with the empty effective set per chat', () => {
    // A chat is in Untagged iff isUntagged() is true.
    const chatTags: { [id: string]: string[] } = {
      a: ['t1'],
      b: [],
      c: ['GONE'],
      d: ['t2', 'GONE'],
      e: [],
    };
    const tree = assembleTagsTree({ tags, chatTags });
    const inUntagged = new Set(tree.untagged.occurrences.map((o) => o.chatId));
    const expected = new Set(
      Object.keys(chatTags).filter((id) => isUntagged(tags, chatTags[id])),
    );
    assert.deepStrictEqual(inUntagged, expected);
    assert.deepStrictEqual(expected, new Set(['b', 'c', 'e']));
  });
});

describe('tree-wide composite-id uniqueness over a 50-by-8 synthetic set', () => {
  it('every occurrence id (real-tag and Untagged) is unique across the whole tree', () => {
    // 50 chats and 8 tags with varying subsets (some empty) give many-to-many membership and a populated Untagged.
    const tags = tagsByIdFrom(
      Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, label: `Tag ${i}` })),
    );
    const chatTags: { [id: string]: string[] } = {};
    for (let c = 0; c < 50; c++) {
      const chatId = `chat-${c}`;
      const assigned: string[] = [];
      if (c % 7 !== 0) {
        for (let t = 0; t < 8; t++) {
          if ((c + t) % 3 === 0) {
            assigned.push(`t${t}`);
          }
        }
      }
      chatTags[chatId] = assigned;
    }

    const tree = assembleTagsTree({ tags, chatTags });

    const ids: string[] = [];
    for (const node of tree.tags) {
      for (const occ of node.occurrences) {
        ids.push(occ.id);
      }
    }
    for (const occ of tree.untagged.occurrences) {
      ids.push(occ.id);
    }

    assert.strictEqual(new Set(ids).size, ids.length, 'a composite occurrence id repeated tree-wide');

    // Every chat is placed at least once.
    const placedChatIds = new Set([
      ...tree.tags.flatMap((n) => n.occurrences.map((o) => o.chatId)),
      ...tree.untagged.occurrences.map((o) => o.chatId),
    ]);
    assert.strictEqual(placedChatIds.size, 50, 'every chat appears somewhere');

    // Each id round-trips to its owning tag and chat, and the owner matches the node it sits under.
    for (const node of [...tree.tags, tree.untagged]) {
      for (const occ of node.occurrences) {
        const parsed = parseTagOccurrenceId(occ.id);
        assert.ok(parsed, `occurrence id did not parse: ${occ.id}`);
        assert.strictEqual(parsed.tagId, node.id);
        assert.strictEqual(parsed.chatId, occ.chatId);
      }
    }

    // A multi-tag chat has several occurrences with distinct ids and one shared chatId.
    const multiTagChat = Object.keys(chatTags).find((id) => chatTags[id].length >= 2);
    assert.ok(multiTagChat, 'the synthetic set should contain a multi-tag chat');
    const occurrencesOfMulti = ids.filter((id) => id.endsWith(':' + multiTagChat));
    assert.strictEqual(
      occurrencesOfMulti.length,
      chatTags[multiTagChat as string].length,
      'a multi-tag chat has one distinct-id occurrence per tag',
    );
  });
});
