import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { integrationUserDataDir } from './userDataDir';
import { resolveVscodeExecutable } from './vscodeExecutable';

// Launcher for the integration suite: downloads a VSCode build and runs the suite in a real Extension Development
// Host, the only place host-only behavior (real DataTransfer, instanceof TreeItem dispatch) can run. It needs a
// download and a display, so a person or CI runs it; the headless `npm test` never does.

async function main(): Promise<void> {
  try {
    // A VS Code integrated terminal sets this, which makes the launched Electron binary run as plain Node.
    delete process.env.ELECTRON_RUN_AS_NODE;

    // Repo root (two levels up from out/test/integration), holding the package.json the host loads as the extension.
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './index');

    const downloaded = await downloadAndUnzipVSCode();
    const vscodeExecutablePath = resolveVscodeExecutable(downloaded, {
      exists: (p) => fs.existsSync(p),
    });

    const exitCode = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      // No workspace folder is opened: the contract tests build controllers and a fake store directly. Bundled
      // extensions are disabled to keep the host minimal and deterministic.
      launchArgs: [
        '--disable-extensions',
        '--user-data-dir=' +
          integrationUserDataDir(path.resolve(process.cwd(), '.vscode-test', 'user-data'), os.tmpdir()),
      ],
    });
    process.exit(exitCode);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

void main();
