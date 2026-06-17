import * as assert from 'assert';
import {
  CleanupPeriodRead,
  OutboundMessage,
  SettingsIo,
  handleSettingsMessage,
} from '../../settings/claudeSettingsIO';

// Unit tests for the webview message protocol, driven through a fake messenger
// (an in-memory SettingsIo) with NO vscode and NO real panel and NO filesystem.
// handleSettingsMessage is the pure reducer the webview module wires to
// onDidReceiveMessage; here we feed it inbound messages and assert the outbound
// reply sequence and the write side effects on the fake.

// An in-memory SettingsIo double. read returns the scripted state; write records
// the value, optionally throwing a scripted error (to exercise the chokepoint's
// throw-on-bad-target surfacing through the protocol).
class FakeIo implements SettingsIo {
  public writes: number[] = [];
  public throwOnWrite: Error | null = null;
  constructor(private state: CleanupPeriodRead) {}
  read(): CleanupPeriodRead {
    return this.state;
  }
  write(value: number): void {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(value);
    this.state = { value, usingDefault: false };
  }
}

describe('settings protocol: ready', () => {
  it('replies with the current state when a value is set', () => {
    const io = new FakeIo({ value: 21, usingDefault: false });
    const out = handleSettingsMessage(io, { type: 'ready' });
    assert.deepStrictEqual(out, [
      { type: 'state', value: 21, usingDefault: false, defaultValue: 30 },
    ]);
  });

  it('replies with usingDefault when the key is absent', () => {
    const io = new FakeIo({ value: null, usingDefault: true });
    const out = handleSettingsMessage(io, { type: 'ready' });
    assert.deepStrictEqual(out, [
      { type: 'state', value: null, usingDefault: true, defaultValue: 30 },
    ]);
  });
});

describe('settings protocol: save', () => {
  it('validates, writes through the io, then replies saved + fresh state', () => {
    const io = new FakeIo({ value: null, usingDefault: true });
    const out = handleSettingsMessage(io, { type: 'save', value: '45' });
    assert.deepStrictEqual(io.writes, [45]);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], { type: 'saved', value: 45 });
    assert.deepStrictEqual(out[1], {
      type: 'state',
      value: 45,
      usingDefault: false,
      defaultValue: 30,
    });
  });

  it('replies error and does NOT write on a non-integer', () => {
    const io = new FakeIo({ value: 30, usingDefault: false });
    const out = handleSettingsMessage(io, { type: 'save', value: '30.5' });
    assert.deepStrictEqual(io.writes, []);
    assert.strictEqual(out.length, 1);
    assert.strictEqual((out[0] as { type: string }).type, 'error');
  });

  it('replies error and does NOT write on a negative integer', () => {
    const io = new FakeIo({ value: 30, usingDefault: false });
    const out = handleSettingsMessage(io, { type: 'save', value: '-1' });
    assert.deepStrictEqual(io.writes, []);
    assert.strictEqual((out[0] as { type: string }).type, 'error');
  });

  it('surfaces a write-time error (e.g. chokepoint path assertion) as an error message', () => {
    const io = new FakeIo({ value: 30, usingDefault: false });
    io.throwOnWrite = new Error('Refusing to write outside the one allowed path.');
    const out = handleSettingsMessage(io, { type: 'save', value: '12' });
    assert.strictEqual(out.length, 1);
    const msg = out[0] as Extract<OutboundMessage, { type: 'error' }>;
    assert.strictEqual(msg.type, 'error');
    assert.ok(msg.error.includes('Refusing to write'));
  });
});
