#!/usr/bin/env node
// Pre-push privacy check: refuses a push whose commits, changed paths, or added
// lines contain any word from a local, untracked word list.
//
// Usage:
//   node scripts/private-words/check.js [<base>..<head>]   (default origin/main..HEAD)
//
// The list lives outside the repo at ~/.config/nest/private-words.txt (override
// with NEST_PRIVATE_WORDS). One word or phrase per line; blank lines and lines
// starting with # are ignored. Matching is case-insensitive on word boundaries.
// A missing or empty list fails closed, so a fresh machine cannot push by accident.
//
// Exit codes: 0 clean, 1 a listed word was found, 2 the check could not run.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_LIST = path.join(os.homedir(), '.config', 'nest', 'private-words.txt');

function parseWordList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word boundaries are any non-alphanumeric character, so "acme" matches "acme-repo"
// and "Acme's" but not "acmeville".
function buildMatcher(words) {
  const compiled = words.map((w) => ({
    word: w,
    re: new RegExp('(^|[^A-Za-z0-9])' + escapeRegExp(w) + '($|[^A-Za-z0-9])', 'i'),
  }));
  return (text) => compiled.filter((c) => c.re.test(text)).map((c) => c.word);
}

// Scans the three surfaces a push publishes: commit messages, changed file paths,
// and lines the range adds. Removed lines are not scanned; deleting a word is fine.
function scan({ messages, paths, addedLines }, words) {
  const match = buildMatcher(words);
  const hits = [];
  for (const m of messages) {
    for (const w of match(m.text)) hits.push({ where: 'commit ' + m.sha, word: w });
  }
  for (const p of paths) {
    for (const w of match(p)) hits.push({ where: 'path ' + p, word: w });
  }
  for (const l of addedLines) {
    for (const w of match(l.text)) hits.push({ where: l.file + ':' + l.line, word: w });
  }
  return hits;
}

function parseDiff(diffText) {
  const added = [];
  let file = null;
  let line = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith('+')) {
      added.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line += 1;
    }
  }
  return added;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function collect(range) {
  const log = git(['log', '--format=%H%x00%B%x1e', range]);
  const messages = log
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, text] = chunk.split('\x00');
      return { sha: sha.slice(0, 12), text: text || '' };
    });
  const paths = git(['diff', '--name-only', range]).split('\n').filter(Boolean);
  const addedLines = parseDiff(git(['diff', '--unified=0', '--no-color', range]));
  return { messages, paths, addedLines };
}

function main(argv) {
  const range = argv[0] || 'origin/main..HEAD';
  if (!/^[A-Za-z0-9._\/~^@-]+\.\.[A-Za-z0-9._\/~^@-]+$/.test(range)) {
    process.stderr.write('private-words: expected a range like origin/main..HEAD\n');
    return 2;
  }
  const listPath = process.env.NEST_PRIVATE_WORDS || DEFAULT_LIST;
  let words;
  try {
    words = parseWordList(fs.readFileSync(listPath, 'utf8'));
  } catch (err) {
    process.stderr.write('private-words: cannot read ' + listPath + ' (' + err.code + '). Create it, one word per line, then retry.\n');
    return 2;
  }
  if (words.length === 0) {
    process.stderr.write('private-words: ' + listPath + ' lists no words; refusing to vouch for this push.\n');
    return 2;
  }
  let surfaces;
  try {
    surfaces = collect(range);
  } catch (err) {
    process.stderr.write('private-words: git failed for ' + range + ': ' + err.message + '\n');
    return 2;
  }
  const hits = scan(surfaces, words);
  if (hits.length > 0) {
    process.stderr.write('private-words: push refused, ' + hits.length + ' match(es):\n');
    for (const h of hits) process.stderr.write('  ' + h.where + '  [' + h.word + ']\n');
    return 1;
  }
  process.stdout.write('private-words: clean (' + surfaces.messages.length + ' commits, ' + surfaces.paths.length + ' paths, ' + words.length + ' words).\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseWordList, buildMatcher, scan, parseDiff, main };
