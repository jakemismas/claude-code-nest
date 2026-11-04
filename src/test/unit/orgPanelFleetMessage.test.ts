import './vscodeStub';

import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrgPanelProvider } = require('../../views/orgPanelWebview') as {
  OrgPanelProvider: new (...args: unknown[]) => {
    resolveWebviewView(view: unknown): void;
    setQueueRows(rows: unknown): void;
  };
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

function setup(): { provider: InstanceType<typeof OrgPanelProvider>; posted: { type: string; active?: boolean; queueCount?: number }[]; send: (m: unknown) => void } {
  const provider = new OrgPanelProvider(
    { fsPath: '/ext', scheme: 'file' },
    undefined,
    inertStore,
    () => undefined,
    {},
    {},
    inertStateStore,
    inertReadState,
    undefined,
  );
  const posted: { type: string; active?: boolean; queueCount?: number }[] = [];
  let handler: ((raw: unknown) => void) | undefined;
  const webview = {
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
  };
  provider.resolveWebviewView({
    webview,
    visible: true,
    onDidChangeVisibility: (): { dispose(): void } => ({ dispose: (): void => undefined }),
    onDidDispose: (): { dispose(): void } => ({ dispose: (): void => undefined }),
  });
  return { provider, posted, send: (m) => handler?.(m) };
}

describe('org panel fleet message', () => {
  it('posts the fleet message on ready', () => {
    const { posted, send } = setup();
    send({ type: 'ready' });
    assert.ok(posted.some((m) => m.type === 'fleet'));
  });

  it('recomputes with the Active projection when the toggle arrives', () => {
    const { posted, send } = setup();
    send({ type: 'ready' });
    send({ type: 'setActive', active: true });
    const fleets = posted.filter((m) => m.type === 'fleet');
    assert.strictEqual(fleets[fleets.length - 1].active, true);
    send({ type: 'setActive', active: false });
    const after = posted.filter((m) => m.type === 'fleet');
    assert.strictEqual(after[after.length - 1].active, false);
  });

  it('ignores a toggle that is not a boolean', () => {
    const { posted, send } = setup();
    send({ type: 'ready' });
    const before = posted.length;
    send({ type: 'setActive', active: 'yes' });
    assert.strictEqual(posted.length, before);
  });

  it('posts again when the queue changes and not when nothing changed', () => {
    const { provider, posted, send } = setup();
    send({ type: 'ready' });
    const count = (): number => posted.filter((m) => m.type === 'fleet').length;
    const n = count();
    provider.setQueueRows([{ key: 'A-1', title: 'T', stage: 'To build' }]);
    assert.strictEqual(count(), n + 1);
    provider.setQueueRows([{ key: 'A-1', title: 'T', stage: 'To build' }]);
    assert.strictEqual(count(), n + 1);
    const last = posted.filter((m) => m.type === 'fleet').pop();
    assert.strictEqual(last?.queueCount, 1);
  });
});
