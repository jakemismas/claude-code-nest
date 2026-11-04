import { RollupResult } from './tokenRollup';

// Pure renderer for the token-cost rollup report; returns the plain text the command opens.
// The tag section notes that tag totals can exceed the library total, so it does not read as a bug.

// Render the report: by-folder (a partition) and by-tag (not a partition, with an explicit note).
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
  // A multi-tag chat counts toward every tag, so tag buckets can sum past the library total; say so.
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

// Format with thousands separators; the report shows full integers.
function formatTokens(total: number): string {
  return total.toLocaleString('en-US');
}
