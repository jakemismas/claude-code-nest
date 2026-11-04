// Parse, coerce and expand the Nest layout file (.nest/config.json). Read-only input:
// this module imports no write API and never touches the file it describes. The
// default filesystem seam uses stat, readdir and realpath only.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const NEST_CONFIG_RELATIVE = path.join('.nest', 'config.json');

export const GROUP_BY_VALUES = ['auto', 'tickets', 'folders', 'date'] as const;
export type GroupBy = (typeof GROUP_BY_VALUES)[number];

export const MAX_CONFIG_PATH_LEN = 1024;
export const MAX_CONFIG_NAME_LEN = 200;
export const MAX_RULES = 200;
export const MAX_LINKED_FOLDERS = 50;
export const MAX_TAGS = 100;
export const MAX_FLEET_FILES = 50;
export const MAX_DONE_STAGES = 50;
export const MAX_LINKED_EXPANSION = 50;
export const MAX_CONFIG_BYTES = 256 * 1024;

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// A rule is kept as a sanitized plain object. Rules are not applied yet.
export type NestRule = { readonly [key: string]: string | number | boolean | readonly string[] };

export interface NestQueueConfig {
  readonly file: string;
  readonly keyColumn: string;
  readonly stageColumn: string;
  readonly titleColumn?: string;
}

export interface NestConfig {
  readonly groupBy: GroupBy;
  readonly rules: readonly NestRule[];
  readonly tags: { readonly [name: string]: string };
  readonly linkedFolders: readonly string[];
  readonly queue: NestQueueConfig | null;
  readonly fleetFiles: readonly string[];
  readonly doneStages: readonly string[];
}

export interface ParsedNestConfig {
  readonly config: NestConfig;
  // Human-readable problems, one per invalid field. Empty for a clean file.
  readonly problems: readonly string[];
}

export const DEFAULT_NEST_CONFIG: NestConfig = {
  groupBy: 'auto',
  rules: [],
  tags: {},
  linkedFolders: [],
  queue: null,
  fleetFiles: [],
  doneStages: ['Done'],
};

// Strips control characters, trims, and caps the length.
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (stripped.length === 0) {
    return null;
  }
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Removes // and /* */ comments and trailing commas, leaving string contents intact.
// The layout file is edited as JSON with comments, so plain JSON.parse is not enough.
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  // Index in `out` of the last comma seen outside a string, with only whitespace and
  // comments since. A closing bracket right after it makes the comma trailing.
  let pendingComma = -1;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      pendingComma = -1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      if (ch === ',') {
        pendingComma = out.length;
      } else if (ch === '}' || ch === ']') {
        if (pendingComma !== -1) {
          out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
        }
        pendingComma = -1;
      } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
        pendingComma = -1;
      }
      out += ch;
      i++;
    }
  }
  return out;
}

function coerceStringList(
  raw: unknown,
  field: string,
  maxItems: number,
  maxLen: number,
  problems: string[],
): string[] | null {
  if (!Array.isArray(raw)) {
    problems.push(`${field} must be an array of strings.`);
    return null;
  }
  const out: string[] = [];
  let dropped = 0;
  for (const item of raw) {
    const s = cleanString(item, maxLen);
    if (s === null) {
      dropped++;
    } else {
      out.push(s);
    }
  }
  if (dropped > 0) {
    problems.push(`${field} had ${dropped} entr${dropped === 1 ? 'y' : 'ies'} that are not non-empty strings; they were ignored.`);
  }
  if (out.length > maxItems) {
    problems.push(`${field} is capped at ${maxItems} entries.`);
    out.length = maxItems;
  }
  return out;
}

function coerceRule(raw: unknown): NestRule | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const rule: { [key: string]: string | number | boolean | readonly string[] } = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = cleanString(key, MAX_CONFIG_NAME_LEN);
    if (k === null || UNSAFE_KEYS.has(k)) {
      continue;
    }
    if (typeof value === 'string') {
      const s = cleanString(value, MAX_CONFIG_PATH_LEN);
      if (s !== null) {
        rule[k] = s;
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      rule[k] = value;
    } else if (typeof value === 'boolean') {
      rule[k] = value;
    } else if (Array.isArray(value)) {
      const list = value
        .map((v) => cleanString(v, MAX_CONFIG_NAME_LEN))
        .filter((v): v is string => v !== null)
        .slice(0, MAX_TAGS);
      rule[k] = list;
    }
  }
  return Object.keys(rule).length > 0 ? rule : null;
}

