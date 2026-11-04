// Unit tests for choosing the integration test user data directory.
import * as assert from 'assert';
import * as path from 'path';
import { integrationUserDataDir } from '../integration/userDataDir';

const tmp = path.join('/tmp');

describe('integrationUserDataDir', () => {
  it('keeps the default folder for a short checkout path', () => {
    const shallow = path.join('/home', 'dev', 'nest', '.vscode-test', 'user-data');
    assert.strictEqual(integrationUserDataDir(shallow, tmp), shallow);
  });

  it('moves to the temp folder when the socket path would be too long', () => {
    const deep = path.join('/Users', 'someone', 'projects', 'a'.repeat(40), 'nest', '.vscode-test', 'user-data');
    assert.strictEqual(integrationUserDataDir(deep, tmp), path.join(tmp, 'nest-vscode-test'));
  });

  it('keeps a folder that leaves exactly enough room for the socket name', () => {
    const exact = '/' + 'x'.repeat(82);
    assert.strictEqual(integrationUserDataDir(exact, tmp), exact);
    assert.strictEqual(integrationUserDataDir(exact + 'y', tmp), path.join(tmp, 'nest-vscode-test'));
  });
});
