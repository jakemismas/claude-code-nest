import * as assert from 'assert';
import * as path from 'path';
import { resolveVscodeExecutable } from '../integration/vscodeExecutable';

const dir = path.join('/dl', 'Visual Studio Code.app', 'Contents', 'MacOS');
const electron = path.join(dir, 'Electron');
const code = path.join(dir, 'Code');

function probeOf(existing: string[]) {
  return { exists: (p: string) => existing.includes(p) };
}

describe('resolveVscodeExecutable', () => {
  it('returns the Electron path when it exists', () => {
    assert.strictEqual(resolveVscodeExecutable(electron, probeOf([electron, code])), electron);
  });

  it('falls back to Code when Electron is missing', () => {
    assert.strictEqual(resolveVscodeExecutable(electron, probeOf([code])), code);
  });

  it('returns the Code path when it is the downloaded path and exists', () => {
    assert.strictEqual(resolveVscodeExecutable(code, probeOf([code])), code);
  });

  it('throws when neither name exists', () => {
    assert.throws(() => resolveVscodeExecutable(electron, probeOf([])), /not found/);
  });
});