// Parses the file text. Returns defaults for null, empty or unparsable text, and
// falls back per field so one bad field never discards valid siblings.
export function parseNestConfig(text: string | null): ParsedNestConfig {
  if (text === null) {
    return { config: DEFAULT_NEST_CONFIG, problems: [] };
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim().length === 0) {
    return { config: DEFAULT_NEST_CONFIG, problems: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(source));
  } catch {
    return {
      config: DEFAULT_NEST_CONFIG,
      problems: ['The layout file is not valid JSON; defaults are in use.'],
    };
  }
  if (!isPlainObject(raw)) {
    return {
      config: DEFAULT_NEST_CONFIG,
      problems: ['The layout file must contain a JSON object; defaults are in use.'],
    };
  }

  const problems: string[] = [];

  let groupBy: GroupBy = DEFAULT_NEST_CONFIG.groupBy;
  if (raw.groupBy !== undefined) {
    if (typeof raw.groupBy === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(raw.groupBy)) {
      groupBy = raw.groupBy as GroupBy;
    } else {
      problems.push(`groupBy must be one of ${GROUP_BY_VALUES.join(', ')}; auto is in use.`);
    }
  }

  let rules: NestRule[] = [];
  if (raw.rules !== undefined) {
    if (Array.isArray(raw.rules)) {
      let dropped = 0;
      for (const item of raw.rules) {
        const rule = coerceRule(item);
        if (rule === null) {
          dropped++;
        } else {
          rules.push(rule);
        }
      }
      if (dropped > 0) {
        problems.push(`rules had ${dropped} entr${dropped === 1 ? 'y' : 'ies'} that are not non-empty objects; they were ignored.`);
      }
      if (rules.length > MAX_RULES) {
        problems.push(`rules is capped at ${MAX_RULES} entries.`);
        rules = rules.slice(0, MAX_RULES);
      }
    } else {
      problems.push('rules must be an array.');
    }
  }

  const tags: { [name: string]: string } = {};
  if (raw.tags !== undefined) {
    if (isPlainObject(raw.tags)) {
      let count = 0;
      for (const [name, color] of Object.entries(raw.tags)) {
        const n = cleanString(name, MAX_CONFIG_NAME_LEN);
        if (n === null || UNSAFE_KEYS.has(n)) {
          continue;
        }
        if (typeof color !== 'string' || !HEX_COLOR_RE.test(color.trim())) {
          problems.push(`tags.${n} must be a hex color such as #1a2b3c; the tag was ignored.`);
          continue;
        }
        if (count >= MAX_TAGS) {
          problems.push(`tags is capped at ${MAX_TAGS} entries.`);
          break;
        }
        tags[n] = color.trim();
        count++;
      }
    } else {
      problems.push('tags must be an object of tag name to hex color.');
    }
  }

  const linkedFolders =
    raw.linkedFolders === undefined
      ? []
      : (coerceStringList(raw.linkedFolders, 'linkedFolders', MAX_LINKED_FOLDERS, MAX_CONFIG_PATH_LEN, problems) ?? []);

  let queue: NestQueueConfig | null = null;
  if (raw.queue !== undefined) {
    if (isPlainObject(raw.queue)) {
      const file = cleanString(raw.queue.file, MAX_CONFIG_PATH_LEN);
      const keyColumn = cleanString(raw.queue.keyColumn, MAX_CONFIG_NAME_LEN);
      const stageColumn = cleanString(raw.queue.stageColumn, MAX_CONFIG_NAME_LEN);
      const titleColumn = cleanString(raw.queue.titleColumn, MAX_CONFIG_NAME_LEN);
      if (file === null || keyColumn === null || stageColumn === null) {
        problems.push('queue needs file, keyColumn and stageColumn as non-empty strings; the queue was ignored.');
      } else {
        queue = titleColumn === null ? { file, keyColumn, stageColumn } : { file, keyColumn, stageColumn, titleColumn };
      }
    } else {
      problems.push('queue must be an object.');
    }
  }

  let fleetFiles: string[] = [];
  if (raw.fleet !== undefined) {
    if (isPlainObject(raw.fleet)) {
      if (raw.fleet.files !== undefined) {
        fleetFiles = coerceStringList(raw.fleet.files, 'fleet.files', MAX_FLEET_FILES, MAX_CONFIG_PATH_LEN, problems) ?? [];
      }
    } else {
      problems.push('fleet must be an object.');
    }
  }

  let doneStages: string[] = [...DEFAULT_NEST_CONFIG.doneStages];
  if (raw.doneStages !== undefined) {
    const list = coerceStringList(raw.doneStages, 'doneStages', MAX_DONE_STAGES, MAX_CONFIG_NAME_LEN, problems);
    if (list !== null && list.length > 0) {
      doneStages = list;
    } else if (list !== null) {
      problems.push('doneStages is empty; Done is in use.');
    }
  }

  return {
    config: { groupBy, rules, tags, linkedFolders, queue, fleetFiles, doneStages },
    problems,
  };
}

// Filesystem seam for expansion. Every member is a read.
export interface ExpandDeps {
  readonly homedir: string;
  // The Claude transcript root. Nothing may resolve into it.
  readonly projectsRoot: string;
  isDirectory(p: string): boolean;
  isFile(p: string): boolean;
  listDir(p: string): string[];
  // The canonical path, or null when the path does not exist.
  realpath(p: string): string | null;
}

