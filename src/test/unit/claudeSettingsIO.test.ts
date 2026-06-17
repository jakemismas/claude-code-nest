import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CLEANUP_PERIOD_DAYS_KEY,
  SettingsIoError,
  assertAllowedTarget,
  computeCleanupPeriodEdit,
  detectEol,
  readCleanupPeriodDays,
  settingsJsonPath,
  validateCleanupPeriodDays,
  writeCleanupPeriodDays,
} from '../../settings/claudeSettingsIO';

// Unit tests for the read-only chokepoint and its surgical jsonc edit. Every
// filesystem test runs against a scratch fixture under the OS temp dir; the real
// ~/.claude/settings.json is NEVER read or written here. No vscode import (the IO
// module is vscode-free). The test tree is exempt from the no-restricted-syntax
// chokepoint, so this file may call write-capable fs to build and tear down
// fixtures.
//
// CRITICAL safety check: writes go to a scratch path, but writeCleanupPeriodDays
// hard-asserts the allowed settings.json path. To exercise the write path against
// a scratch file WITHOUT disabling the assertion, we point the assertion at the
// scratch path by overriding HOME/USERPROFILE so settingsJsonPath() (which is
// os.homedir()-anchored) resolves under the scratch tree. We restore the env
// afterward. This proves the real chokepoint logic, not a test-only bypass.

let root: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedHomeDrive: string | undefined;
let savedHomePath: string | undefined;

// Repoint os.homedir() at the scratch tree by setting the env vars Node reads on
// each platform, so settingsJsonPath() yields <scratch>/.claude/settings.json and
// the chokepoint's allowed-path assertion targets the fixture.
function repointHome(to: string): void {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedHomeDrive = process.env.HOMEDRIVE;
  savedHomePath = process.env.HOMEPATH;
  process.env.HOME = to;
  process.env.USERPROFILE = to;
  // On win32 Node prefers USERPROFILE; clear the HOMEDRIVE/HOMEPATH pair so they
  // do not win over USERPROFILE on any node version.
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
}

function restoreHome(): void {
  setOrDelete('HOME', savedHome);
  setOrDelete('USERPROFILE', savedUserProfile);
  setOrDelete('HOMEDRIVE', savedHomeDrive);
  setOrDelete('HOMEPATH', savedHomePath);
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function claudeDir(): string {
  return path.join(root, '.claude');
}

function settingsPath(): string {
  return path.join(claudeDir(), 'settings.json');
}

function writeSettings(content: string): void {
  fs.mkdirSync(claudeDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), content, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-settings-'));
  repointHome(root);
});

