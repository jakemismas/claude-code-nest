// asksSomething: the PURE, vscode-free heuristic that decides whether an assistant
// turn's (truncated) tier-A text reads as a question awaiting the user's reply. It
// backs the org panel's status: 'question' badge and the Questions section
// (UI-SPEC.md line 51: an unread assistant turn "whose text asks something (question
// mark or input request near the end)"; design README line 43).
//
// It imports no vscode types and touches no filesystem (ARCHITECTURE.md unit-gate
// rule), so it stays in the headless unit suite. It replaces the inline
// endsWithQuestion in orgPanelModel.ts, which matched ONLY a trailing '?'.
//
// Why more than a trailing '?': the input is the tier-A lastMessageText, a BOUNDED,
// often TRUNCATED reduction (the reader caps snippet length), so a genuine question
// can be cut off before its '?' or an assistant can request input in prose without a
// '?', e.g. "Let me know which option you want" or "Tell me the repo name and I'll
// continue." Matching only a trailing '?' misses both. The AC's clause is "question
// mark OR input request near the end of the turn", so this looks at a TAIL WINDOW.
//
// The design bias is conservative toward NOT flagging: a false 'question' turns a
// plain assistant statement into a blinking badge and a Questions-section entry the
// user must dismiss, which is more annoying than a missed one (that shows as the
// 'done' unread dot instead, still surfacing the chat). So statement-shaped tails
// (a period/ellipsis end with no '?' and no request phrase) return false.

// How many trailing characters of the (already truncated) text form the tail window
// the heuristic inspects. Large enough to hold a final sentence or two of a typical
// snippet, small enough that a '?' or request phrase far earlier in a long statement
// does not trigger. The whole text is used when it is shorter than this.
const TAIL_WINDOW = 160;

// The hard input bound THIS function enforces on itself before any scanning. The
// production caller passes a snippet the jsonl reader truncates to 200 chars, but
// that cap lives in a DIFFERENT module; a pure text heuristic must not depend on a
// remote caller-side constant for its own safety (a future "run it on the full
// body" caller is a one-line change away). Everything the heuristic decides from
// lives in the tail, so slicing to a bounded window loses nothing for a
// well-formed snippet; a pathological input (e.g. 100k quote characters) simply
// trims to empty inside the window and returns false, which matches the
// conservative bias. Sized with generous slack over TAIL_WINDOW so a long run of
// trailing wrappers/whitespace before the real tail still leaves the tail intact.
const MAX_SCAN_WINDOW = 2048;

// The trailing characters the end-trim strips: whitespace plus the common trailing
// wrappers (closing quote, paren, bracket, code-fence backtick, emphasis marks).
// Checked per character by a LINEAR backward scan, NOT an end-anchored [class]+$
// regex: that regex shape backtracks quadratically on a long run of class
// characters (measured: 100k chars = 16s), so the trim must stay O(n).
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
      // All Unicode whitespace (matches the old /\s/ class semantics).
      return /\s/u.test(ch);
  }
}

