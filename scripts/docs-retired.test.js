'use strict';
// Guards the shipped docs against naming surfaces the panel replaced, and against
// links to files that do not exist. CHANGELOG.md records history, so it is exempt.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const RETIRED = [
  /smart groups? (tree|list|view)/i,
  /archive tree/i,
  /settings (editor )?tab/i,
  /flat chats? (tree|list)/i,
  /sidebar-mockup/i,
  /hover card/i,
  /ARCHITECTURE\.md/,
];

function docFiles() {
  const files = [path.join(root, 'README.md')];
  const dir = path.join(root, 'docs');
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.md')) {
      files.push(path.join(dir, name));
    }
  }
  return files;
}

describe('docs', () => {
  it('name no retired surface', () => {
    const hits = [];
    for (const file of docFiles()) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const re of RETIRED) {
            if (re.test(line)) {
              hits.push(`${path.relative(root, file)}:${i + 1} ${re}`);
            }
          }
        });
    }
    assert.deepStrictEqual(hits, []);
  });

  it('link only to files that exist', () => {
    const broken = [];
    for (const file of docFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target)) {
          continue;
        }
        if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
          broken.push(`${path.relative(root, file)} -> ${target}`);
        }
      }
    }
    assert.deepStrictEqual(broken, []);
  });
});
