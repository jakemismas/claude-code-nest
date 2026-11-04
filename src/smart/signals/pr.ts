// PR signal: groups chats by pull request. A chat carries a PR when its transcript had a
// "pr-link" line (prNumber, prUrl, prRepository). Pure, with no vscode or fs dependency.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// The key is "owner/repo#number", derived from the pr-link fields or the url, so a chat with
// only a url and a chat with only repo and number for the same PR share a bucket. A chat
// with no PR signal joins no bucket. Buckets sort by label.
export function prBuckets(rows: SmartSignalsInput[]): SmartBucket[] {
  const byKey = new Map<string, SmartSignalsInput[]>();
  for (const row of rows) {
    const key = prKey(row);
    if (key === null) {
      continue;
    }
    const list = byKey.get(key);
    if (list === undefined) {
      byKey.set(key, [row]);
    } else {
      list.push(row);
    }
  }

  const buckets: SmartBucket[] = [];
  for (const [key, members] of byKey) {
    // The first member by sessionId supplies the label, so it does not depend on scan order.
    const sorted = sortMembersInput(members);
    buckets.push({
      key,
      label: prLabel(sorted[0]),
      memberChatIds: sorted.map((m) => m.sessionId),
    });
  }
  return buckets.sort((a, b) => a.label.localeCompare(b.label));
}

// Matches https://<host>/<owner>/<repo>/pull/<n>, with an optional /files, query or anchor.
// The host is ignored so GitHub Enterprise urls work and the key equals the explicit-field key.
export function parsePrUrl(
  url: string | null,
): { repo: string; number: number } | null {
  if (url === null || url.length === 0) {
    return null;
  }
  const match = url.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
  if (match === null) {
    return null;
  }
  const number = Number(match[2]);
  if (!Number.isInteger(number)) {
    return null;
  }
  return { repo: match[1], number };
}

// Explicit pr-link fields win over the url path. The url stays as a last-resort identity for
// a non-standard url without repo and number.
export function prIdentity(
  row: SmartSignalsInput,
): { repo: string | null; number: number | null; url: string | null } | null {
  const fromUrl = parsePrUrl(row.prUrl);
  const repo =
    row.prRepository !== null && row.prRepository.length > 0
      ? row.prRepository
      : fromUrl?.repo ?? null;
  const number = row.prNumber !== null ? row.prNumber : fromUrl?.number ?? null;
  const url = row.prUrl !== null && row.prUrl.length > 0 ? row.prUrl : null;
  if (repo === null && number === null && url === null) {
    return null;
  }
  return { repo, number, url };
}

// A repo-less number gets its own key and is never merged into a repo's PR with the same
// number, which could be a different PR.
export function prKey(row: SmartSignalsInput): string | null {
  const id = prIdentity(row);
  if (id === null) {
    return null;
  }
  if (id.number !== null) {
    if (id.repo !== null) {
      return 'rn:' + id.repo + '#' + String(id.number);
    }
    return 'n:#' + String(id.number);
  }
  if (id.url !== null) {
    return 'url:' + id.url;
  }
  return null;
}

// Uses the same identity as the key, so url-only and repo+number members of one PR share a label.
export function prLabel(row: SmartSignalsInput): string {
  const id = prIdentity(row);
  if (id !== null && id.number !== null) {
    if (id.repo !== null) {
      return 'PR #' + String(id.number) + ' (' + id.repo + ')';
    }
    return 'PR #' + String(id.number);
  }
  if (id !== null && id.url !== null) {
    return id.url;
  }
  // Unreachable: a bucket member always has a url or a number.
  return 'PR';
}
