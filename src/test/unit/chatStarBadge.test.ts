// vscodeStub MUST be imported first so require('vscode') resolves before the
// provider modules' transitive import of vscode (TreeItem/EventEmitter/ThemeIcon)
// runs under the headless runner.
import './vscodeStub';

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import { FlatProvider, FlatChatItem } from '../../views/flatProvider';
import { FoldersProvider, ChatMemberItem } from '../../views/foldersProvider';
import { TagsProvider, ChatOccurrenceItem } from '../../views/tagsProvider';

// Headless unit tests for the star BADGE on the primary chat surfaces (flat,
// folders, tags). SPRINT-2-PLAN.md:119 manual-smoke lists "star a chat (exempt
// badge)" as a deliverable and extension.ts:653 documents that the curation refresh
// re-renders "the star badge across every chat surface" -- but before this the star
// icon rendered ONLY in the Archive view, so a user starring a chat from Chats /
// Folders / Tags got no feedback there. These tests pin the badge to the SYNCED
// ChatMeta.starred flag on every primary surface: a starred row shows star-full, an
// unstarred row shows the default comment-discussion icon. Runs against scratch
// transcript fixtures (NEVER the real ~/.claude files) plus a real MetadataStore.

const DEVICE = 'dev-starbadge';
const PK = 'c--Users-Tester-starbadge';
const NOW = 1_700_000_000_000;

const STARRED = '11111111-0000-0000-0000-000000000001';
const PLAIN = '22222222-0000-0000-0000-000000000002';

function makeStore(): MetadataStore {
  return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0, now: () => NOW });
}

function iconId(item: { iconPath?: unknown }): string {
  return (item.iconPath as { id: string }).id;
}

describe('star badge on the primary chat surfaces (flat / folders / tags)', () => {
  let root: string;
  const workspacePath = 'c:\\Users\\Tester\\starbadge';

  function writeJsonl(dir: string, name: string, objs: unknown[]): void {
    fs.writeFileSync(path.join(dir, name), objs.map((o) => JSON.stringify(o)).join('\n'), 'utf8');
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-starbadge-'));
    const proj = path.join(root, PK);
    fs.mkdirSync(proj, { recursive: true });
    for (const id of [STARRED, PLAIN]) {
      writeJsonl(proj, id + '.jsonl', [
        { type: 'custom-title', customTitle: 'Chat ' + id.slice(0, 8) },
        { type: 'user', timestamp: '2026-06-15T10:00:00.000Z', cwd: workspacePath, message: { content: 'hi' } },
      ]);
    }
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Seed a store where STARRED is starred and PLAIN is not.
  function seededStore(): MetadataStore {
    const store = makeStore();
    store.setChatStarred(PK, STARRED, true);
    return store;
  }

  it('flat view shows star-full for a starred chat and comment-discussion otherwise', () => {
    const store = seededStore();
    const flat = new FlatProvider(workspacePath, store, { projectsRoot: root });
    const byId = new Map(
      flat.getChildren().map((r: FlatChatItem) => [r.record.sessionId, r]),
    );
    assert.strictEqual(iconId(byId.get(STARRED) as FlatChatItem), 'star-full');
    assert.strictEqual(iconId(byId.get(PLAIN) as FlatChatItem), 'comment-discussion');
  });

  it('folders view shows star-full for a starred chat member and comment-discussion otherwise', () => {
    const store = seededStore();
    const folders = new FoldersProvider(workspacePath, store, { projectsRoot: root });
    // Both chats are unfiled, so they live under the Unfiled bucket (the last root).
    const roots = folders.getChildren();
    const members: ChatMemberItem[] = [];
    for (const node of roots) {
      for (const child of folders.getChildren(node)) {
        if (child instanceof ChatMemberItem) {
          members.push(child);
        }
      }
    }
    const byId = new Map(members.map((m) => [m.record.sessionId, m]));
    assert.ok(byId.has(STARRED) && byId.has(PLAIN), 'both chats render as folder members');
    assert.strictEqual(iconId(byId.get(STARRED) as ChatMemberItem), 'star-full');
    assert.strictEqual(iconId(byId.get(PLAIN) as ChatMemberItem), 'comment-discussion');
  });

  it('tags view shows star-full for a starred chat occurrence and comment-discussion otherwise', () => {
    const store = seededStore();
    const tags = new TagsProvider(workspacePath, store, { projectsRoot: root });
    // No tags assigned, so both chats appear once under the Untagged bucket.
    const tagRows = tags.getChildren();
    const occurrences: ChatOccurrenceItem[] = [];
    for (const node of tagRows) {
      for (const child of tags.getChildren(node)) {
        if (child instanceof ChatOccurrenceItem) {
          occurrences.push(child);
        }
      }
    }
    const byId = new Map(occurrences.map((o) => [o.record.sessionId, o]));
    assert.ok(byId.has(STARRED) && byId.has(PLAIN), 'both chats render as tag occurrences');
    assert.strictEqual(iconId(byId.get(STARRED) as ChatOccurrenceItem), 'star-full');
    assert.strictEqual(iconId(byId.get(PLAIN) as ChatOccurrenceItem), 'comment-discussion');
  });

  it('flipping the star rebuilds the row (memoization reuse key includes starred)', () => {
    const store = seededStore();
    const flat = new FlatProvider(workspacePath, store, { projectsRoot: root });
    const first = new Map(
      flat.getChildren().map((r: FlatChatItem) => [r.record.sessionId, r]),
    );
    assert.strictEqual(iconId(first.get(STARRED) as FlatChatItem), 'star-full');

    // Unstar and refresh: the row must rebuild with the default icon, not reuse the
    // memoized star-full node.
    store.setChatStarred(PK, STARRED, false);
    flat.refresh();
    const second = new Map(
      flat.getChildren().map((r: FlatChatItem) => [r.record.sessionId, r]),
    );
    assert.strictEqual(iconId(second.get(STARRED) as FlatChatItem), 'comment-discussion');
  });
});
