import * as assert from 'assert';
import { asksSomething } from '../../model/questionHeuristic';

// Unit tests for the pure asks-vs-statement heuristic behind the question badge: trailing "?",
// "?" in a truncated tail, input-request phrases, statements that must not flag, and bad input.

describe('questionHeuristic asksSomething: trailing question mark', () => {
  it('flags a plain trailing question mark', () => {
    assert.strictEqual(asksSomething('Which option do you want?'), true);
  });

  it('flags a trailing question mark after whitespace/newline', () => {
    assert.strictEqual(asksSomething('Ready to proceed?  \n'), true);
  });

  it("flags a question mark wrapped by a closing quote, paren, or code fence", () => {
    assert.strictEqual(asksSomething('Did you mean "auth"?"'), true);
    assert.strictEqual(asksSomething('Should I use that (the new path?)'), true);
    assert.strictEqual(asksSomething('Run `npm test`?`'), true);
  });
});

describe('questionHeuristic asksSomething: question mark in the truncated tail', () => {
  it('flags a snippet whose question mark is not the very last char (truncated tail)', () => {
    // A snippet cut after the question still has the "?" within the tail window.
    assert.strictEqual(
      asksSomething('Which of these do you want? I can start on whichever you pick and'),
      true,
    );
  });

  it('does NOT flag a question mark buried far before a long statement tail', () => {
    // An early "?" in a passage that ends as a statement must not trigger.
    const early = 'Is this right? ' + 'x'.repeat(300) + ' and that is the final summary.';
    assert.strictEqual(asksSomething(early), false);
  });
});

describe('questionHeuristic asksSomething: input-request phrases without a question mark', () => {
  it('flags "let me know ..."', () => {
    assert.strictEqual(asksSomething('I can do either. Let me know which you prefer.'), true);
  });

  it('flags "would you like ..." and "do you want ..."', () => {
    assert.strictEqual(asksSomething('Would you like me to continue with the refactor.'), true);
    assert.strictEqual(asksSomething('Do you want the Redis-backed version.'), true);
  });

  it('flags "should I ..." and "want me to ..."', () => {
    assert.strictEqual(asksSomething('Should I apply the migration now.'), true);
    assert.strictEqual(asksSomething('I have a plan. Want me to start on it.'), true);
  });

  it('flags a "please provide/confirm ..." input request', () => {
    assert.strictEqual(asksSomething('To continue, please provide the repo name.'), true);
    assert.strictEqual(asksSomething('Please confirm the target branch before I push.'), true);
  });

  it('flags "tell me ..." near the end', () => {
    assert.strictEqual(asksSomething('Tell me the failing test name and I will look.'), true);
  });

  it('does NOT flag a request phrase buried far before a statement tail', () => {
    const buried = 'Earlier you said let me know later, ' + 'y'.repeat(300) + ' so it is done.';
    assert.strictEqual(asksSomething(buried), false);
  });
});

describe('questionHeuristic asksSomething: statements must not flag (conservative bias)', () => {
  it("does not flag a plain completion statement", () => {
    assert.strictEqual(asksSomething('Done, all tests are green.'), false);
  });

  it('does not flag an ellipsis / mid-work statement', () => {
    assert.strictEqual(asksSomething('Running the build now...'), false);
  });

  it('does not flag a declarative sentence that merely contains "you"', () => {
    assert.strictEqual(asksSomething('I attached req.user before calling next().'), false);
  });

  it('does not flag a declarative "confirm that/the ..." statement', () => {
    // "confirm" heading a statement about what was done is not a request to the user.
    assert.strictEqual(asksSomething('The tests confirm that the change works.'), false);
    assert.strictEqual(asksSomething('I will confirm the target branch before I push it.'), false);
    assert.strictEqual(asksSomething('The logs confirm that it works.'), false);
    assert.strictEqual(asksSomething('I could not confirm whether the file exists.'), false);
  });
});

describe('questionHeuristic asksSomething: request-framed confirm still flags', () => {
  it('flags "can/could/would you (please) confirm ..." as a request', () => {
    assert.strictEqual(asksSomething('Can you confirm the target branch.'), true);
    assert.strictEqual(asksSomething('Could you confirm whether this is right.'), true);
    assert.strictEqual(asksSomething('Would you please confirm the config value.'), true);
  });

  it('still flags a bare "please confirm ..." via the please phrase', () => {
    assert.strictEqual(asksSomething('Before I push, please confirm the branch.'), true);
  });
});

describe('questionHeuristic asksSomething: garbage tolerance', () => {
  it('returns false for null / undefined', () => {
    assert.strictEqual(asksSomething(null), false);
    assert.strictEqual(asksSomething(undefined), false);
  });

  it('returns false for empty or whitespace-only text', () => {
    assert.strictEqual(asksSomething(''), false);
    assert.strictEqual(asksSomething('   \n\t  '), false);
  });

  it('returns false for non-prose punctuation/symbol noise without a question mark', () => {
    assert.strictEqual(asksSomething('```\n{}\n```'), false);
    assert.strictEqual(asksSomething('---***___'), false);
  });

  it('does not throw on a very long string and returns a boolean', () => {
    const huge = 'lorem ipsum '.repeat(5000) + 'final statement.';
    const out = asksSomething(huge);
    assert.strictEqual(typeof out, 'boolean');
    assert.strictEqual(out, false);
  });

  it('returns quickly on the pathological trim shape: a long run of trailing-trim class chars ending in a non-class char', () => {
    // Guards against quadratic backtracking in the trailing trim: a long run of trim characters
    // followed by one other character must stay well under 50ms.
    const pathological = '"'.repeat(100000) + 'a';
    const start = Date.now();
    const out = asksSomething(pathological);
    const elapsed = Date.now() - start;
    assert.strictEqual(typeof out, 'boolean');
    assert.ok(elapsed < 50, 'pathological trim input took ' + elapsed + 'ms (must be < 50ms)');
  });

  it('returns quickly on a long all-trim-class input (whitespace/wrapper run with no anchor break)', () => {
    const allTrim = ' `)"\''.repeat(20000);
    const start = Date.now();
    assert.strictEqual(asksSomething(allTrim), false);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, 'all-trim input took ' + elapsed + 'ms (must be < 50ms)');
  });

  it('still detects a trailing question mark behind a wrapper run within the scan window', () => {
    // The input bound must not break legitimate wrapper trimming.
    assert.strictEqual(asksSomething('Shall I proceed?' + '`'.repeat(500)), true);
  });
});
