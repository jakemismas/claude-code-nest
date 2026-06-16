import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

// The mocha programmatic runner the Extension Development Host invokes (the host
// calls the exported run()). It lives INSIDE the host, so its `require('vscode')`
// resolves to the real module: this is the only place the integration specs can
// import vscode and touch real DataTransfer / TreeItem types.
//
// Kept separate from the .mocharc.json headless config on purpose: the headless
// `npm test` globs out/test/unit/**, never out/test/integration/**, so an
// integration spec can never be pulled into the unattended gate (ARCHITECTURE.md
// "Test layering"). This runner globs only the integration directory.

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20000 });
  const testsRoot = __dirname;

  return new Promise<void>((resolve, reject) => {
    let files: string[];
    try {
      // Discover compiled integration specs by a shallow readdir rather than glob,
      // so this runner does not depend on the glob package's shifting API. Only
      // *.test.js in THIS directory are integration specs.
      files = fs
        .readdirSync(testsRoot)
        .filter((name) => name.endsWith('.test.js'));
    } catch (err) {
      reject(err);
      return;
    }

    for (const file of files) {
      mocha.addFile(path.resolve(testsRoot, file));
    }

    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
