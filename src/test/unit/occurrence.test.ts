import * as assert from 'assert';
import {
  canReuseOccurrenceItem,
  makeOccurrence,
  memoizeById,
  parseTagOccurrenceId,
  tagOccurrenceId,
} from '../../model/occurrence';
import { UNTAGGED_TAG_ID } from '../../model/untagged';
import { isMintableId, mintTagId } from '../../model/idFactory';

// Pure-logic unit tests for the ChatOccurrence wrapper model and its composite-id
// grammar `${tagId}:${chatId}`. No vscode import, no filesystem. These are the
// highest-priority tests for slice 3 (composite-id round-trip and the wrapper's
// single-owning-tag recovery).

describe('tagOccurrenceId / parseTagOccurrenceId (composite-id round-trip)', () => {
  it('builds and round-trips an occurrence id splitting on the first :', () => {
    const id = tagOccurrenceId('tag-1', 'session-uuid-2');
    assert.strictEqual(id, 'tag-1:session-uuid-2');
    assert.deepStrictEqual(parseTagOccurrenceId(id), {
      tagId: 'tag-1',
      chatId: 'session-uuid-2',
    });
  });

  it('round-trips the Untagged bucket occurrence id', () => {
    const id = tagOccurrenceId(UNTAGGED_TAG_ID, 'sess');
    assert.strictEqual(id, '__untagged__:sess');
    assert.deepStrictEqual(parseTagOccurrenceId(id), {
      tagId: UNTAGGED_TAG_ID,
      chatId: 'sess',
    });
  });

  it('returns null for a value that is not a well-formed occurrence id', () => {
    assert.strictEqual(parseTagOccurrenceId('no-separator'), null);
    assert.strictEqual(parseTagOccurrenceId(':leading'), null);
    assert.strictEqual(parseTagOccurrenceId('trailing:'), null);
    assert.strictEqual(parseTagOccurrenceId(''), null);
  });

  it('round-trips for a freshly minted tag id (the production id shape)', () => {
    const tagId = mintTagId();
    assert.ok(isMintableId(tagId), 'a minted tag id must be mintable (separator-free)');
    const chatId = '123e4567-e89b-12d3-a456-426614174000';
    const parsed = parseTagOccurrenceId(tagOccurrenceId(tagId, chatId));
    assert.ok(parsed);
    assert.strictEqual(parsed.tagId, tagId);
    assert.strictEqual(parsed.chatId, chatId);
  });
});

describe('makeOccurrence (the wrapper)', () => {
  it('carries the two ids and the composite id, and dereferences ONE record by chatId', () => {
    // The wrapper holds only ids; it never embeds a ChatRecord, so the SAME chat
    // under two tags yields two wrappers that both point at the one shared record
    // (resolved at the view layer by chatId).
    const a = makeOccurrence('tagA', 'chat1');
    const b = makeOccurrence('tagB', 'chat1');
    assert.strictEqual(a.chatId, 'chat1');
    assert.strictEqual(b.chatId, 'chat1');
    assert.strictEqual(a.id, 'tagA:chat1');
    assert.strictEqual(b.id, 'tagB:chat1');
    // Two distinct occurrences of one chat have DISTINCT ids but the SAME chatId.
    assert.notStrictEqual(a.id, b.id);
  });

  it('getParent recovery: the occurrence id resolves to EXACTLY one owning tag', () => {
    // The single-parent rule (ARCHITECTURE.md line 100) at the model level: parsing
    // the occurrence id yields one tag id, the wrapper's owning tag.
    const occ = makeOccurrence('owning-tag', 'chatX');
    const parsed = parseTagOccurrenceId(occ.id);
    assert.ok(parsed);
    assert.strictEqual(parsed.tagId, occ.tagId, 'parent recovered from id == the wrapper owner');
    assert.strictEqual(parsed.tagId, 'owning-tag');
  });
});

describe('canReuseOccurrenceItem (memoization reuse predicate)', () => {
  it('reuses only when both the shared chat title and timestamp still match', () => {
    const cached = { title: 'A chat', timestamp: 100 };
    assert.strictEqual(canReuseOccurrenceItem(cached, { title: 'A chat', timestamp: 100 }), true);
    assert.strictEqual(
      canReuseOccurrenceItem(cached, { title: 'Retitled', timestamp: 100 }),
      false,
      'a title change must rebuild',
    );
    assert.strictEqual(
      canReuseOccurrenceItem(cached, { title: 'A chat', timestamp: 200 }),
      false,
      'a timestamp change must rebuild',
    );
    assert.strictEqual(
      canReuseOccurrenceItem(undefined, { title: 'A chat', timestamp: 100 }),
      false,
      'no cached object => rebuild',
    );
  });

  it('treats null timestamp as a stable value (null === null is unchanged)', () => {
    const cached = { title: 'No-time chat', timestamp: null };
    assert.strictEqual(canReuseOccurrenceItem(cached, { title: 'No-time chat', timestamp: null }), true);
    assert.strictEqual(
      canReuseOccurrenceItem(cached, { title: 'No-time chat', timestamp: 5 }),
      false,
      'null -> a real timestamp must rebuild',
    );
  });
});

describe('memoizeById (node-object memoization across refreshes)', () => {
  // The PURE core of the provider's *ItemFor. VSCode caches tree elements by
  // OBJECT REFERENCE, so this proves the by-id reuse contract with object
  // identity, headlessly: an unchanged id returns the SAME object across refreshes;
  // a changed id (content drift) returns a fresh object that replaces the cached
  // one; distinct ids never collide. This is the slice-3 "node objects memoized by
  // id" acceptance.
  it('returns the SAME object for an unchanged id across refreshes', () => {
    const cache = new Map<string, { id: string; v: number }>();
    let built = 0;
    const build = () => {
      built++;
      return { id: 'x', v: 1 };
    };
    const first = memoizeById(cache, 'x', () => true, build);
    const second = memoizeById(cache, 'x', (c) => c !== undefined, build);
    assert.strictEqual(first, second, 'an unchanged id must return the identical object');
    assert.strictEqual(built, 1, 'build ran once; the second refresh reused the cache');
  });

  it('rebuilds (new object, replaces cache) when canReuse is false for the id', () => {
    const cache = new Map<string, { id: string; v: number }>();
    const first = memoizeById(cache, 'x', () => true, () => ({ id: 'x', v: 1 }));
    // A content change for the SAME id forces a rebuild; the new object is stored.
    const second = memoizeById(cache, 'x', () => false, () => ({ id: 'x', v: 2 }));
    assert.notStrictEqual(first, second, 'a content change must yield a fresh object');
    assert.strictEqual(cache.get('x'), second, 'the rebuilt object replaces the cached one');
    // And the now-current object is reused on the next unchanged refresh.
    const third = memoizeById(cache, 'x', (c) => c !== undefined, () => ({ id: 'x', v: 3 }));
    assert.strictEqual(third, second, 'after a rebuild the new object is reused while unchanged');
  });

  it('keeps distinct ids on distinct objects (no cross-id collision)', () => {
    const cache = new Map<string, { id: string }>();
    const a = memoizeById(cache, 'a', () => true, () => ({ id: 'a' }));
    const b = memoizeById(cache, 'b', () => true, () => ({ id: 'b' }));
    assert.notStrictEqual(a, b);
    assert.strictEqual(cache.get('a'), a);
    assert.strictEqual(cache.get('b'), b);
  });
});
