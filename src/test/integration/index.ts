import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

// Mocha runner the Extension Development Host invokes (via the exported run). It runs inside the host, so
// require('vscode') resolves to the real module. It is separate from .mocharc.json because the headless
// `npm test` globs out/test/unit/** and must never pick up integration specs; this runner globs only this directory.

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20000 });
  const testsRoot = __dirname;

  return new Promise<void>((resolve, reject) => {
    let files: string[];
    try {
      // A shallow readdir avoids depending on the glob package API; only *.test.js here are integration specs.
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
