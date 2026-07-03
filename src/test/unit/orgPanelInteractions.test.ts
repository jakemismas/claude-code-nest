import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  DOUBLE_CLICK_MS,
  TRANSIENT_OVERLAY_KEYS,
  clearFolderToggleArm,
  newFolderClickState,
  registerFolderClick,
  registerFolderDblClick,
  normalizeQuery,
  isFreshSearchReply,
  joinTextHits,
  JoinRow,
} from '../../views/orgPanelInteractions';

// Headless unit tests for the PURE org-panel interaction kernels (issue #82 AC2
// click/dblclick arbitration, and the cross-surface re-render overlay-teardown
// contract). Imports no vscode types, so it never transitively requires the vscode
// module (ARCHITECTURE.md unit-gate rule). The webview (media/orgPanel.js) mirrors
// this logic; these tests pin the semantics the DOM wiring must match.

describe('TRANSIENT_OVERLAY_KEYS (overlays a tree re-render must tear down)', () => {
  it('names exactly the three body-level fixed overlays, so the re-render and Escape close-sets cannot drift', () => {
    // The webview closeAllTransientOverlays() closes the color picker, the new-folder
    // popover, and the folder actions menu. If a fourth body-level overlay is added,
    // this list and the webview closer must both grow; the test guards the count.
    assert.deepStrictEqual(
      [...TRANSIENT_OVERLAY_KEYS].sort(),
      ['colorPicker', 'folderMenu', 'newFolderPopover'],
    );
  });
});

describe('folder-row single- vs double-click arbitration', () => {
  it('a lone click arms a deferred toggle for that folder (no immediate toggle)', () => {
    const state = newFolderClickState();
    const d = registerFolderClick(state, 'F', 1000);
    assert.strictEqual(d.armToggleFolderId, 'F', 'the click arms a deferred toggle');
    assert.strictEqual(d.cancelPending, false, 'nothing was armed before, so nothing to cancel');
    assert.strictEqual(state.armedFolderId, 'F');
  });

  it('a fast second click on the SAME folder cancels the toggle (dblclick owns it)', () => {
    const state = newFolderClickState();
    registerFolderClick(state, 'F', 1000);
    const second = registerFolderClick(state, 'F', 1000 + DOUBLE_CLICK_MS - 1);
    assert.strictEqual(second.armToggleFolderId, null, 'the second fast click arms NO toggle');
    assert.strictEqual(second.cancelPending, true, 'the second fast click cancels the armed toggle');
    assert.strictEqual(state.armedFolderId, null, 'the arm is cleared for the imminent dblclick');
  });

  it('a dblclick after the same-folder pair opens rename and toggles nothing', () => {
    const state = newFolderClickState();
    registerFolderClick(state, 'F', 1000);
    registerFolderClick(state, 'F', 1010);
    const db = registerFolderDblClick(state);
    assert.deepStrictEqual(db, { cancelToggle: true, openRename: true });
    assert.strictEqual(state.armedFolderId, null);
  });

  it('two clicks spaced BEYOND the window each arm a toggle (two deliberate single clicks)', () => {
    const state = newFolderClickState();
    const first = registerFolderClick(state, 'F', 1000);
    assert.strictEqual(first.armToggleFolderId, 'F');
    // The first toggle would have fired via the timer before this second click; the
    // webview clears the arm when the timer fires. Model that by clearing here.
    clearFolderToggleArm(state);
    const second = registerFolderClick(state, 'F', 1000 + DOUBLE_CLICK_MS + 5);
    assert.strictEqual(second.armToggleFolderId, 'F', 'a click past the window re-arms');
    assert.strictEqual(second.cancelPending, false);
  });

  it('a fast click on a DIFFERENT folder is not a double-click: it cancels the stale arm and arms the new folder', () => {
    const state = newFolderClickState();
    registerFolderClick(state, 'A', 1000);
    const onB = registerFolderClick(state, 'B', 1000 + 10);
    assert.strictEqual(onB.armToggleFolderId, 'B', 'clicking B arms B, not a dblclick of A or B');
    assert.strictEqual(onB.cancelPending, true, 'the stale A arm is cancelled');
    assert.strictEqual(state.armedFolderId, 'B');
  });

  it('clearFolderToggleArm drops any pending arm (re-render / Escape / chevron abort)', () => {
    const state = newFolderClickState();
    registerFolderClick(state, 'F', 1000);
    clearFolderToggleArm(state);
    assert.strictEqual(state.armedFolderId, null);
    assert.strictEqual(state.lastClickAt, null);
    // After a clear, the next click arms cleanly with nothing to cancel.
    const next = registerFolderClick(state, 'F', 1000 + 5);
    assert.strictEqual(next.armToggleFolderId, 'F');
    assert.strictEqual(next.cancelPending, false);
  });
});

