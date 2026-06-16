import * as assert from 'assert';

// Scaffold smoke test: proves the node + mocha unit harness compiles and runs
// headless without the VSCode electron host. Pure-logic units (jsonlReader,
// projectKeyResolver, store reducers, smart-group signals) test through this
// harness and must not import the 'vscode' module. Electron-host tests live
// under src/test/integration and are deferred to TESTING.md.
describe('scaffold unit harness', () => {
  it('runs a trivial assertion', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
