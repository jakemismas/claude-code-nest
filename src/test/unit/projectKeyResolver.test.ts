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
    // Lowercase the drive letter and turn every non-[A-Za-z0-9-] character into one hyphen.
    [
      'c:\\Users\\User\\Documents\\sample-app',
      'c--Users-User-Documents-sample-app',
    ],
    ['C:\\Users\\User', 'c--Users-User'],
    ['C:/Users/User', 'c--Users-User'],
    [
      'c:\\Users\\User\\demo--pricing.sandbox',
      'c--Users-User-demo--pricing-sandbox',
    ],
    ['c:\\a--b', 'c--a--b'],
    // A non-separator character such as "+" also hyphenates, so "Notes+ Github" becomes "Notes--Github";
    // a separators-only encoder breaks chat discovery for such workspaces.
    [
      'c:\\Users\\User\\Notes+ Github',
      'c--Users-User-Notes--Github',
    ],
    ['c:\\proj\\a&b(c),d@e!f', 'c--proj-a-b-c--d-e-f'],
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
    assert.strictEqual(keysMatch('c--Users-User', 'C--Users-User'), true);
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
      listProjectDirs: () => ['c--Users-User-Documents-sample-app', 'c--Users-User-sample-app'],
    };
    const dir = resolveProjectDir('c:\\Users\\User\\Documents\\sample-app', deps);
    assert.strictEqual(dir, 'c--Users-User-Documents-sample-app');
  });

  it('resolves a derived lowercase-drive key to an on-disk UPPERCASE-drive dir (casing fork)', () => {
    // A legacy directory has an uppercase drive letter; the derived key is lowercase, so matching ignores case.
    const deps: ResolveDeps = {
      listProjectDirs: () => ['C--Users-User', 'c--Users-User-sample-app'],
    };
    const dir = resolveProjectDir('C:\\Users\\User', deps);
    assert.strictEqual(dir, 'C--Users-User');
  });

  it('falls back to the cwd scan with self-verify when no name matches', () => {
    // The directory name is legacy, but a transcript records a cwd that re-encodes to the derived key.
    const deps: ResolveDeps = {
      listProjectDirs: () => ['legacy-opaque-dir', 'unrelated-dir'],
      probeCwds: (dir: string) => {
        if (dir === 'legacy-opaque-dir') {
          return ['c:\\Users\\User\\Documents\\sample-app'];
        }
        return ['c:\\Users\\Someone\\else'];
      },
    };
    const dir = resolveProjectDir('c:\\Users\\User\\Documents\\sample-app', deps);
    assert.strictEqual(dir, 'legacy-opaque-dir');
  });

  it('scan fallback self-verify also bridges drive-letter casing in the cwd', () => {
    const deps: ResolveDeps = {
      listProjectDirs: () => ['opaque'],
      probeCwds: () => ['C:/Users/User/proj'],
    };
    const dir = resolveProjectDir('c:\\Users\\User\\proj', deps);
    assert.strictEqual(dir, 'opaque');
  });

  it('returns null when neither direct match nor scan resolves', () => {
    const deps: ResolveDeps = {
      listProjectDirs: () => ['c--Users-Other'],
      probeCwds: () => ['c:\\Users\\Other'],
    };
    assert.strictEqual(resolveProjectDir('c:\\Users\\User\\nope', deps), null);
  });

  it('returns null when there are no project dirs at all', () => {
    assert.strictEqual(resolveProjectDir('c:\\Users\\User', { listProjectDirs: () => [] }), null);
  });
});
