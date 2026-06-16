import * as assert from 'assert';
import { buildOpenUri, openChat, OpenUri } from '../../launch/uriLauncher';

// Pure-logic unit tests for the URI launcher. The opener is injected as a spy;
// no vscode import. Asserts the verified target
// vscode://Anthropic.claude-code/open?session=<sessionId>.

describe('uriLauncher.buildOpenUri', () => {
  it('builds the verified scheme, cased authority, path, and session query', () => {
    const uri = buildOpenUri('3ffbf9b4-9d3a-4c98-8616-10b0bec221e4');
    assert.strictEqual(uri.scheme, 'vscode');
    assert.strictEqual(uri.authority, 'Anthropic.claude-code');
    assert.strictEqual(uri.path, '/open');
    assert.strictEqual(uri.query, 'session=3ffbf9b4-9d3a-4c98-8616-10b0bec221e4');
  });

  it('does not lowercase the authority', () => {
    assert.strictEqual(buildOpenUri('x').authority, 'Anthropic.claude-code');
    assert.notStrictEqual(buildOpenUri('x').authority, 'anthropic.claude-code');
  });

  it('leaves a bare UUID unchanged under standard query encoding', () => {
    // A UUID has no characters that require percent-encoding, so the encoded
    // form equals the raw form.
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
    // The sessionId is the .jsonl filename with the extension stripped; the
    // caller passes that stripped UUID directly.
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
    const result = await (openChat('x', spy) as Promise<boolean>);
    assert.strictEqual(result, true);
  });
});
