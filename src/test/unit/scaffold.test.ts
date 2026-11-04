import * as assert from 'assert';

// Smoke test that the node and mocha unit harness compiles and runs without the VSCode host.
// Host-dependent tests live under src/test/integration.
describe('scaffold unit harness', () => {
  it('runs a trivial assertion', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