afterEach(() => {
  restoreHome();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('claudeSettingsIO.validateCleanupPeriodDays (reject non-integer)', () => {
  it('accepts a non-negative integer number', () => {
    assert.deepStrictEqual(validateCleanupPeriodDays(45), { ok: true, value: 45 });
    assert.deepStrictEqual(validateCleanupPeriodDays(0), { ok: true, value: 0 });
  });

  it('accepts a clean integer string', () => {
    assert.deepStrictEqual(validateCleanupPeriodDays('30'), { ok: true, value: 30 });
    assert.deepStrictEqual(validateCleanupPeriodDays('  12  '), { ok: true, value: 12 });
  });

  it('rejects a decimal', () => {
    const r = validateCleanupPeriodDays('30.5');
    assert.strictEqual(r.ok, false);
  });

  it('rejects a float number', () => {
    const r = validateCleanupPeriodDays(30.5);
    assert.strictEqual(r.ok, false);
  });

  it('rejects a non-numeric string', () => {
    assert.strictEqual(validateCleanupPeriodDays('abc').ok, false);
    assert.strictEqual(validateCleanupPeriodDays('').ok, false);
    assert.strictEqual(validateCleanupPeriodDays('1e3').ok, false);
    assert.strictEqual(validateCleanupPeriodDays('0x10').ok, false);
  });

  it('rejects a negative integer', () => {
    assert.strictEqual(validateCleanupPeriodDays('-5').ok, false);
    assert.strictEqual(validateCleanupPeriodDays(-5).ok, false);
  });

  it('rejects non-number, non-string', () => {
    assert.strictEqual(validateCleanupPeriodDays(null).ok, false);
    assert.strictEqual(validateCleanupPeriodDays(undefined).ok, false);
    assert.strictEqual(validateCleanupPeriodDays({}).ok, false);
  });
});

describe('claudeSettingsIO.assertAllowedTarget (path-assertion throw)', () => {
  it('accepts the canonical settings.json path', () => {
    assert.doesNotThrow(() => assertAllowedTarget(settingsJsonPath()));
  });

  it('throws on a path under ~/.claude/projects (never write there)', () => {
    const projectsTarget = path.join(claudeDir(), 'projects', 'somefile.jsonl');
    assert.throws(() => assertAllowedTarget(projectsTarget), SettingsIoError);
  });

  it('throws on any other settings.json outside ~/.claude', () => {
    assert.throws(
      () => assertAllowedTarget(path.join(root, 'settings.json')),
      SettingsIoError,
    );
  });

  it('throws on a sibling file in ~/.claude that is not settings.json', () => {
    assert.throws(
      () => assertAllowedTarget(path.join(claudeDir(), 'config.json')),
      SettingsIoError,
    );
  });

  it('accepts a non-normalized but equivalent path (dot-segment) to the allowed target', () => {
    const sneaky = path.join(claudeDir(), 'projects', '..', 'settings.json');
    assert.doesNotThrow(() => assertAllowedTarget(sneaky));
  });
});

describe('claudeSettingsIO.computeCleanupPeriodEdit (preserve siblings / formatting)', () => {
  it('replaces only the value bytes of an existing key, preserving every sibling and the formatting', () => {
    const text = '{\n  "model": "opus[1m]",\n  "cleanupPeriodDays": 30,\n  "x": 1\n}\n';
    const edit = computeCleanupPeriodEdit(text, 45);
    assert.strictEqual(edit.existed, true);
    assert.strictEqual(edit.unchanged, false);
    const result = edit.before + edit.replacement + edit.after;
    assert.strictEqual(
      result,
      '{\n  "model": "opus[1m]",\n  "cleanupPeriodDays": 45,\n  "x": 1\n}\n',
    );
  });

  it('reports unchanged when the value already equals the requested integer', () => {
    const text = '{\n  "cleanupPeriodDays": 30\n}\n';
    const edit = computeCleanupPeriodEdit(text, 30);
    assert.strictEqual(edit.unchanged, true);
    assert.strictEqual(edit.before + edit.replacement + edit.after, text);
  });

  it('inserts the key as the first member when absent, preserving the other members', () => {
    const text = '{\n  "model": "opus[1m]",\n  "x": 1\n}\n';
    const edit = computeCleanupPeriodEdit(text, 14);
    assert.strictEqual(edit.existed, false);
    const result = edit.before + edit.replacement + edit.after;
    // The original members survive verbatim; the new key is inserted with a comma.
    assert.ok(result.includes('"model": "opus[1m]"'));
    assert.ok(result.includes('"x": 1'));
    assert.ok(result.includes('"cleanupPeriodDays": 14,'));
    // And the result must round-trip as valid JSON with the right value.
    const parsed = JSON.parse(result) as Record<string, unknown>;
    assert.strictEqual(parsed[CLEANUP_PERIOD_DAYS_KEY], 14);
    assert.strictEqual(parsed.model, 'opus[1m]');
    assert.strictEqual(parsed.x, 1);
  });

  it('inserts into an empty object', () => {
    const edit = computeCleanupPeriodEdit('{}', 7);
    const result = edit.before + edit.replacement + edit.after;
    const parsed = JSON.parse(result) as Record<string, unknown>;
    assert.strictEqual(parsed[CLEANUP_PERIOD_DAYS_KEY], 7);
  });

  it('does not match a nested cleanupPeriodDays at depth > 1', () => {
    // A same-named key nested inside another object must NOT be the target; the
    // edit must insert a NEW top-level key instead.
    const text = '{\n  "nested": { "cleanupPeriodDays": 99 }\n}\n';
    const edit = computeCleanupPeriodEdit(text, 5);
    assert.strictEqual(edit.existed, false);
    const result = edit.before + edit.replacement + edit.after;
    const parsed = JSON.parse(result) as Record<string, { cleanupPeriodDays: number }>;
    assert.strictEqual(parsed[CLEANUP_PERIOD_DAYS_KEY] as unknown as number, 5);
    assert.strictEqual(parsed.nested.cleanupPeriodDays, 99);
  });

  it('preserves CRLF EOL when the document uses CRLF', () => {
    const text = '{\r\n  "model": "x"\r\n}\r\n';
    assert.strictEqual(detectEol(text), '\r\n');
    const edit = computeCleanupPeriodEdit(text, 9);
    const result = edit.before + edit.replacement + edit.after;
    // The inserted member's line break uses CRLF, matching the file.
    assert.ok(result.includes('\r\n  "cleanupPeriodDays": 9,'));
    // No bare LF was introduced for the new line.
    assert.ok(!/[^\r]\n {2}"cleanupPeriodDays"/.test(result));
  });
});

describe('claudeSettingsIO.readCleanupPeriodDays', () => {
  it('reports usingDefault when the file is missing', () => {
    const r = readCleanupPeriodDays(settingsPath());
    assert.deepStrictEqual(r, { value: null, usingDefault: true });
  });

  it('reports usingDefault when the key is absent', () => {
    writeSettings('{\n  "model": "opus[1m]"\n}\n');
    const r = readCleanupPeriodDays(settingsPath());
    assert.strictEqual(r.usingDefault, true);
    assert.strictEqual(r.value, null);
  });

  it('reads an existing integer value', () => {
    writeSettings('{\n  "cleanupPeriodDays": 21,\n  "model": "x"\n}\n');
    const r = readCleanupPeriodDays(settingsPath());
    assert.deepStrictEqual(r, { value: 21, usingDefault: false });
  });

  it('tolerates // and /* */ comments (jsonc) around the key', () => {
    writeSettings(
      '{\n  // retention\n  "cleanupPeriodDays": 60, /* days */\n  "model": "x"\n}\n',
    );
    const r = readCleanupPeriodDays(settingsPath());
    assert.strictEqual(r.value, 60);
  });
});

describe('claudeSettingsIO.writeCleanupPeriodDays (create-when-missing, full path)', () => {
  it('creates settings.json with the key when the file does not exist', () => {
    // The .claude dir exists (repointed HOME), but no settings.json yet.
    fs.mkdirSync(claudeDir(), { recursive: true });
    writeCleanupPeriodDays(33);
    const written = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(written) as Record<string, unknown>;
    assert.strictEqual(parsed[CLEANUP_PERIOD_DAYS_KEY], 33);
  });

  it('replaces the value preserving siblings and formatting', () => {
    writeSettings('{\n  "model": "opus[1m]",\n  "cleanupPeriodDays": 30,\n  "x": 1\n}\n');
    writeCleanupPeriodDays(45);
    const written = fs.readFileSync(settingsPath(), 'utf8');
    assert.strictEqual(
      written,
      '{\n  "model": "opus[1m]",\n  "cleanupPeriodDays": 45,\n  "x": 1\n}\n',
    );
  });

  it('inserts the key into an existing doc without disturbing siblings', () => {
    writeSettings('{\n  "model": "opus[1m]",\n  "permissions": { "allow": [] }\n}\n');
    writeCleanupPeriodDays(14);
    const written = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(written) as Record<string, unknown>;
    assert.strictEqual(parsed[CLEANUP_PERIOD_DAYS_KEY], 14);
    assert.strictEqual(parsed.model, 'opus[1m]');
    assert.deepStrictEqual(parsed.permissions, { allow: [] });
  });

  it('throws on a non-integer value', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    assert.throws(() => writeCleanupPeriodDays(30.5), SettingsIoError);
    assert.throws(() => writeCleanupPeriodDays(-1), SettingsIoError);
  });

  it('aborts the write when the file mtime changes between read and write', () => {
    writeSettings('{\n  "cleanupPeriodDays": 30\n}\n');
    const original = fs.readFileSync(settingsPath(), 'utf8');

    // Inject a MOVING mtime reader through the WriteOptions seam so the re-stat
    // (immediately before the write) differs from the initial read-stat. This
    // exercises the mtimeMs float-comparison guard directly and deterministically,
    // independent of filesystem second-resolution, without monkeypatching the
    // non-configurable fs.statSync module property.
    let calls = 0;
    assert.throws(
      () =>
        writeCleanupPeriodDays(45, settingsPath(), {
          statMtimeMs: () => 1000 + ++calls,
        }),
      SettingsIoError,
    );

    // The file must be UNCHANGED after the aborted write.
    const after = fs.readFileSync(settingsPath(), 'utf8');
    assert.strictEqual(after, original);
    // And the guard fired AFTER taking both stat readings.
    assert.strictEqual(calls, 2);
  });

  it('writes successfully when the injected mtime is stable across the read and re-stat', () => {
    writeSettings('{\n  "cleanupPeriodDays": 30\n}\n');
    writeCleanupPeriodDays(45, settingsPath(), { statMtimeMs: () => 4242 });
    const after = fs.readFileSync(settingsPath(), 'utf8');
    assert.strictEqual(after, '{\n  "cleanupPeriodDays": 45\n}\n');
  });

  it('does not write when the value is unchanged (no-op preserves the file exactly)', () => {
    const text = '{\n  "cleanupPeriodDays": 30,\n  "model": "x"\n}\n';
    writeSettings(text);
    writeCleanupPeriodDays(30);
    assert.strictEqual(fs.readFileSync(settingsPath(), 'utf8'), text);
  });
});