describe('content-search query normalization (normalizeQuery)', () => {
  it('trims and lowercases a string query', () => {
    assert.strictEqual(normalizeQuery('  Redis  '), 'redis');
    assert.strictEqual(normalizeQuery('CLAUDE'), 'claude');
  });

  it('maps a non-string (undefined/null/number) to the empty string', () => {
    assert.strictEqual(normalizeQuery(undefined), '');
    assert.strictEqual(normalizeQuery(null), '');
    assert.strictEqual(normalizeQuery(42 as unknown as string), '');
  });

  it('is idempotent (normalizing an already-normalized query is a no-op)', () => {
    const once = normalizeQuery('  Mixed Case  ');
    assert.strictEqual(normalizeQuery(once), once);
  });
});

describe('content-search reply freshness (isFreshSearchReply)', () => {
  it('trusts a reply whose normalized query equals the current filter', () => {
    assert.strictEqual(isFreshSearchReply('Redis', 'redis'), true);
    assert.strictEqual(isFreshSearchReply('  redis ', 'redis'), true);
  });

  it('drops a reply for a superseded (different) query', () => {
    // The user typed on: the box now holds "redisx" but a reply for "redis" lands.
    assert.strictEqual(isFreshSearchReply('redis', 'redisx'), false);
  });

  it('trusts nothing when the box is empty (a cleared filter accepts no late reply)', () => {
    assert.strictEqual(isFreshSearchReply('redis', ''), false);
    assert.strictEqual(isFreshSearchReply('', ''), false);
  });

  it('matches the normalize contract on the reply side (host echoes a raw trimmed query)', () => {
    // The host echoes its RAW trimmed query; the client stored a normalized filter.
    // Freshness must hold across the case/space difference.
    assert.strictEqual(isFreshSearchReply('Rate Limiter', normalizeQuery('  rate limiter ')), true);
  });
});

describe('host-hit x client-tag join (joinTextHits) — AC #3/#4 membership + order', () => {
  interface R extends JoinRow {
    sessionId: string;
    tagIds?: string[];
    timestamp: number;
    title: string;
  }
  const rows: Record<string, R> = {
    a: { sessionId: 'a', tagIds: ['t1'], timestamp: 30, title: 'Alpha' },
    b: { sessionId: 'b', tagIds: ['t2'], timestamp: 20, title: 'Bravo' },
    c: { sessionId: 'c', tagIds: ['t1', 't2'], timestamp: 10, title: 'Charlie' },
  };
  const rowOf = (id: string): R | undefined => rows[id];
  const matchAll = (): boolean => true;
  // A sort stand-in mirroring the panel's "newest first" (timestamp desc).
  const byNewest = (rs: R[]): R[] => rs.slice().sort((x, y) => y.timestamp - x.timestamp);
  const identity = (rs: R[]): R[] => rs;

  it('membership is the host order intersected with rows that resolve and pass the tag filter', () => {
    const order = ['a', 'missing', 'b', 'c'];
    const passesT1 = (r: R): boolean => (r.tagIds ?? []).indexOf('t1') !== -1;
    const res = joinTextHits<R>({
      order,
      snippetOf: () => null,
      rowOf,
      rowMatches: passesT1,
      sortRows: identity,
    });
    // "missing" has no row; b fails the t1 tag filter; a and c pass.
    assert.deepStrictEqual(res.rows.map((r) => r.sessionId), ['a', 'c']);
  });

  it('host rank decides membership but the panel SORT decides order', () => {
    // Host order is a,b,c; a newest-first sort must reorder by timestamp desc.
    const res = joinTextHits<R>({
      order: ['c', 'b', 'a'],
      snippetOf: () => null,
      rowOf,
      rowMatches: matchAll,
      sortRows: byNewest,
    });
    assert.deepStrictEqual(
      res.rows.map((r) => r.sessionId),
      ['a', 'b', 'c'],
      'order follows the sort (timestamp desc), not the host rank',
    );
  });

  it('dedupes a repeated id in the host order (first occurrence wins)', () => {
    const res = joinTextHits<R>({
      order: ['a', 'a', 'b', 'a'],
      snippetOf: () => null,
      rowOf,
      rowMatches: matchAll,
      sortRows: identity,
    });
    assert.deepStrictEqual(res.rows.map((r) => r.sessionId), ['a', 'b']);
  });

  it('collects a non-empty snippet per id and omits empty/absent ones', () => {
    const snips: Record<string, string | null> = { a: 'Claude: hello', b: '', c: null };
    const res = joinTextHits<R>({
      order: ['a', 'b', 'c'],
      snippetOf: (id) => snips[id],
      rowOf,
      rowMatches: matchAll,
      sortRows: identity,
    });
    assert.strictEqual(res.snippets.get('a'), 'Claude: hello');
    assert.strictEqual(res.snippets.has('b'), false, 'an empty snippet is not stored');
    assert.strictEqual(res.snippets.has('c'), false, 'an absent snippet is not stored');
  });

  it('an empty host order yields no rows and no snippets', () => {
    const res = joinTextHits<R>({
      order: [],
      snippetOf: () => 'x',
      rowOf,
      rowMatches: matchAll,
      sortRows: identity,
    });
    assert.strictEqual(res.rows.length, 0);
    assert.strictEqual(res.snippets.size, 0);
  });

  it('does not mutate the input rows (snippet override is applied by the caller, not here)', () => {
    const before = JSON.stringify(rows.a);
    joinTextHits<R>({
      order: ['a'],
      snippetOf: () => 'Claude: hi',
      rowOf,
      rowMatches: matchAll,
      sortRows: identity,
    });
    assert.strictEqual(JSON.stringify(rows.a), before, 'the source row object is untouched');
  });
});

