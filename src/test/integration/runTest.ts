import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// The electron-host integration test LAUNCHER. This is the file package.json's
// `test:integration` script points at (out/test/integration/runTest.js after
// tsc). It downloads a VSCode build and runs the integration suite inside a real
// Extension Development Host, which is the only place the host-only behaviors can
// be exercised: a real vscode.DataTransfer / DataTransferItem round-trip and the
// `instanceof vscode.TreeItem` node-dispatch in the drag-and-drop controller.
//
// This is DEFERRED, not part of the unattended headless gate (`npm test`): it
// needs a VSCode download and a display, so it is run by a human or CI per
// TESTING.md and ARCHITECTURE.md "Test layering". The headless mocha suite never
// downloads VSCode; this launcher is the separate entry point that does.

async function main(): Promise<void> {
  try {
    // The repo root (two levels up from out/test/integration): it holds the
    // package.json Extension Manifest the host loads via --extensionDevelopmentPath.
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    // The compiled suite directory; index.js here exports the run() the host calls.
    const extensionTestsPath = path.resolve(__dirname, './index');

    const exitCode = await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // No workspace folder is opened: the contract tests construct the
      // controllers and a fake store directly (the project key is supplied), so
      // they do not depend on a real ~/.claude/projects scan. Disable the
      // bundled-extensions to keep the host minimal and deterministic.
      launchArgs: ['--disable-extensions'],
    });
    process.exit(exitCode);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

void main();
