import * as assert from 'assert';
import { buildOpenUri, openChat, OpenUri } from '../../launch/uriLauncher';

// Unit tests for the URI launcher with a spy opener; the target is vscode://Anthropic.claude-code/open?session=<sessionId>.

const UUID = '3ffbf9b4-9d3a-4c98-8616-10b0bec221e4';
const BAD_IDS = ['abc_xyz', 'a', 'x', '', 'abcdef12 ', '../abcdef12', 'abcdef12&x=1', 'g'.repeat(16), 'a'.repeat(65)];

describe('uriLauncher.buildOpenUri', () => {
  it('builds the verified scheme, cased authority, path, and session query', () => {
    const uri = buildOpenUri('3ffbf9b4-9d3a-4c98-8616-10b0bec221e4');
    assert.strictEqual(uri.scheme, 'vscode');
    assert.strictEqual(uri.authority, 'Anthropic.claude-code');
    assert.strictEqual(uri.path, '/open');
    assert.strictEqual(uri.query, 'session=3ffbf9b4-9d3a-4c98-8616-10b0bec221e4');
  });

  it('does not lowercase the authority', () => {
    assert.strictEqual(buildOpenUri(UUID).authority, 'Anthropic.claude-code');
    assert.notStrictEqual(buildOpenUri(UUID).authority, 'anthropic.claude-code');
  });

  it('leaves a bare UUID unchanged under standard query encoding', () => {
    // A UUID needs no percent-encoding, so encoded equals raw.
    const id = '00000000-1111-2222-3333-444444444444';
    assert.strictEqual(buildOpenUri(id).query, 'session=' + id);
  });
});

describe('uriLauncher.openChat', () => {
  it('fires the injected openExternal exactly once with the built OpenUri', () => {
    const calls: OpenUri[] = [];
    const spy = (uri: OpenUri): void => {
      calls.push(uri);
    };
    // The caller passes the sessionId already stripped of the .jsonl extension.
    const sessionId = '3ffbf9b4-9d3a-4c98-8616-10b0bec221e4';
    openChat(sessionId, spy);

    assert.strictEqual(calls.length, 1);
    const uri = calls[0];
    assert.strictEqual(uri.scheme, 'vscode');
    assert.strictEqual(uri.authority, 'Anthropic.claude-code');
    assert.strictEqual(uri.path, '/open');
    assert.strictEqual(uri.query, 'session=' + sessionId);
  });

  it('passes through the opener return value (supports a thenable opener)', async () => {
    const spy = (_uri: OpenUri): Promise<boolean> => Promise.resolve(true);
    const result = await (openChat(UUID, spy) as Promise<boolean>);
    assert.strictEqual(result, true);
  });
});

describe('uriLauncher session id grammar', () => {
  it('buildOpenUri throws on an id that fails the session id grammar', () => {
    for (const id of BAD_IDS) {
      assert.throws(() => buildOpenUri(id), id);
    }
  });

  it('openChat never fires the opener for an id that fails the grammar', () => {
    let calls = 0;
    const spy = (_uri: OpenUri): void => {
      calls++;
    };
    for (const id of BAD_IDS) {
      assert.strictEqual(openChat(id, spy), undefined);
    }
    assert.strictEqual(calls, 0);
  });
});
