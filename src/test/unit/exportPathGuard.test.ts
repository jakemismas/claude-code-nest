import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  ExportPathError,
  assertNotUnderClaudeProjects,
  claudeProjectsRoot,
  isUnderClaudeProjects,
} from '../../store/exportPathGuard';

// Pure-logic unit tests for the export-write path guard (the read-only invariant's
// export half). No vscode, no filesystem. The guard rejects any write target that
// is the ~/.claude/projects/ root or under it, so a save dialog pointed there can
// never overwrite a Claude transcript.
//
// NOTE: claudeProjectsRoot()/isUnderClaudeProjects() read os.homedir() LIVE, and a
// sibling test (claudeSettingsIO) reassigns the home dir env for its own fixtures
// within the same mocha process. So every test reads the root FRESH (never captured
// at module load) to stay consistent with the guard's call-time homedir.

describe('exportPathGuard.isUnderClaudeProjects', () => {
  it('rejects the ~/.claude/projects root itself', () => {
    assert.strictEqual(isUnderClaudeProjects(claudeProjectsRoot()), true);
  });

  it('rejects a transcript path under an encoded project dir', () => {
    const transcript = path.join(
      claudeProjectsRoot(),
      'c--Users-Someone-proj',
      'abc-123.jsonl',
    );
    assert.strictEqual(isUnderClaudeProjects(transcript), true);
  });

  it('rejects a nested path that uses .. to climb back into the projects tree', () => {
    // A traversal that canonicalizes back under the root must still be rejected
    // (path.resolve/normalize collapses the .. before the prefix test).
    const sneaky = path.join(claudeProjectsRoot(), 'sub', '..', 'other', 'file.jsonl');
    assert.strictEqual(isUnderClaudeProjects(sneaky), true);
  });

  it('allows a normal export target outside ~/.claude/projects', () => {
    const desktop = path.join(os.homedir(), 'Desktop', 'claude-code-nest-export.json');
    assert.strictEqual(isUnderClaudeProjects(desktop), false);
  });

  it('allows ~/.claude/settings.json and other ~/.claude paths NOT under projects', () => {
    const settings = path.join(os.homedir(), '.claude', 'settings.json');
    assert.strictEqual(isUnderClaudeProjects(settings), false);
    const globalStorage = path.join(os.homedir(), '.claude', 'storage', 'snap.json');
    assert.strictEqual(isUnderClaudeProjects(globalStorage), false);
  });

  it('does NOT falsely match a sibling like ~/.claude/projects-archive', () => {
    // The root + path.sep prefix test is the reason a bare startsWith would be a
    // bug here: projects-archive shares the "projects" prefix but is a sibling.
    const sibling = path.join(os.homedir(), '.claude', 'projects-archive', 'x.json');
    assert.strictEqual(isUnderClaudeProjects(sibling), false);
  });
});

// Windows NTFS is case-insensitive, so a re-cased segment resolves to the SAME
// on-disk transcript. The earlier guard folded only the leading drive letter and
// compared case-sensitively, so these slipped the membership test and a write
// landed on a real transcript. The fix case-folds the whole path on win32. These
// tests are win32-only (case behavior is platform-specific) and skip elsewhere.
describe('exportPathGuard case-insensitive Windows membership', () => {
  const winIt = process.platform === 'win32' ? it : it.skip;

  winIt('rejects a target whose .claude/projects segments are re-cased', () => {
    const upperProjects = path.join(os.homedir(), '.claude', 'PROJECTS', 'evil.jsonl');
    assert.strictEqual(isUnderClaudeProjects(upperProjects), true);
    const upperClaude = path.join(os.homedir(), '.CLAUDE', 'projects', 'evil.jsonl');
    assert.strictEqual(isUnderClaudeProjects(upperClaude), true);
  });

  winIt('rejects a fully lowercased home-prefixed target under projects', () => {
    const lowered = path.join(
      os.homedir().toLowerCase(),
      '.claude',
      'projects',
      'c--dir',
      'session.jsonl',
    );
    assert.strictEqual(isUnderClaudeProjects(lowered), true);
  });

  winIt('throws for a re-cased target under projects', () => {
    const upper = path.join(os.homedir(), '.claude', 'PROJECTS', 'c--x', 's.jsonl');
    assert.throws(
      () => assertNotUnderClaudeProjects(upper),
      (err: unknown) => err instanceof ExportPathError,
    );
  });
});

// A symlink/NTFS junction can redirect a lexically-innocent path onto a real
// transcript. The earlier guard never realpathed, so a junction into the projects
// tree slipped the prefix test and the write followed the link. The fix realpaths
// the longest existing prefix before the comparison. To make this deterministic
// (and independent of whether the real ~/.claude/projects exists), the test
// repoints os.homedir() at a scratch tree it builds itself (the same HOME/
// USERPROFILE override the sibling claudeSettingsIO suite uses), creates a REAL
// <scratch>/.claude/projects directory, then a junction (POSIX: dir symlink)
// pointing into it, and aims a write through the junction.
describe('exportPathGuard symlink/junction resolution', () => {
  let scratch: string | null = null;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedHomeDrive: string | undefined;
  let savedHomePath: string | undefined;

  function repointHome(to: string): void {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedHomeDrive = process.env.HOMEDRIVE;
    savedHomePath = process.env.HOMEPATH;
    process.env.HOME = to;
    process.env.USERPROFILE = to;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
  }

  function setOrDelete(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    setOrDelete('HOME', savedHome);
    setOrDelete('USERPROFILE', savedUserProfile);
    setOrDelete('HOMEDRIVE', savedHomeDrive);
    setOrDelete('HOMEPATH', savedHomePath);
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      scratch = null;
    }
  });

  it('rejects a write aimed through a junction into the projects tree', function () {
    // realpathSync.native canonicalizes the OS temp dir casing; build the scratch
    // home under it, repoint HOME so claudeProjectsRoot() resolves there.
    scratch = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nest-junction-')),
    );
    repointHome(scratch);
    const root = claudeProjectsRoot();
    fs.mkdirSync(root, { recursive: true });

    const link = path.join(scratch, 'nestlink');
    try {
      // 'junction' is win32-only; on POSIX use a 'dir' symlink.
      fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      // No permission to create the link (e.g. POSIX without symlink rights): skip.
      this.skip();
      return;
    }

    // A write through the junction into the tree (existing-parent and new-subdir
    // tails) must be blocked: the lexical path says "nestlink", but realpath
    // resolves it back into the projects root.
    const through = path.join(link, 'c--encoded-dir', 'victim.jsonl');
    assert.strictEqual(isUnderClaudeProjects(through), true);
    assert.throws(
      () => assertNotUnderClaudeProjects(through),
      (e: unknown) => e instanceof ExportPathError,
    );

    // A path through the junction that climbs back OUT of the real target is still
    // allowed (realpath resolves the link to the projects root, then .. escapes).
    const escaping = path.join(link, '..', 'elsewhere', 'ok.json');
    assert.strictEqual(isUnderClaudeProjects(escaping), false);
  });
});

describe('exportPathGuard.assertNotUnderClaudeProjects', () => {
  it('throws an ExportPathError for a target under ~/.claude/projects', () => {
    const transcript = path.join(claudeProjectsRoot(), 'c--proj', 'session.jsonl');
    assert.throws(
      () => assertNotUnderClaudeProjects(transcript),
      (err: unknown) => err instanceof ExportPathError,
    );
  });

  it('does not throw for an allowed target', () => {
    const ok = path.join(os.homedir(), 'Documents', 'backup.json');
    assert.doesNotThrow(() => assertNotUnderClaudeProjects(ok));
  });
});
