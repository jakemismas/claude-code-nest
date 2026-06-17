// PR signal: the ONE clean, solid smart-group signal in this data
// (ARCHITECTURE.md "Smart-group signal strength"). A chat carries a PR when its
// transcript had a type "pr-link" line (prNumber + prUrl + prRepository). Chats
// are grouped by their PR identity so every chat that worked the same pull
// request lands in one bucket.
//
// This module is PURE and vscode-free (unit-gate rule): no vscode import, no fs.
// It takes plain SmartSignalsInput rows and returns plain SmartBucket rows; the
// view layer renders them. Mirrors the occurrence.ts-vs-tagsProvider.ts split so
// the signal is unit-tested headless.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// Group chats by PR identity. The bucket KEY is the CANONICAL pull-request
// identity "owner/repo#number" whenever repo and number can be derived from
// EITHER the explicit pr-link fields OR the url (a GitHub PR url encodes
// owner/repo and number in its path), so two chats that worked the SAME PR
// co-locate even when one transcript's pr-link carried a url and the other's
// carried only repo+number. It falls back to "#number" when only a number is
// known and to the raw url when neither repo nor number can be derived. A chat
// with no PR signal at all is omitted (it joins no bucket). The bucket LABEL is
// human-facing: "PR #<number> (<repo>)" when both are known, "PR #<number>" when
// only the number is, or the bare url.
//
// Buckets are returned sorted by label; members within a bucket are sorted
// newest-first by the supplied order (the view passes the scan timestamp).
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
    // The representative for the label is the FIRST member in the deterministic
    // sessionId order, so the label does not depend on scan/insertion order even
    // if two members carrying the same PR key somehow disagree on number/repo.
    const sorted = sortMembersInput(members);
    buckets.push({
      key,
      label: prLabel(sorted[0]),
      memberChatIds: sorted.map((m) => m.sessionId),
    });
  }
  return buckets.sort((a, b) => a.label.localeCompare(b.label));
}

// Parse a GitHub (or GitHub Enterprise) pull-request url into its canonical
// "owner/repo" and number. PR urls are https://<host>/<owner>/<repo>/pull/<n>
// possibly with a trailing /files, ?query, or #anchor. Host-agnostic on purpose:
// the canonical identity is owner/repo#number (what prRepository + prNumber also
// carry), so a url-derived key collides with an explicit-field key for the same
// PR. Returns null when the url is absent or does not match the PR path shape.
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

// The canonical PR identity for a chat: repo + number resolved from the explicit
// pr-link fields FIRST, then from the url path, so a chat whose pr-link carried
// only a url and a chat whose pr-link carried only repo+number for the SAME pull
// request resolve to the SAME identity. url is retained as a last-resort coarse
// identity for a non-standard url that does not expose repo+number. Returns null
// when the chat carries no PR signal at all.
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

// The stable identity key for a chat's PR, or null when the chat has no PR
// signal. The CANONICAL repo#number is preferred (derived from fields or url) so
// the url-only and repo+number forms of one PR co-locate; then a bare #number
// when no repo is derivable (a repo-less number is NOT merged into a specific
// repo's PR of the same number, which could be a different PR); then the raw url
// as a last resort for a non-standard url that exposes no number.
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

// The human-facing label for a PR bucket derived from a representative member.
// Routes through the same canonical identity as the key so a url-only member and
// a repo+number member of one PR render the SAME label. Prefers number+repo, then
// number-only, then the url.
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
  // Unreachable: prBuckets only calls this for a member that produced a key, and
  // a key requires a url or a number. Kept total.
  return 'PR';
}