export function defaultExpandDeps(): ExpandDeps {
  const homedir = os.homedir();
  return {
    homedir,
    projectsRoot: path.join(homedir, '.claude', 'projects'),
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    realpath: (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    },
  };
}

function expandHome(entry: string, homedir: string): string {
  if (entry === '~') {
    return homedir;
  }
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(homedir, entry.slice(2));
  }
  return entry;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// True when the path, lexically or by realpath, is the transcript root or under it.
// The realpath check stops a symlink from escaping the exclusion.
export function isUnderProjectsRoot(target: string, deps: ExpandDeps): boolean {
  const lexicalRoot = path.resolve(deps.projectsRoot);
  const realRoot = deps.realpath(lexicalRoot) ?? lexicalRoot;
  const lexical = path.resolve(target);
  if (isInside(lexical, lexicalRoot) || isInside(lexical, realRoot)) {
    return true;
  }
  const real = deps.realpath(lexical);
  return real !== null && (isInside(real, lexicalRoot) || isInside(real, realRoot));
}

// Linear-time single-segment glob match where * matches any run of characters.
// No RegExp is built from the untrusted pattern, so there is no backtracking blowup.
export function matchGlobSegment(pattern: string, name: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < name.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starP = p++;
      starS = s;
    } else if (p < pattern.length && pattern[p] === name[s]) {
      p++;
      s++;
    } else if (starP !== -1) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') {
    p++;
  }
  return p === pattern.length;
}

export interface ExpandResult {
  readonly paths: string[];
  readonly problems: string[];
}

// Expands linked-folder entries to existing directories. Pure over the injected deps.
export function expandLinkedFolders(
  entries: readonly string[],
  deps: ExpandDeps = defaultExpandDeps(),
): ExpandResult {
  const folders: string[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  const add = (candidate: string): boolean => {
    const real = deps.realpath(candidate);
    if (real === null || !deps.isDirectory(real)) {
      return true;
    }
    if (isUnderProjectsRoot(real, deps)) {
      problems.push(`A linked folder resolves into the Claude transcript directory and was ignored: ${path.basename(candidate)}`);
      return true;
    }
    if (!seen.has(real)) {
      if (folders.length >= MAX_LINKED_EXPANSION) {
        return false;
      }
      seen.add(real);
      folders.push(real);
    }
    return true;
  };

  for (const entry of entries) {
    const expanded = expandHome(entry, deps.homedir);
    if (!path.isAbsolute(expanded)) {
      problems.push(`linkedFolders entry must be an absolute path or start with ~: ${entry}`);
      continue;
    }
    const normalized = path.normalize(expanded);
    const segments = normalized.split(path.sep);
    const wildcardAt = segments.findIndex((s) => s.includes('*'));
    if (wildcardAt !== -1 && wildcardAt !== segments.length - 1) {
      problems.push(`linkedFolders allows * in the last segment only: ${entry}`);
      continue;
    }
    if (wildcardAt === -1) {
      if (!add(normalized)) {
        break;
      }
      continue;
    }
    const parent = path.dirname(normalized);
    const pattern = segments[wildcardAt];
    const names = deps.listDir(parent).filter((name) => matchGlobSegment(pattern, name) && (!name.startsWith('.') || segments[wildcardAt].startsWith('.')));
    names.sort();
    let full = false;
    for (const name of names) {
      if (!add(path.join(parent, name))) {
        full = true;
        break;
      }
    }
    if (full) {
      break;
    }
  }
  if (folders.length >= MAX_LINKED_EXPANSION) {
    problems.push(`Linked folder expansion is capped at ${MAX_LINKED_EXPANSION} matches.`);
  }
  return { paths: folders, problems };
}

// Resolves fleet.files entries to absolute file paths. Wildcards are not allowed.
// A path that resolves into the transcript directory is dropped. A file that does
// not exist yet is kept so a watcher can pick it up when it appears.
export function resolveFleetFileEntries(
  entries: readonly string[],
  deps: ExpandDeps = defaultExpandDeps(),
): ExpandResult {
  const files: string[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const expanded = expandHome(entry, deps.homedir);
    if (!path.isAbsolute(expanded) || expanded.includes('*')) {
      problems.push(`fleet.files entry must be an absolute path or start with ~, with no *: ${entry}`);
      continue;
    }
    const normalized = path.normalize(expanded);
    if (isUnderProjectsRoot(normalized, deps) || isUnderProjectsRoot(path.dirname(normalized), deps)) {
      problems.push(`A fleet file resolves into the Claude transcript directory and was ignored: ${path.basename(normalized)}`);
      continue;
    }
    if (!files.includes(normalized)) {
      files.push(normalized);
    }
  }
  return { paths: files, problems };
}
