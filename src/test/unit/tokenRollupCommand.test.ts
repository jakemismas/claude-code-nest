import * as assert from 'assert';
import { TokenTotals } from '../../model/types';
import { ProjectMeta } from '../../store/schema';
import { TokenRollupDeps, showTokenRollup } from '../../commands/tokenRollupCommand';

// Headless unit tests for the Slice 5 token-rollup command orchestrator. vscode-free:
// it takes injected seams for the snapshot inputs and the document open, so the report
// content is the reducer + renderer output (covered in tokenRollup.test.ts) and this
// test asserts the orchestration: open the report when there is data, surface a notice
// when there is none, and never throw.

const DEVICE = 'dev-rollup-cmd';
const NOW = 1_700_000_000_000;

function tk(total: number): TokenTotals {
  return { input: total, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function meta(): ProjectMeta {
  return {
    schemaVersion: 1,
    folders: { f1: { id: 'f1', name: 'Alpha', parentId: null, order: 0 } },
    tags: {},
    chats: { c1: { folderId: 'f1', tags: [], links: [], updatedAt: NOW, deviceId: DEVICE } },
    updatedAt: NOW,
    deviceId: DEVICE,
  };
}

describe('tokenRollupCommand.showTokenRollup', () => {
  it('opens a report document built from the scanned chats and meta', async () => {
    const opened: string[] = [];
    const infos: string[] = [];
    const deps: TokenRollupDeps = {
      getChatIds: () => ['c1'],
      getTokenTotals: () => new Map([['c1', tk(500)]]),
      getProjectMeta: () => meta(),
      openReport: (content: string) => { opened.push(content); },
      showInfo: (m: string) => { infos.push(m); },
    };
    await showTokenRollup(deps);
    assert.strictEqual(opened.length, 1, 'one report opened');
    assert.ok(opened[0].includes('Alpha'), 'folder bucket label in the report');
    assert.ok(opened[0].includes('500 tokens'), 'the chat total in the report');
    assert.strictEqual(infos.length, 0, 'no empty-state notice when there is data');
  });

  it('surfaces a notice and opens nothing when no project resolves', async () => {
    const opened: string[] = [];
    const infos: string[] = [];
    const deps: TokenRollupDeps = {
      getChatIds: () => ['c1'],
      getTokenTotals: () => new Map(),
      getProjectMeta: () => null,
      openReport: (content: string) => { opened.push(content); },
      showInfo: (m: string) => { infos.push(m); },
    };
    await showTokenRollup(deps);
    assert.strictEqual(opened.length, 0, 'no document opened');
    assert.strictEqual(infos.length, 1, 'a notice instead');
  });

  it('surfaces a notice and opens nothing when there are no scanned chats', async () => {
    const opened: string[] = [];
    const infos: string[] = [];
    const deps: TokenRollupDeps = {
      getChatIds: () => [],
      getTokenTotals: () => new Map(),
      getProjectMeta: () => meta(),
      openReport: (content: string) => { opened.push(content); },
      showInfo: (m: string) => { infos.push(m); },
    };
    await showTokenRollup(deps);
    assert.strictEqual(opened.length, 0);
    assert.strictEqual(infos.length, 1);
  });
});
