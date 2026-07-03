import * as assert from 'assert';
import { matchTabLabelToChat, isClaudeChatViewType } from '../../views/tabFocusMatch';

// Headless unit tests for the pure named-tab-focus matcher. No vscode import
// (unit-gate rule). Covers the unique-match rule, the ambiguity refusal, unnamed/empty
// labels, trimming, and the Claude viewType detection.

const RECORDS = [
  { sessionId: 's1', title: 'Refactor auth middleware' },
  { sessionId: 's2', title: 'Rate limiter design' },
  { sessionId: 's3', title: 'Rate limiter design' }, // duplicate title (collision)
];

describe('matchTabLabelToChat', () => {
  it('resolves a label that uniquely matches one chat title', () => {
    assert.strictEqual(matchTabLabelToChat('Refactor auth middleware', RECORDS), 's1');
  });

  it('trims surrounding whitespace before matching', () => {
    assert.strictEqual(matchTabLabelToChat('  Refactor auth middleware  ', RECORDS), 's1');
  });

  it('returns null when the label matches MORE than one chat (ambiguous)', () => {
    assert.strictEqual(matchTabLabelToChat('Rate limiter design', RECORDS), null);
  });

  it('returns null when no chat matches', () => {
    assert.strictEqual(matchTabLabelToChat('Some other tab', RECORDS), null);
  });

  it('returns null for an empty or whitespace-only label (unnamed tab)', () => {
    assert.strictEqual(matchTabLabelToChat('', RECORDS), null);
    assert.strictEqual(matchTabLabelToChat('   ', RECORDS), null);
  });

  it('returns null for a null/undefined label', () => {
    assert.strictEqual(matchTabLabelToChat(null, RECORDS), null);
    assert.strictEqual(matchTabLabelToChat(undefined, RECORDS), null);
  });

  it('returns null against an empty record set', () => {
    assert.strictEqual(matchTabLabelToChat('anything', []), null);
  });
});

describe('isClaudeChatViewType', () => {
  it('matches the bare claudeVSCodePanel id', () => {
    assert.strictEqual(isClaudeChatViewType('claudeVSCodePanel'), true);
  });

  it('matches the Tabs-API prefixed form', () => {
    assert.strictEqual(isClaudeChatViewType('mainThreadWebview-claudeVSCodePanel'), true);
  });

  it('does not match an unrelated viewType', () => {
    assert.strictEqual(isClaudeChatViewType('claudeNest.orgPanel'), false);
    assert.strictEqual(isClaudeChatViewType(null), false);
    assert.strictEqual(isClaudeChatViewType(undefined), false);
  });
});
