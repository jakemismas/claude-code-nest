import './vscodeStub';

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrgPanelProvider, buildVisibilityMessage } = require('../../views/orgPanelWebview') as {
  OrgPanelProvider: new (...args: unknown[]) => { resolveWebviewView(view: unknown): void };
  buildVisibilityMessage: (visible: boolean) => { type: string; visible: boolean };
};

const inertStore = {
  getProjectMeta: (): unknown => ({ folders: {}, tags: {}, chats: {} }),
  flush: (): Promise<void> => Promise.resolve(),
};
const inertStateStore = { get: (): string | undefined => undefined, set: (): void => undefined };
const inertReadState = {
  getMap: (): Map<string, number> => new Map(),
  markSeen: (): void => undefined,
  seedIfFirstRun: (): boolean => false,
};

function setup() {
  const provider = new OrgPanelProvider(
    { fsPath: '/ext', scheme: 'file' }, undefined, inertStore, () => undefined, {}, {}, inertStateStore, inertReadState, undefined,
  );
  const posted: { type: string; visible?: boolean }[] = [];
  let handler: ((raw: unknown) => void) | undefined;
  let onVisibility: (() => void) | undefined;
  const view = {
    visible: true,
    webview: {
      options: {},
      cspSource: 'x:',
      asWebviewUri: (u: unknown): unknown => u,
      html: '',
      onDidReceiveMessage: (cb: (raw: unknown) => void): { dispose(): void } => {
        handler = cb;
        return { dispose: (): void => undefined };
      },
      postMessage: (m: unknown): Thenable<boolean> => {
        posted.push(m as { type: string });
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: (cb: () => void): { dispose(): void } => {
      onVisibility = cb;
      return { dispose: (): void => undefined };
    },
    onDidDispose: (): { dispose(): void } => ({ dispose: (): void => undefined }),
  };
  provider.resolveWebviewView(view);
  return {
    posted,
    send: (m: unknown) => handler?.(m),
    setVisible: (v: boolean) => {
      view.visible = v;
      onVisibility?.();
    },
  };
}

const visibility = (posted: { type: string; visible?: boolean }[]) => posted.filter((m) => m.type === 'visibility');

describe('org panel visibility message', () => {
  it('builds a boolean-only message', () => {
    assert.deepStrictEqual(buildVisibilityMessage(false), { type: 'visibility', visible: false });
    assert.deepStrictEqual(buildVisibilityMessage(true), { type: 'visibility', visible: true });
  });

  it('posts the state once on ready and again on every visibility change', () => {
    const { posted, send, setVisible } = setup();
    assert.strictEqual(visibility(posted).length, 0);
    send({ type: 'ready' });
    assert.deepStrictEqual(visibility(posted), [{ type: 'visibility', visible: true }]);
    setVisible(false);
    setVisible(true);
    assert.deepStrictEqual(
      visibility(posted).map((m) => m.visible),
      [true, false, true],
    );
  });
});

describe('webview visibility handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'orgPanel.js'), 'utf8');

  it('dispatches visibility messages and stops robin timers while hidden', () => {
    assert.ok(source.includes("msg.type === 'visibility'"));
    assert.ok(/typeof msg\.visible !== 'boolean'/.test(source));
    assert.ok(/document\.hidden \|\| robinPanelHidden\) \{\s*return;/.test(source));
  });

  it('pauses and resumes the running animations', () => {
    assert.ok(source.includes('getAnimations({ subtree: true })'));
    assert.ok(source.includes('a.pause()'));
    assert.ok(source.includes('a.play()'));
  });
});