// The overlay-teardown / deferred-toggle correctness fix lives in the webview
// (media/orgPanel.js), which the headless suite cannot import (it needs a DOM and the
// vscode webview bridge). These structural guards read the shipped source and pin the
// invariants the fix established, so a later edit that reintroduces the orphaned-
// overlay, dropped-rename, or un-aborted-toggle class fails here. Same read-the-source
// technique as commandSurfaces.test.ts.
describe('org panel webview re-render teardown wiring (media/orgPanel.js)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const webviewSrc = fs.readFileSync(
    path.join(repoRoot, 'media', 'orgPanel.js'),
    'utf8',
  );

  // Return the exact body of a top-level webview function by brace matching from its
  // signature. These functions contain no braces inside string literals, so a plain
  // depth counter extracts the body faithfully.
  function fnBody(name: string): string {
    const sig = 'function ' + name + '(';
    const start = webviewSrc.indexOf(sig);
    assert.ok(start >= 0, name + '() is defined in media/orgPanel.js');
    const open = webviewSrc.indexOf('{', start);
    let depth = 0;
    for (let k = open; k < webviewSrc.length; k++) {
      const c = webviewSrc[k];
      if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          return webviewSrc.slice(start, k + 1);
        }
      }
    }
    throw new Error('unbalanced braces after ' + name + '()');
  }

  it('render() commits the rename, drops the armed toggle, and closes overlays BEFORE clearing listEl', () => {
    const body = fnBody('render');
    const clearAt = body.indexOf("listEl.textContent = ''");
    assert.ok(clearAt >= 0, 'render() clears listEl');
    const beforeClear = body.slice(0, clearAt);
    for (const call of [
      'commitPendingRename()',
      'cancelPendingFolderToggle()',
      'closeAllTransientOverlays()',
    ]) {
      assert.ok(
        beforeClear.includes(call),
        'render() must call ' + call + ' before it clears listEl',
      );
    }
  });

  it('render() is the SOLE site that clears listEl, so no re-render path can bypass the teardown', () => {
    // Count only real statements, not the string as it appears inside explanatory
    // comments (drop whole-line // comments before matching).
    const code = webviewSrc
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const clears = code.match(/listEl\.textContent\s*=\s*''/g) || [];
    assert.strictEqual(
      clears.length,
      1,
      "exactly one listEl.textContent = '' (inside render()); a new clear elsewhere would re-open the orphan gap",
    );
  });

  it('every overlay opener aborts the armed folder-collapse toggle', () => {
    for (const opener of [
      'openFolderMenu',
      'beginColor',
      'openNewFolderPopover',
      'beginRename',
    ]) {
      assert.ok(
        fnBody(opener).includes('cancelPendingFolderToggle()'),
        opener + '() must call cancelPendingFolderToggle() so an armed collapse cannot fire under the overlay it opens',
      );
    }
  });

  it('the Escape handler that closes overlays also aborts the armed toggle', () => {
    // Brace-match each `if (e.key === 'Escape') { ... }` block (comment length inside
    // the block is then irrelevant) and assert the one that closes overlays also
    // cancels the armed toggle. The kernel documents Escape as an abort trigger.
    const marker = "if (e.key === 'Escape') {";
    let idx = webviewSrc.indexOf(marker);
    let found = false;
    while (idx >= 0) {
      const open = webviewSrc.indexOf('{', idx);
      let depth = 0;
      let end = -1;
      for (let k = open; k < webviewSrc.length; k++) {
        if (webviewSrc[k] === '{') {
          depth++;
        } else if (webviewSrc[k] === '}') {
          depth--;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }
      const block = webviewSrc.slice(idx, end + 1);
      if (block.includes('closeAllTransientOverlays()')) {
        assert.ok(
          block.includes('cancelPendingFolderToggle()'),
          'the overlay-dismiss Escape handler must also cancel the armed toggle',
        );
        found = true;
      }
      idx = webviewSrc.indexOf(marker, idx + 1);
    }
    assert.ok(found, 'found the overlay-dismiss Escape handler');
  });

  it('the webview DOUBLE_CLICK_MS literal matches the kernel constant (no silent drift)', () => {
    const m = webviewSrc.match(/DOUBLE_CLICK_MS\s*=\s*(\d+)/);
    assert.ok(m, 'media/orgPanel.js declares a DOUBLE_CLICK_MS literal');
    assert.strictEqual(
      Number(m![1]),
      DOUBLE_CLICK_MS,
      'the webview DOUBLE_CLICK_MS mirror must equal the kernel export',
    );
  });

  // The content-search join/freshness logic is mirrored from the kernel
  // (orgPanelInteractions.ts normalizeQuery / isFreshSearchReply / joinTextHits) so
  // it can be unit-tested. These parity guards pin that the webview DECLARES those
  // mirrors and USES them at the load-bearing call sites, so a later edit that
  // re-inlines the raw trim/lowercase or the join loop (reintroducing the stale-reply
  // and membership-drift class the kernel tests cover) fails here.
  it('declares the three content-search mirrors (normalizeQuery, isFreshSearchReply, joinTextHits)', () => {
    for (const fn of ['normalizeQuery', 'isFreshSearchReply', 'joinTextHits']) {
      assert.ok(
        webviewSrc.includes('function ' + fn + '('),
        'media/orgPanel.js must declare the ' + fn + ' mirror of the kernel',
      );
    }
  });

  it('onFilterInput normalizes the query through normalizeQuery (not an inline trim/lowercase)', () => {
    const body = fnBody('onFilterInput');
    assert.ok(
      body.includes('normalizeQuery(filterEl.value)'),
      'onFilterInput must set textFilter via normalizeQuery so it cannot drift from the reply compare',
    );
    assert.ok(
      !/filterEl\.value\.trim\(\)\.toLowerCase\(\)/.test(body),
      'onFilterInput must not re-inline trim().toLowerCase()',
    );
  });

  it('the searchResults handler drops a stale reply via isFreshSearchReply', () => {
    // Isolate the inbound searchResults branch and assert it gates on the freshness
    // mirror rather than an inline query comparison.
    const marker = "msg.type === 'searchResults'";
    const at = webviewSrc.indexOf(marker);
    assert.ok(at >= 0, 'the searchResults branch exists');
    const region = webviewSrc.slice(at, at + 1200);
    assert.ok(
      region.includes('normalizeQuery(msg.query)'),
      'the reply query is normalized through the shared mirror',
    );
    assert.ok(
      region.includes('isFreshSearchReply('),
      'the reply is dropped unless isFreshSearchReply says it is current',
    );
  });

  it('haveFreshTextResults delegates to isFreshSearchReply (single freshness rule)', () => {
    const body = fnBody('haveFreshTextResults');
    assert.ok(
      body.includes('isFreshSearchReply(searchResultsQuery, textFilter)'),
      'render-side freshness must reuse the same rule as the inbound-message side',
    );
  });

  it('renderFiltered builds the text results through joinTextHits', () => {
    const body = fnBody('renderFiltered');
    assert.ok(
      body.includes('joinTextHits('),
      'the host-hit x client-tag join must go through the shared joinTextHits mirror',
    );
    assert.ok(
      body.includes('haveFreshTextResults()'),
      'renderFiltered still gates the join on a fresh host reply',
    );
  });

  it('the empty-query reset clears the stale host results before re-rendering', () => {
    // Pin the AC #4 clear path: emptying the box drops the prior host hit set at once
    // so the sectioned view returns without a flash of stale results.
    const body = fnBody('onFilterInput');
    const clearAt = body.indexOf('textFilter.length === 0');
    assert.ok(clearAt >= 0, 'onFilterInput has an empty-query branch');
    const branch = body.slice(clearAt, clearAt + 400);
    for (const stmt of ['searchResultsQuery = null', 'searchHitOrder = []', 'searchHitSnippets = new Map()']) {
      assert.ok(branch.includes(stmt), 'the empty-query reset must run: ' + stmt);
    }
  });
});
