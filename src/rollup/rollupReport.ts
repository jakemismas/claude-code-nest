import { RollupResult } from './tokenRollup';

// PURE, vscode-free renderer for the token-cost rollup report (Slice 5). The command
// layer builds the by-folder and by-tag RollupResults from the reducer and hands them
// here; this returns the plain-text report the command opens in a read-only document.
// vscode-free so the headless gate covers the exact wording, including the
// multi-tag-can-exceed-library note that keeps the tag rollup from reading as a bug.

// Render the full rollup report: a by-folder section (a true partition) and a by-tag
// section (intentionally not a partition). The tag section carries the explicit note
// that tokens-by-tag can exceed the library total when chats are multi-tagged.
export function renderRollupReport(byFolder: RollupResult, byTag: RollupResult): string {
  const lines: string[] = [];
  lines.push('Claude Code Nest: token cost rollup');
  lines.push('Tokens only (no USD). Tier-A usage summed per chat.');
  lines.push('');

  lines.push('Library total: ' + formatTokens(byFolder.libraryTokenTotal) + ' tokens across ' +
    byFolder.libraryChatCount + ' chat' + (byFolder.libraryChatCount === 1 ? '' : 's') + '.');
  lines.push('');

  lines.push('By folder (each chat counted once in its single home folder):');
  appendBuckets(lines, byFolder);
  lines.push('');

  lines.push('By tag (each chat counted once per each of its tags):');
  appendBuckets(lines, byTag);
  lines.push('');
  // The intentional non-partition note. A multi-tag chat's tokens add to EVERY one of
  // its tag buckets, so the tag buckets can sum to MORE than the library total. This
  // is by design (a chat's cost is attributable to each of its tags); the note keeps
  // the surface from reading as a double-count bug.
  lines.push(
    'Note: a chat with multiple tags adds its full token total to each of its tag ' +
      'buckets, so the by-tag totals can exceed the library total. That is by design, ' +
      'not a double-count: a chat is counted once per tag.',
  );

  return lines.join('\n').trimEnd() + '\n';
}

function appendBuckets(lines: string[], result: RollupResult): void {
  if (result.buckets.length === 0) {
    lines.push('  (no chats)');
    return;
  }
  for (const bucket of result.buckets) {
    lines.push(
      '  ' +
        bucket.label +
        ': ' +
        formatTokens(bucket.tokenTotal) +
        ' tokens (' +
        bucket.chatCount +
        ' chat' +
        (bucket.chatCount === 1 ? '' : 's') +
        ')',
    );
  }
}

// Format a token count with thousands separators for readability (the report is a
// plain-text document, not a compact badge, so it shows the full integer).
function formatTokens(total: number): string {
  return total.toLocaleString('en-US');
}
