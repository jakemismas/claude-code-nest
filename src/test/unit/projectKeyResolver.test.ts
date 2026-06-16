import * as assert from 'assert';
import {
  encodeProjectKey,
  keysMatch,
  resolveProjectDir,
  ResolveDeps,
} from '../../claude/projectKeyResolver';

// Pure-logic unit tests for the project-key encoder and the tolerant resolver.
// No filesystem and no vscode import; the filesystem is injected via ResolveDeps.

describe('projectKeyResolver.encodeProjectKey (verified exact encoding table)', () => {
  const table: Array<[string, string]> = [
    // The ARCHITECTURE.md canonical example: lowercase the leading drive letter,
    // replace every non-[A-Za-z0-9-] character with one hyphen, preserving
    // existing hyphens. "Code - Nest" -> "Code---Nest".
    [
      'c:\\Users\\JakeMismas\\Documents\\Claude Code - Nest',
      'c--Users-JakeMismas-Documents-Claude-Code---Nest',
    ],
    // Uppercase drive letter is lowercased.
    ['C:\\Users\\JakeMismas', 'c--Users-JakeMismas'],
    // Forward slashes are separators too.
    ['C:/Users/JakeMismas', 'c--Users-JakeMismas'],
    // A dot in a path segment becomes a hyphen.
    [
      'c:\\Users\\JakeMismas\\dart--pricing.sandbox',
      'c--Users-JakeMismas-dart--pricing-sandbox',
    ],
    // Existing double hyphen is preserved, not collapsed.
    ['c:\\a--b', 'c--a--b'],
    // CRITICAL regression guard: a non-separator special character ('+') is also
    // hyphenated. This is the live ground truth on this machine: the workspace
    // "c:\\Users\\JakeMismas\\Notes+ Github" is stored on disk as
    // "c--Users-JakeMismas-Notes--Github" (the '+' AND the trailing space each
    // collapse to a hyphen, producing the double hyphen). A separators-only
    // encoder leaves the '+' intact and breaks chat discovery for this project.
    [
      'c:\\Users\\JakeMismas\\Notes+ Github',
      'c--Users-JakeMismas-Notes--Github',
    ],
    // Other common non-alphanumeric folder characters all hyphenate.
    ['c:\\proj\\a&b(c),d@e!f', 'c--proj-a-b-c--d-e-f'],
    // An apostrophe (e.g. "Jake's Project") hyphenates.
    ["c:\\Users\\Jake's Project", 'c--Users-Jake-s-Project'],
  ];

  for (const [input, expected] of table) {
    it('encodes ' + input, () => {
      assert.strictEqual(encodeProjectKey(input), expected);
    });
  }

  it('lowercases ONLY the leading drive letter, not the rest of the path', () => {
    assert.strictEqual(encodeProjectKey('C:\\Users\\MixedCASE'), 'c--Users-MixedCASE');
  });
});

describe('projectKeyResolver.keysMatch', () => {
  it('matches identical keys', () => {
    assert.strictEqual(keysMatch('c--Users-X', 'c--Users-X'), true);
  });
  it('matches across leading drive-letter casing', () => {
    assert.strictEqual(keysMatch('c--Users-JakeMismas', 'C--Users-JakeMismas'), true);
  });
  it('does not match different paths', () => {
    assert.strictEqual(keysMatch('c--Users-A', 'c--Users-B'), false);
  });
  it('does NOT match a case difference outside the leading drive segment', () => {
    // Tolerating the whole string would wrongly equate these distinct keys.
    assert.strictEqual(keysMatch('c--Users-MyProj', 'c--Users-myproj'), false);
  });
});

describe('projectKeyResolver.resolveProjectDir', () => {
  it('resolves via the exact-encoding direct match', () => {
    const deps: ResolveDeps = {
      listProjectDirs: () => ['c--Users-JakeMismas-Documents-Claude-Code---Nest', 'c--Users-JakeMismas-bbmcp'],
    };
    const dir = resolveProjectDir('c:\\Users\\JakeMismas\\Documents\\Claude Code - Nest', deps);
    assert.strictEqual(dir, 'c--Users-JakeMismas-Documents-Claude-Code---Nest');
  });

  it('resolves a derived lowercase-drive key to an on-disk UPPERCASE-drive dir (casing fork)', () => {
    // Real ground truth: C--Users-JakeMismas exists with an uppercase C, but the
    // encoding rule derives a lowercase c--Users-JakeMismas. Case-insensitive
    // leading-segment match must bridge this.
    const deps: ResolveDeps = {
      listProjectDirs: () => ['C--Users-JakeMismas', 'c--Users-JakeMismas-bbmcp'],
    };
    const dir = resolveProjectDir('C:\\Users\\JakeMismas', deps);
    assert.strictEqual(dir, 'C--Users-JakeMismas');
  });

  it('falls back to the cwd scan with self-verify when no name matches', () => {
    // The directory name is opaque/legacy and does not equal the derived key,
    // but one of its transcripts records a cwd that re-encodes to the derived
    // key. The scan fallback must find it.
    const deps: ResolveDeps = {
      listProjectDirs: () => ['legacy-opaque-dir', 'unrelated-dir'],
      probeCwds: (dir: string) => {
        if (dir === 'legacy-opaque-dir') {
          return ['c:\\Users\\JakeMismas\\Documents\\Claude Code - Nest'];
        }
        return ['c:\\Users\\Someone\\else'];
      },
    };
    const dir = resolveProjectDir('c:\\Users\\JakeMismas\\Documents\\Claude Code - Nest', deps);
    assert.strictEqual(dir, 'legacy-opaque-dir');
  });

  it('scan fallback self-verify also bridges drive-letter casing in the cwd', () => {
    const deps: ResolveDeps = {
      listProjectDirs: () => ['opaque'],
      probeCwds: () => ['C:/Users/JakeMismas/proj'],
    };
    const dir = resolveProjectDir('c:\\Users\\JakeMismas\\proj', deps);
    assert.strictEqual(dir, 'opaque');
  });

  it('returns null when neither direct match nor scan resolves', () => {
    const deps: ResolveDeps = {
      listProjectDirs: () => ['c--Users-Other'],
      probeCwds: () => ['c:\\Users\\Other'],
    };
    assert.strictEqual(resolveProjectDir('c:\\Users\\JakeMismas\\nope', deps), null);
  });

  it('returns null when there are no project dirs at all', () => {
    assert.strictEqual(resolveProjectDir('c:\\Users\\JakeMismas', { listProjectDirs: () => [] }), null);
  });
});