// Input-request phrases that signal the assistant is asking the user to supply
// something or decide, even without a '?'. Matched case-insensitively as whole-ish
// fragments anywhere in the TAIL window (not the whole text), so a request phrase in
// the middle of a long explanatory statement does not trigger; it must be near the
// end. Kept deliberately tight (high-precision) to avoid flagging statements: e.g.
// "let me know" is a request, but a bare "know" is not.
//
// Every phrase here MUST carry a request framing on its own, because this list is
// the ONLY path to a true result when the tail holds no '?' (a genuine question
// almost always carries a '?', caught above). An interrogative WORD alone is not a
// request: "what is", "how many", "which option", and "tell me" all head ordinary
// DECLARATIVE tails just as often as questions ("Let me explain what is wrong.",
// "Here is how many passed.", "I explained which option is best.", "The logs tell
// me the cause."). The module's conservative bias (header) says those statement-
// shaped tails MUST return false, so each entry below requires a second-person or
// imperative framing (an inverted "... do/should/would you ...", a clause-initial
// imperative "tell me ...", a "do you want me to ...") rather than the bare word.
const REQUEST_PHRASES: readonly RegExp[] = [
  /\blet me know\b/,
  /\bwould you like\b/,
  /\bdo you want\b/,
  // "which ..." only as a direct question to the user (inverted second person:
  // "which option do/should/would you ...", "which of these would you ..."), not the
  // declarative "I explained which option is best" / "this shows which approach
  // failed", which the conservative bias must NOT flag.
  /\bwhich (one|option|approach|of these|[a-z]+) (do|should|would|are|is) you\b/,
  /\bshould i\b/,
  /\bshall i\b/,
  // "want me to ..." as a request to act: either the explicit "do you want me to
  // ..." / "would you like me to ...", or the clause-initial elided imperative
  // "Want me to ..." (start of tail or after a sentence break / "and/so"). NOT the
  // declarative "I know you want me to finish", where a subject precedes "want".
  /\b(do you want|would you like) me to\b/,
  /(^|[.!?;:]\s+|,\s+|\b(?:and|so|but|then|also|now)\s+)want me to\b/,
  // A request to confirm, not a statement about confirming. Requires a request
  // framing ("can/could/would/will you confirm ...") because a bare "confirm the/
  // that/whether ..." also heads a DECLARATIVE tail ("I will confirm the branch",
  // "the tests confirm that it works"), which the conservative bias must NOT flag.
  // "please confirm ..." is covered by the please(...) phrase below.
  /\b(can|could|would|will) you (please )?confirm\b/,
  /\bplease (provide|confirm|share|specify|paste|tell|let)\b/,
  // "tell me ..." only as a clause-initial IMPERATIVE (start of tail, after a
  // sentence break, or after "and/so"), not the declarative "the logs tell me the
  // cause" / "these results tell me it works", where a subject precedes "tell".
  /(^|[.!?;:]\s+|,\s+|\b(?:and|so|but|then|also|now)\s+)tell me\b/,
  // "what/how ..." only as a direct question to the user (inverted second person:
  // "what do you ...", "how would you ..."). The bare "what is"/"how many"
  // interrogatives were REMOVED: they match indirect-question tails embedded in
  // plain statements ("explain what is happening", "here is how many passed") that
  // the conservative bias must NOT flag, and any GENUINE such question carries a '?'
  // (caught above) or a "tell me"/"let me know" cue (caught by those phrases).
  /\bwhat (do|would|should|are|did|can) you\b/,
  /\bhow (do|would|should|are|did|can|many|much) (you|should i|do i|shall i)\b/,
];

// Whether the assistant turn's tier-A text reads as a question / input request near
// its end. Total and null-safe: null, empty, or whitespace-only text is not a
// question; a garbage/non-prose tail simply fails the phrase and '?' checks and
// returns false rather than throwing.
export function asksSomething(text: string | null | undefined): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  // Enforce the function's OWN input bound before any scanning (never rely on a
  // caller-side truncation constant in another module). Only the tail matters.
  const bounded = text.length > MAX_SCAN_WINDOW ? text.slice(-MAX_SCAN_WINDOW) : text;
  // Normalize trailing whitespace and common trailing wrappers (a closing quote,
  // paren, bracket, or code-fence backticks) so a question that ends '...want?"' or
  // '...want?)' or '...continue?`' still reads as ending in '?'. Linear backward
  // character scan (see isTrailingTrimChar): the previous end-anchored [class]+$
  // regex backtracked quadratically on a run of class characters.
  let end = bounded.length;
  while (end > 0 && isTrailingTrimChar(bounded.charAt(end - 1))) {
    end--;
  }
  const trimmedEnd = end === bounded.length ? bounded : bounded.slice(0, end);
  if (trimmedEnd.length === 0) {
    return false;
  }

  // A '?' as the last meaningful character is the strongest signal.
  if (trimmedEnd.endsWith('?')) {
    return true;
  }

  // Otherwise inspect only the TAIL window (the last sentence or two) so a '?' or a
  // request phrase buried early in a long statement does not trigger a false badge.
  const tail = trimmedEnd.slice(-TAIL_WINDOW).toLowerCase();

  // A '?' anywhere in the tail window (a truncated snippet can cut off after the
  // question mark, leaving trailing prose, or hold a mid-tail question).
  if (tail.indexOf('?') !== -1) {
    return true;
  }

  // An explicit input-request phrase near the end, covering the AC's "input request
  // near the end" clause where the assistant asks for something without a '?'.
  for (const phrase of REQUEST_PHRASES) {
    if (phrase.test(tail)) {
      return true;
    }
  }

  return false;
}
