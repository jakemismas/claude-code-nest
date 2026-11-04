import * as assert from 'assert';
import {
  AttachDeps,
  AttachTerminalOptions,
  NOT_FOUND_WARNING,
  OpenRunningDeps,
  TerminalHandle,
  attachInTerminal,
  attachTerminalOptions,
  openRunningChat,
  terminalName,
} from '../../launch/attachLauncher';

const ID = '3ffbf9b4-9d3a-4c98-8616-10b0bec221e4';
const BAD_IDS = ['', 'abc_xyz', 'a', '../abcdef12', 'abcdef12; rm', 'abcdef12 ', 'g'.repeat(16), 'a'.repeat(65)];

interface Harness {
  deps: OpenRunningDeps;
  created: AttachTerminalOptions[];
  terminals: FakeTerminal[];
  warnings: string[];
  opened: string[];
  offers: string[];
  closeListeners: ((t: TerminalHandle) => void)[];
  disposed: number;
}

class FakeTerminal implements TerminalHandle {
  exitStatus: { code: number | undefined } | undefined;
  shown = 0;
  show(): void {
    this.shown += 1;
  }
}

function harness(over: Partial<OpenRunningDeps> & { pick?: boolean } = {}): Harness {
  const h: Harness = {
    deps: undefined as unknown as OpenRunningDeps,
    created: [],
    terminals: [],
    warnings: [],
    opened: [],
    offers: [],
    closeListeners: [],
    disposed: 0,
  };
  const { pick, ...rest } = over;
  h.deps = {
    createTerminal: (options) => {
      h.created.push(options);
      const t = new FakeTerminal();
      h.terminals.push(t);
      return t;
    },
    onDidCloseTerminal: (listener) => {
      h.closeListeners.push(listener);
      return { dispose: () => void (h.disposed += 1) };
    },
    warn: (m) => void h.warnings.push(m),
    isAttachable: () => true,
    isTrusted: () => true,
    chatName: () => 'Build chat',
    offer: (message, button) => {
      h.offers.push(`${message}|${button}`);
      return Promise.resolve(pick !== false);
    },
    openChat: (id) => void h.opened.push(id),
    ...rest,
  };
  return h;
}

describe('attachLauncher terminal options', () => {
  it('runs the claude binary with the attach verb and the id, never a shell string', () => {
    const o = attachTerminalOptions(ID, 'My chat');
    assert.strictEqual(o.shellPath, 'claude');
    assert.deepStrictEqual([...o.shellArgs], ['attach', ID]);
    assert.strictEqual(o.name, 'My chat');
  });

  it('throws on an id that fails the grammar', () => {
    for (const bad of BAD_IDS) {
      assert.throws(() => attachTerminalOptions(bad, 'x'), /Invalid session id/, bad);
    }
  });

  it('caps the name at 60 characters and strips control characters', () => {
    assert.strictEqual(terminalName('x'.repeat(100)).length, 60);
    assert.strictEqual(terminalName('a\u0007b\nc'), 'a b c');
  });

  it('falls back to a fixed name when the chat name is empty', () => {
    assert.strictEqual(terminalName('  \n '), 'Claude chat');
  });
});

describe('attachLauncher.attachInTerminal', () => {
  it('creates no terminal and warns for an invalid id', () => {
    for (const bad of BAD_IDS) {
      const h = harness();
      assert.strictEqual(attachInTerminal(bad, 'x', h.deps as AttachDeps), false);
      assert.strictEqual(h.created.length, 0);
      assert.strictEqual(h.warnings.length, 1);
    }
  });

  it('creates one terminal and shows it', () => {
    const h = harness();
    assert.strictEqual(attachInTerminal(ID, 'Build chat', h.deps), true);
    assert.strictEqual(h.created.length, 1);
    assert.strictEqual(h.terminals[0].shown, 1);
    assert.strictEqual(h.warnings.length, 0);
  });

  it('warns once, naming claude, when the terminal closes with a non-zero exit code', () => {
    const h = harness();
    attachInTerminal(ID, 'Build chat', h.deps);
    h.terminals[0].exitStatus = { code: 127 };
    h.closeListeners[0](h.terminals[0]);
    h.closeListeners[0](h.terminals[0]);
    assert.deepStrictEqual(h.warnings, [NOT_FOUND_WARNING]);
    assert.ok(NOT_FOUND_WARNING.includes('claude'));
    assert.strictEqual(h.disposed, 1);
  });

  it('does not warn on a clean exit, an unknown exit code or another terminal', () => {
    const h = harness();
    attachInTerminal(ID, 'Build chat', h.deps);
    h.closeListeners[0](new FakeTerminal());
    h.terminals[0].exitStatus = { code: 0 };
    h.closeListeners[0](h.terminals[0]);
    assert.strictEqual(h.warnings.length, 0);
    const g = harness();
    attachInTerminal(ID, 'Build chat', g.deps);
    g.terminals[0].exitStatus = { code: undefined };
    g.closeListeners[0](g.terminals[0]);
    assert.strictEqual(g.warnings.length, 0);
  });
});

describe('attachLauncher.openRunningChat', () => {
  it('offers the button and attaches when it is pressed', async () => {
    const h = harness();
    assert.strictEqual(await openRunningChat(ID, h.deps), 'attached');
    assert.deepStrictEqual(h.offers, ['This chat is running in the background.|Open in terminal']);
    assert.deepStrictEqual([...h.created[0].shellArgs], ['attach', ID]);
    assert.strictEqual(h.opened.length, 0);
  });

  it('attaches without an offer on an explicit menu choice', async () => {
    const h = harness({ pick: false });
    assert.strictEqual(await openRunningChat(ID, h.deps, true), 'attached');
    assert.strictEqual(h.offers.length, 0);
    assert.strictEqual(h.opened.length, 0);
    assert.deepStrictEqual([...h.created[0].shellArgs], ['attach', ID]);
  });

  it('opens through the URI on an explicit choice when untrusted or not attachable', async () => {
    for (const o of [{ isTrusted: () => false }, { isAttachable: () => false }]) {
      const h = harness(o);
      assert.strictEqual(await openRunningChat(ID, h.deps, true), 'opened');
      assert.strictEqual(h.created.length + h.offers.length, 0);
    }
  });

  it('falls back to the URI open when the notification is dismissed', async () => {
    const h = harness({ pick: false });
    assert.strictEqual(await openRunningChat(ID, h.deps), 'opened');
    assert.deepStrictEqual(h.opened, [ID]);
    assert.strictEqual(h.created.length, 0);
  });

  it('opens through the URI without an offer when the chat is not attachable', async () => {
    const h = harness({ isAttachable: () => false });
    assert.strictEqual(await openRunningChat(ID, h.deps), 'opened');
    assert.strictEqual(h.offers.length, 0);
    assert.deepStrictEqual(h.opened, [ID]);
  });

  it('creates no terminal in an untrusted workspace', async () => {
    const h = harness({ isTrusted: () => false });
    assert.strictEqual(await openRunningChat(ID, h.deps), 'opened');
    assert.strictEqual(h.created.length, 0);
    assert.strictEqual(h.offers.length, 0);
  });

  it('refuses an invalid id before any offer, terminal or open', async () => {
    for (const bad of BAD_IDS) {
      const h = harness();
      assert.strictEqual(await openRunningChat(bad, h.deps), 'refused');
      assert.strictEqual(h.created.length + h.offers.length + h.opened.length, 0);
      assert.strictEqual(h.warnings.length, 1);
    }
  });
});
