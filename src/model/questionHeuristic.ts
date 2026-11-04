// Pure heuristic: does an assistant turn's truncated summary read as a question awaiting
// the user's reply? The text is a bounded snippet, so a question can be cut off before its
// '?' or phrased as a request without one. Biased toward false: a wrongly flagged
// statement shows a badge the user must dismiss, while a missed one still surfaces as unread.

// Trailing characters inspected. Keeps a '?' or request phrase far earlier in a long
// statement from triggering.
const TAIL_WINDOW = 160;

// Input bound enforced here so the function does not depend on the caller truncating.
// Sized with slack over TAIL_WINDOW so trailing wrappers still leave the tail intact.
const MAX_SCAN_WINDOW = 2048;

// Trailing whitespace and wrapper characters to strip. A linear backward scan is required:
// an end-anchored [class]+$ regex backtracks quadratically on long runs (100k chars took 16s).
function isTrailingTrimChar(ch: string): boolean {
  switch (ch) {
    case '"':
    case "'":
    case '`':
    case ')':
    case ']':
    case '*':
    case '_':
    case '>':
      return true;
    default:
      return /\s/u.test(ch);
  }
}

// Request phrases that count without a '?', matched only in the tail window. Each needs a
// second-person or imperative framing, because bare "what is", "how many", "which option"
// or "tell me" also head plain statements ("Here is how many passed.").
const REQUEST_PHRASES: readonly RegExp[] = [
  /\blet me know\b/,
  /\bwould you like\b/,
  /\bdo you want\b/,
  // Only the direct question form, not "I explained which option is best".
  /\bwhich (one|option|approach|of these|[a-z]+) (do|should|would|are|is) you\b/,
  /\bshould i\b/,
  /\bshall i\b/,
  // Direct requests, or a clause-initial "Want me to"; not "I know you want me to finish".
  /\b(do you want|would you like) me to\b/,
  /(^|[.!?;:]\s+|,\s+|\b(?:and|so|but|then|also|now)\s+)want me to\b/,
  // Needs request framing: a bare "confirm the ..." also heads statements.
  /\b(can|could|would|will) you (please )?confirm\b/,
  /\bplease (provide|confirm|share|specify|paste|tell|let)\b/,
  // Clause-initial imperative only; not "the logs tell me the cause".
  /(^|[.!?;:]\s+|,\s+|\b(?:and|so|but|then|also|now)\s+)tell me\b/,
  // Direct second-person questions only; bare "what is" and "how many" match indirect
  // questions inside statements.
  /\bwhat (do|would|should|are|did|can) you\b/,
  /\bhow (do|would|should|are|did|can|many|much) (you|should i|do i|shall i)\b/,
];

// True when the text reads as a question or input request near its end. Null, empty and
// non-prose text return false.
export function asksSomething(text: string | null | undefined): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const bounded = text.length > MAX_SCAN_WINDOW ? text.slice(-MAX_SCAN_WINDOW) : text;
  // Strip trailing wrappers so '...want?"' and '...want?)' still end in '?'.
  let end = bounded.length;
  while (end > 0 && isTrailingTrimChar(bounded.charAt(end - 1))) {
    end--;
  }
  const trimmedEnd = end === bounded.length ? bounded : bounded.slice(0, end);
  if (trimmedEnd.length === 0) {
    return false;
  }

  // A final '?' is the strongest signal.
  if (trimmedEnd.endsWith('?')) {
    return true;
  }

  // Inspect only the tail so an early '?' or phrase in a long statement does not trigger.
  const tail = trimmedEnd.slice(-TAIL_WINDOW).toLowerCase();

  // A '?' in the tail also counts: a truncated snippet can leave prose after the question.
  if (tail.indexOf('?') !== -1) {
    return true;
  }

  // An input request near the end without a '?'.
  for (const phrase of REQUEST_PHRASES) {
    if (phrase.test(tail)) {
      return true;
    }
  }

  return false;
}
