import * as assert from 'assert';
import { launchNewSession, NEW_SESSION_COMMANDS } from '../../launch/newSessionLauncher';

// Headless unit tests for the vscode-free New session launcher (slice
// s3a-design-shell, issue #80). It imports no vscode module (only an injected
// command runner), so this test never transitively requires vscode (ARCHITECTURE.md
// unit-gate rule). It covers the probed command order, the fallback-on-reject chain,
// and the total-failure signal that drives the host's graceful toast.

describe('newSessionLauncher.NEW_SESSION_COMMANDS', () => {
  it('probes the verified new-chat command first, then the sidebar fallback', () => {
    assert.deepStrictEqual(NEW_SESSION_COMMANDS, [
      'claude-vscode.newConversation',
      'claude-vscode.sidebar.open',
    ]);
  });
});

describe('newSessionLauncher.launchNewSession', () => {
  it('runs the FIRST command and stops (does not fall through) on success', async () => {
    const calls: string[] = [];
    const run = (c: string): unknown => {
      calls.push(c);
      return Promise.resolve();
    };
    const ok = await launchNewSession(run);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls, ['claude-vscode.newConversation'], 'only the first command runs');
  });

  it('falls through to the fallback when the first command rejects', async () => {
    const calls: string[] = [];
    const run = (c: string): unknown => {
      calls.push(c);
      if (c === 'claude-vscode.newConversation') {
        return Promise.reject(new Error('command not found'));
      }
      return Promise.resolve();
    };
    const ok = await launchNewSession(run);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(
      calls,
      ['claude-vscode.newConversation', 'claude-vscode.sidebar.open'],
      'the fallback runs after the first rejects',
    );
  });

  it('returns false when EVERY candidate rejects (drives the graceful toast)', async () => {
    const calls: string[] = [];
    const run = (c: string): unknown => {
      calls.push(c);
      return Promise.reject(new Error('unavailable'));
    };
    const ok = await launchNewSession(run);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(calls, [
      'claude-vscode.newConversation',
      'claude-vscode.sidebar.open',
    ]);
  });

  it('tolerates a runner that throws synchronously (not just a rejected promise)', async () => {
    const run = (c: string): unknown => {
      if (c === 'claude-vscode.newConversation') {
        throw new Error('sync throw');
      }
      return Promise.resolve();
    };
    const ok = await launchNewSession(run);
    assert.strictEqual(ok, true, 'a synchronous throw is caught and the fallback still runs');
  });

  it('returns false for an empty command list without throwing', async () => {
    const ok = await launchNewSession(() => Promise.resolve(), []);
    assert.strictEqual(ok, false);
  });
});
