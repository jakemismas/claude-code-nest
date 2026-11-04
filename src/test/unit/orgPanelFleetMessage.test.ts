// Unit tests for the org panel fleet and robin messages posted to the webview.
import './vscodeStub';

import * as assert from 'assert';
import { TRANSIENT_MS } from '../../fleet/robinState';

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

type RobinProvider = {
  resolveWebviewView(view: unknown): void;
  setQueueRows(rows: unknown): void;
  setAgentSessions(sessions: unknown): void;
  setLayout(layout: unknown): void;
  setRobinOptions(options: unknown): void;
  disposeRobin(): void;
  refresh(): void;
};

function makeRobinView(visible = true): {
  view: unknown;
  posted: { type: string; state?: string }[];
  dispose: () => void;
  ready: () => void;
} {
  const posted: { type: string; state?: string }[] = [];
  let onDispose: (() => void) | undefined;
  let onMessage: ((raw: unknown) => void) | undefined;
  const view = {
    webview: {
      options: {},
      cspSource: 'x:',
      asWebviewUri: (u: unknown): unknown => u,
      html: '',
      onDidReceiveMessage: (cb: (raw: unknown) => void): { dispose(): void } => {
        onMessage = cb;
        return { dispose: (): void => undefined };
      },
      postMessage: (m: unknown): Thenable<boolean> => {
        posted.push(m as { type: string });
        return Promise.resolve(true);
      },
    },
    visible,
    onDidChangeVisibility: (): { dispose(): void } => ({ dispose: (): void => undefined }),
    onDidDispose: (cb: () => void): { dispose(): void } => {
      onDispose = cb;
      return { dispose: (): void => undefined };
    },
  };
  return { view, posted, dispose: () => onDispose?.(), ready: () => onMessage?.({ type: 'ready' }) };
}

function makeRobinProvider(hatched: { get: () => boolean; set: () => void }): RobinProvider {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EMPTY_FLEET_STATE } = require('../../fleet/types') as { EMPTY_FLEET_STATE: unknown };
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
  ) as unknown as RobinProvider;
  provider.setRobinOptions({ animations: () => true, hatched });
  provider.setLayout({ linkedFolders: [], groupBy: 'auto', fleet: EMPTY_FLEET_STATE });
  provider.setQueueRows([]);
  provider.setAgentSessions([]);
  return provider;
}

// Records the timers the provider arms so a test can see whether the timed step re-arms.
function withRecordedTimers(run: (armed: number[]) => void): void {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const armed: number[] = [];
  const fakes = new Set<unknown>();
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: unknown, ms: number) => {
    armed.push(ms);
    const token = {};
    fakes.add(token);
    return token;
  }) as unknown;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((token: unknown) => {
    if (!fakes.has(token)) {
      realClear(token as NodeJS.Timeout);
    }
  }) as unknown;
  try {
    run(armed);
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
}

describe('org panel robin after the view is resolved again', () => {
  it('re-arms the timed step and posts the robin to a re-resolved view', () => {
    withRecordedTimers((armed) => {
      // An unhatched egg keeps a transient running, so a visible view always has a timed step.
      const provider = makeRobinProvider({ get: () => false, set: () => undefined });
      const first = makeRobinView();
      provider.resolveWebviewView(first.view);
      first.ready();
      assert.ok(first.posted.some((m) => m.type === 'robin'), 'the first view gets the robin');

      first.dispose();
      const before = armed.length;
      const second = makeRobinView();
      provider.resolveWebviewView(second.view);
      second.ready();
      assert.ok(second.posted.some((m) => m.type === 'robin'), 'the second view gets the robin');
      assert.ok(
        armed.slice(before).some((ms) => ms >= 50 && ms <= (TRANSIENT_MS.hatch ?? 0)),
        'the next robin step is scheduled again',
      );
      provider.disposeRobin();
    });
  });

  it('keeps the egg unhatched until a visible panel with animations on is sent it', () => {
    withRecordedTimers(() => {
      let hatched = 0;
      const provider = makeRobinProvider({ get: () => false, set: () => (hatched += 1) });
      const hidden = makeRobinView(false);
      provider.resolveWebviewView(hidden.view);
      hidden.ready();
      assert.strictEqual(hatched, 0, 'a hidden view does not consume the egg');
      const shown = makeRobinView(true);
      provider.resolveWebviewView(shown.view);
      assert.strictEqual(hatched, 0, 'a view that is not ready yet does not consume it');
      assert.strictEqual(shown.posted.filter((m) => m.type === 'robin').length, 0, 'nothing is posted before ready');
      shown.ready();
      assert.strictEqual(hatched, 1, 'a ready visible view does');
      provider.disposeRobin();
    });
  });

  it('stops posting and timing after the robin is disposed', () => {
    withRecordedTimers((armed) => {
      const provider = makeRobinProvider({ get: () => true, set: () => undefined });
      const view = makeRobinView();
      provider.resolveWebviewView(view.view);
      view.ready();
      provider.disposeRobin();
      const posts = view.posted.length;
      const timers = armed.length;
      provider.setQueueRows([{ key: 'A-1', title: 'T', stage: 'To build' }]);
      provider.setAgentSessions([]);
      assert.strictEqual(view.posted.filter((m) => m.type === 'robin').length, view.posted.slice(0, posts).filter((m) => m.type === 'robin').length);
      assert.strictEqual(armed.length, timers);
    });
  });

  it('does not resend an unchanged robin message when the panel refreshes', () => {
    withRecordedTimers(() => {
      const provider = makeRobinProvider({ get: () => true, set: () => undefined });
      const view = makeRobinView();
      provider.resolveWebviewView(view.view);
      view.ready();
      const count = (): number => view.posted.filter((m) => m.type === 'robin').length;
      const before = count();
      assert.ok(before >= 1);
      provider.refresh();
      provider.refresh();
      assert.strictEqual(count(), before);
      provider.disposeRobin();
    });
  });
});
