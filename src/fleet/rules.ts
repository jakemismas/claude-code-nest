// Pure organize rules. Compiles the rules of the layout file, matches chats against
// them (first match wins), expands folder templates and plans the moves a backfill
// would make or undo. No vscode, no filesystem, no clock: the caller passes the
// current curation state, so nothing here can write.
import * as path from 'path';
import { MAX_FOLDER_CREATE_DEPTH, findChildByName, splitFolderPath } from '../model/folderTree';
import type { Folder, Tag } from '../store/schema';
import type { OrganizeLedger } from '../store/schema';
import { MAX_MATCH_PATTERN_LEN, NestRule, expandHome, matchGlobSegment } from './nestConfig';
import { removeTicket } from './suffix';
import { FleetEntry } from './types';

export const RULE_MATCH_KEYS = ['role', 'agent', 'ticket', 'name', 'cwd'] as const;
export const TEMPLATE_FIELDS = ['ticket', 'title', 'agent', 'role', 'subfolder'] as const;
type TemplateField = (typeof TEMPLATE_FIELDS)[number];

const FOLDER_NAME_MAX = 200;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

// The facts a rule can match on and a template can expand, taken from the coerced
// fleet fields and the scan. Empty string or null means unknown.
export interface RuleSubject {
  readonly sessionId: string;
  // The transcript title, shown in the preview.
  readonly title: string;
  // The fleet record name, else the transcript title. Matched by the name condition.
  readonly name: string;
  readonly ticket: string | null;
  readonly role: string | null;
  readonly agent: string;
  readonly cwd: string | null;
  // The fleet record name with the ticket id removed. Empty without a fleet record.
  readonly fleetTitle: string;
  // The working directory relative to the workspace root with separators as '-'.
  readonly subfolder: string;
}

export interface CompiledRule {
  // Position in the rules array of the layout file.
  readonly index: number;
  readonly role: string | null;
  readonly agent: string | null;
  // True means any ticket; a RegExp tests the ticket id.
  readonly ticket: true | RegExp | null;
  readonly name: RegExp | null;
  readonly cwd: string | null;
  readonly folder: string | null;
  readonly tags: readonly string[];
  readonly pin: boolean;
}

export interface CompileResult {
  readonly rules: readonly CompiledRule[];
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Regex rules run on the extension host, so a pattern is limited to a shape that cannot
// backtrack badly: no quantified groups, no lookarounds or backreferences and a small
// number of quantifiers. The worst-case work is estimated as the product of every
// quantifier's reach (an open-ended one reaches the whole subject) times the number of
// start positions, and a pattern over the budget is refused. The tested text is short.
const MAX_TESTED_SUBJECT_LEN = 64;
const MAX_PATTERN_QUANTIFIERS = 3;
const MAX_PATTERN_COST = 100000;
const BOUNDED_QUANTIFIER = /^\{\d+(,\d*)?\}/;

// True when a '|' sits outside every group, so an '^' at the start covers only one branch.
function hasTopLevelAlternation(pattern: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
    } else if (inClass) {
      inClass = ch !== ']';
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === '|' && depth === 0) {
      return true;
    }
  }
  return false;
}

// Backslashes directly before index i; an odd count means the character is escaped.
function isEscapedAt(pattern: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && pattern[j] === '\\'; j--) {
    n++;
  }
  return n % 2 === 1;
}

// Drops a leading '.*' and a trailing '.*' that cannot change whether RegExp.test finds a
// match on a single-line name. The trailing one stays when the pattern has a '$'. Only one
// of each is dropped, so stacked repeats are still costed.
export function normalizeMatchPattern(pattern: string): string {
  let out = pattern;
  if (out.startsWith('.*') && !/^[*+{]/.test(out.slice(2, 3))) {
    out = out.slice(out.startsWith('.*?') ? 3 : 2);
  }
  if (!out.includes('$')) {
    const lazy = out.endsWith('.*?');
    const tail = lazy ? out.length - 3 : out.length - 2;
    if ((lazy || out.endsWith('.*')) && tail >= 0 && !isEscapedAt(out, tail)) {
      out = out.slice(0, tail);
    }
  }
  return out;
}

interface Anchors {
  readonly start: boolean;
  readonly end: boolean;
}

const anchorCache = new WeakMap<RegExp, Anchors>();

function anchorsOf(re: RegExp): Anchors {
  const known = anchorCache.get(re);
  if (known !== undefined) {
    return known;
  }
  const pattern = re.source;
  let start = false;
  let end = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
    } else if (inClass) {
      inClass = ch !== ']';
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '^') {
      start = true;
    } else if (ch === '$') {
      end = true;
    }
  }
  const anchors = { start, end };
  anchorCache.set(re, anchors);
  return anchors;
}

// Tests at most MAX_TESTED_SUBJECT_LEN characters. A pattern with '$' sees the last
// characters, so 'x$' still means the text ends in x; a pattern anchored at both ends
// cannot match text over the cap.
function testCapped(re: RegExp, text: string): boolean {
  if (text.length <= MAX_TESTED_SUBJECT_LEN) {
    return re.test(text);
  }
  const { start, end } = anchorsOf(re);
  if (!end) {
    return re.test(text.slice(0, MAX_TESTED_SUBJECT_LEN));
  }
  if (start) {
    return false;
  }
  return re.test(text.slice(-MAX_TESTED_SUBJECT_LEN));
}

export function unsafePatternReason(pattern: string): string | null {
  let quantifiers = 0;
  const topLevelAlt = hasTopLevelAlternation(pattern);
  let cost = pattern.startsWith('^') && !topLevelAlt ? 1 : MAX_TESTED_SUBJECT_LEN + 1;
  let inClass = false;
  // Branch count of each open group; a group with several branches multiplies the cost.
  const branches: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9k]/.test(next)) {
        return 'uses a backreference';
      }
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(' && pattern[i + 1] === '?') {
      if (pattern[i + 2] !== ':') {
        return 'uses a lookaround or named group';
      }
      i += 2;
      branches.push(1);
      continue;
    }
    if (ch === '(') {
      branches.push(1);
      continue;
    }
    if (ch === '|' && branches.length > 0) {
      branches[branches.length - 1]++;
      continue;
    }
    let width = 0;
    let reach = 0;
    if (ch === '*' || ch === '+') {
      width = 1;
      reach = MAX_TESTED_SUBJECT_LEN;
    } else if (ch === '?') {
      width = 1;
      reach = 1;
    } else if (ch === '{') {
      const m = BOUNDED_QUANTIFIER.exec(pattern.slice(i));
      width = m === null ? 0 : m[0].length;
      if (m !== null) {
        const parts = m[0].slice(1, -1).split(',');
        const upper = parts.length === 1 ? Number(parts[0]) : parts[1] === '' ? Infinity : Number(parts[1]);
        reach = Math.min(upper, MAX_TESTED_SUBJECT_LEN);
      }
    }
    if (width > 0) {
      // A repeat that ends the pattern succeeds as soon as its minimum is met, so it
      // never backtracks into earlier text.
      let end = i + width;
      if (pattern[end] === '?') {
        end++;
      }
      const isFinal = end === pattern.length && branches.length === 0 && !topLevelAlt;
      cost *= isFinal ? 1 : reach + 1;
      if (cost > MAX_PATTERN_COST) {
        return 'is too expensive to match: drop a leading or trailing .* (it is implied), use fewer or narrower repeats, or anchor it with ^';
      }
    }
    if (width > 0) {
      quantifiers++;
      if (quantifiers > MAX_PATTERN_QUANTIFIERS) {
        return `uses more than ${MAX_PATTERN_QUANTIFIERS} quantifiers`;
      }
      i += width - 1;
      if (pattern[i + 1] === '?') {
        i++;
      }
      continue;
    }
    if (ch === ')') {
      const count = branches.pop() ?? 1;
      if (count > 1) {
        cost *= count;
        if (cost > MAX_PATTERN_COST) {
          return 'is too expensive to match: use fewer alternations, drop a leading or trailing .*, or anchor it with ^';
        }
      }
      const rest = pattern.slice(i + 1);
      if (/^[*+?]/.test(rest) || BOUNDED_QUANTIFIER.test(rest)) {
        return 'repeats a group';
      }
    }
  }
  return null;
}

// Compiles each rule once. A rule that cannot be used (unknown key, bad type, invalid or
// over-long regex, no condition, no action, unknown template field) is dropped and
// reported; the other rules stay active.
export function compileRules(raw: readonly NestRule[]): CompileResult {
  const rules: CompiledRule[] = [];
  const problems: string[] = [];
  raw.forEach((rule, index) => {
    const label = `rules[${index}]`;
    const fail = (reason: string): void => {
      problems.push(`${label} ${reason}; the rule is off.`);
    };
    const matchRaw: unknown = rule.match;
    if (!isRecord(matchRaw)) {
      fail('needs a match object');
      return;
    }
    let role: string | null = null;
    let agent: string | null = null;
    let ticket: true | RegExp | null = null;
    let name: RegExp | null = null;
    let cwd: string | null = null;
    for (const [key, value] of Object.entries(matchRaw)) {
      if (!(RULE_MATCH_KEYS as readonly string[]).includes(key)) {
        fail(`has an unknown match key "${key}"`);
        return;
      }
      if (key === 'ticket' && value === true) {
        ticket = true;
        continue;
      }
      if (typeof value !== 'string' || value.length === 0) {
        fail(`has a match.${key} that is not a non-empty string${key === 'ticket' ? ' or true' : ''}`);
        return;
      }
      if (value.length > MAX_MATCH_PATTERN_LEN) {
        fail(`has a match.${key} longer than ${MAX_MATCH_PATTERN_LEN} characters`);
        return;
      }
      if (key === 'role') {
        role = value.toLowerCase();
      } else if (key === 'agent') {
        agent = value.toLowerCase();
      } else if (key === 'cwd') {
        cwd = value;
      } else {
        const normalized = normalizeMatchPattern(value);
        const unsafe = unsafePatternReason(normalized);
        if (unsafe !== null) {
          fail(`has a match.${key} that ${unsafe}`);
          return;
        }
        try {
          const re = new RegExp(normalized, 'i');
          if (key === 'ticket') {
            ticket = re;
          } else {
            name = re;
          }
        } catch {
          fail(`has an invalid regular expression in match.${key}`);
          return;
        }
      }
    }
    if (role === null && agent === null && ticket === null && name === null && cwd === null) {
      fail('has no match conditions');
      return;
    }

    let folder: string | null = null;
    if (rule.folder !== undefined) {
      if (typeof rule.folder !== 'string') {
        fail('has a folder that is not a string');
        return;
      }
      for (const m of rule.folder.matchAll(PLACEHOLDER_RE)) {
        if (!(TEMPLATE_FIELDS as readonly string[]).includes(m[1])) {
          fail(`has an unknown folder field {${m[1]}}`);
          return;
        }
      }
      if (/[{}]/.test(rule.folder.replace(PLACEHOLDER_RE, ''))) {
        fail('has a folder with an unmatched brace');
        return;
      }
      folder = rule.folder;
    }
    let tags: string[] = [];
    if (rule.tags !== undefined) {
      if (!Array.isArray(rule.tags)) {
        fail('has tags that are not an array');
        return;
      }
      tags = [...new Set((rule.tags as readonly string[]).map((t) => t.trim()).filter((t) => t.length > 0))];
    }
    const pin = rule.pin === true;
    if (rule.pin !== undefined && typeof rule.pin !== 'boolean') {
      fail('has a pin that is not true or false');
      return;
    }
    if (folder === null && tags.length === 0 && !pin) {
      fail('has no folder, tags or pin');
      return;
    }
    rules.push({ index, role, agent, ticket, name, cwd, folder, tags, pin });
  });
  return { rules, problems };
}

export function ruleMatches(rule: CompiledRule, subject: RuleSubject, homedir: string): boolean {
  if (rule.role !== null && subject.role !== rule.role) {
    return false;
  }
  if (rule.agent !== null && subject.agent.toLowerCase() !== rule.agent) {
    return false;
  }
  if (rule.ticket !== null) {
    if (subject.ticket === null || subject.ticket.length === 0) {
      return false;
    }
    if (rule.ticket !== true && !testCapped(rule.ticket, subject.ticket)) {
      return false;
    }
  }
  if (rule.name !== null && !testCapped(rule.name, subject.name)) {
    return false;
  }
  if (rule.cwd !== null) {
    if (subject.cwd === null || subject.cwd.length === 0) {
      return false;
    }
    if (!matchGlobSegment(expandHome(rule.cwd, homedir), subject.cwd)) {
      return false;
    }
  }
  return true;
}

// The first rule, in file order, whose conditions all hold.
export function firstMatch(
  rules: readonly CompiledRule[],
  subject: RuleSubject,
  homedir: string,
): CompiledRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, subject, homedir)) {
      return rule;
    }
  }
  return null;
}

export type FolderExpansion =
  | { readonly kind: 'path'; readonly path: string }
  // A field the template uses is empty for this chat, so the chat is not filed.
  | { readonly kind: 'empty' }
  | { readonly kind: 'tooDeep' };

function fieldValue(subject: RuleSubject, field: TemplateField): string {
  switch (field) {
    case 'ticket':
      return subject.ticket ?? '';
    case 'title':
      return subject.fleetTitle;
    case 'agent':
      return subject.agent;
    case 'role':
      return subject.role ?? '';
    case 'subfolder':
      return subject.subfolder;
  }
}

// Expands a folder template. A field value never adds a level: its slashes become
// hyphens, and only a slash written in the template splits levels. The result is a
// slash path of at most two non-empty names (a folder and one sublevel), each within
// the folder name cap, so it passes the same checks as a folder created by hand.
export function expandFolderTemplate(template: string, subject: RuleSubject): FolderExpansion {
  let empty = false;
  // eslint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f]/g;
  const expanded = template.replace(PLACEHOLDER_RE, (_whole, field: string) => {
    const value = fieldValue(subject, field as TemplateField)
      .replace(controls, '')
      .replace(/[\\/]+/g, '-')
      .trim();
    if (value.length === 0) {
      empty = true;
    }
    return value;
  });
  if (empty) {
    return { kind: 'empty' };
  }
  const segments = splitFolderPath(expanded.replace(controls, '')).map((s) =>
    s.length > FOLDER_NAME_MAX ? s.slice(0, FOLDER_NAME_MAX).trim() : s,
  );
  if (segments.length === 0) {
    return { kind: 'empty' };
  }
  if (segments.length > MAX_FOLDER_CREATE_DEPTH + 1) {
    return { kind: 'tooDeep' };
  }
  return { kind: 'path', path: segments.join('/') };
}

// Builds the subjects from the scanned chats and the folded fleet entries. A chat with
// no fleet record still gets a subject, so name and cwd rules reach every chat.
export function buildRuleSubjects(
  chats: readonly { sessionId: string; title: string; cwd: string | null }[],
  entries: readonly FleetEntry[],
  workspaceRoot: string | null,
): RuleSubject[] {
  const byId = new Map<string, FleetEntry>();
  for (const e of entries) {
    byId.set(e.sessionId, e);
  }
  return chats.map((chat) => {
    const entry = byId.get(chat.sessionId) ?? null;
    const cwd = entry !== null && entry.cwd.length > 0 ? entry.cwd : chat.cwd;
    let subfolder = '';
    if (workspaceRoot !== null && cwd !== null && cwd.length > 0) {
      const rel = path.relative(workspaceRoot, cwd);
      if (rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
        subfolder = rel.split(path.sep).join('-');
      }
    }
    const ticket = entry !== null && entry.ticket !== null && entry.ticket.length > 0 ? entry.ticket : null;
    return {
      sessionId: chat.sessionId,
      title: chat.title,
      name: entry !== null && entry.name.length > 0 ? entry.name : chat.title,
      ticket,
      role: entry !== null ? entry.role : null,
      agent: entry !== null ? entry.agent : '',
      cwd,
      fleetTitle: entry !== null ? removeTicket(entry.name, ticket) : '',
      subfolder,
    };
  });
}

export interface PlanChatState {
  // The folder the chat is filed in, or null when unfiled or the folder is gone.
  readonly folderId: string | null;
  // You moved the chat to Unsorted by hand, so a rule must leave it there.
  readonly unsortedByHand?: boolean;
  readonly tagIds: readonly string[];
  readonly starred: boolean;
}

export interface PlanMove {
  readonly sessionId: string;
  readonly title: string;
  // Slash path of the current folder, null when unfiled.
  readonly fromFolder: string | null;
  // Slash path of the target folder, null when the folder does not change.
  readonly toFolder: string | null;
  // True when the target folder does not exist yet and Apply creates it.
  readonly createsFolder: boolean;
  // Tag labels the chat does not carry yet.
  readonly tagsAdded: readonly string[];
  readonly pin: boolean;
  readonly ruleIndex: number;
}

export interface OrganizePlan {
  readonly moves: readonly PlanMove[];
  // Chats at least one rule matched, moved or not.
  readonly matched: number;
  // Matched chats left alone because they were filed by hand.
  readonly skippedHandFiled: number;
  readonly problems: readonly string[];
}

export interface PlanInput {
  readonly chats: readonly { readonly subject: RuleSubject; readonly state: PlanChatState }[];
  readonly folders: { readonly [id: string]: Folder };
  readonly tags: { readonly [id: string]: Tag };
  readonly rules: readonly CompiledRule[];
  // chatId to the folder the last Apply chose for it.
  readonly applied: { readonly [chatId: string]: string };
  readonly homedir: string;
}

export function folderPathOf(folders: { readonly [id: string]: Folder }, folderId: string | null): string | null {
  if (folderId === null) {
    return null;
  }
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = folderId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const folder: Folder | undefined = folders[cursor];
    if (folder === undefined) {
      break;
    }
    names.unshift(folder.name);
    cursor = folder.parentId;
  }
  return names.length === 0 ? null : names.join('/');
}

// The existing folder a slash path names, or null when some level is missing.
export function resolveFolderPath(folders: { readonly [id: string]: Folder }, folderPath: string): string | null {
  let parentId: string | null = null;
  for (const segment of splitFolderPath(folderPath)) {
    const found: Folder | null = findChildByName(folders as { [id: string]: Folder }, parentId, segment);
    if (found === null) {
      return null;
    }
    parentId = found.id;
  }
  return parentId;
}

// Plans the backfill: for every chat, the first matching rule decides the folder, the
// tags to add and whether to pin. A chat filed by hand (it has a folder that is not the
// one the last Apply chose, or you moved it to Unsorted) is never planned, so a rule cannot
// undo a hand move.
export function planOrganize(input: PlanInput): OrganizePlan {
  const moves: PlanMove[] = [];
  const problems: string[] = [];
  let matched = 0;
  let skippedHandFiled = 0;
  const reportedDeep = new Set<number>();
  for (const { subject, state } of input.chats) {
    const rule = firstMatch(input.rules, subject, input.homedir);
    if (rule === null) {
      continue;
    }
    matched++;
    const handFiled = state.folderId !== null && input.applied[subject.sessionId] !== state.folderId;
    if (handFiled || (state.folderId === null && state.unsortedByHand === true)) {
      skippedHandFiled++;
      continue;
    }
    let toFolder: string | null = null;
    let createsFolder = false;
    if (rule.folder !== null) {
      const expansion = expandFolderTemplate(rule.folder, subject);
      if (expansion.kind === 'tooDeep') {
        if (!reportedDeep.has(rule.index)) {
          reportedDeep.add(rule.index);
          problems.push(`rules[${rule.index}] folder expands to more than two levels; chats it matches are not filed.`);
        }
      } else if (expansion.kind === 'path') {
        const existing = resolveFolderPath(input.folders, expansion.path);
        if (existing === null) {
          toFolder = expansion.path;
          createsFolder = true;
        } else if (existing !== state.folderId) {
          toFolder = expansion.path;
        }
      }
    }
    const have = new Set(
      state.tagIds.map((id) => input.tags[id]?.label.toLowerCase()).filter((l): l is string => l !== undefined),
    );
    const tagsAdded = rule.tags.filter((label) => !have.has(label.toLowerCase()));
    const pin = rule.pin && !state.starred;
    if (toFolder === null && tagsAdded.length === 0 && !pin) {
      continue;
    }
    moves.push({
      sessionId: subject.sessionId,
      title: subject.title,
      fromFolder: folderPathOf(input.folders, state.folderId),
      toFolder,
      createsFolder,
      tagsAdded,
      pin,
      ruleIndex: rule.index,
    });
  }
  return { moves, matched, skippedHandFiled, problems };
}

export interface UndoChatState {
  readonly folderId: string | null;
  readonly tagIds: readonly string[];
  readonly starred: boolean;
}

export interface UndoAction {
  readonly sessionId: string;
  // The folder to restore, or undefined when Apply left the folder alone.
  readonly folderId?: string | null;
  // The folder the chat was filed in by an earlier Apply, which Undo gives back to the
  // record of Apply-made placements.
  readonly appliedFolderId?: string;
  readonly removeTagIds: readonly string[];
  readonly unstar: boolean;
}

export interface UndoPlan {
  readonly actions: readonly UndoAction[];
  // Chats the user changed since Apply; Undo leaves them as they are.
  readonly skipped: readonly string[];
  readonly removeFolderIds: readonly string[];
  readonly removeTagIds: readonly string[];
}

// Plans Undo from the last Apply's snapshot and the current curation state.
export function planUndo(
  ledger: OrganizeLedger,
  chats: { readonly [chatId: string]: UndoChatState | undefined },
  folders: { readonly [id: string]: Folder },
  tags: { readonly [id: string]: Tag },
): UndoPlan {
  const actions: UndoAction[] = [];
  const skipped: string[] = [];
  // The folder and tags each chat holds once the actions run.
  const afterFolder = new Map<string, string | null>();
  const afterTags = new Map<string, Set<string>>();
  for (const [chatId, state] of Object.entries(chats)) {
    if (state !== undefined) {
      afterFolder.set(chatId, state.folderId);
      afterTags.set(chatId, new Set(state.tagIds));
    }
  }
  for (const [chatId, entry] of Object.entries(ledger.snapshot)) {
    const state = chats[chatId];
    if (state === undefined) {
      continue;
    }
    const folderChanged = entry.folderId !== null && state.folderId !== entry.folderId;
    const starChanged = entry.pinned && !state.starred;
    if (folderChanged || starChanged) {
      skipped.push(chatId);
      continue;
    }
    const removeTagIds = entry.tagsAdded.filter((id) => state.tagIds.includes(id));
    const action: { -readonly [K in keyof UndoAction]: UndoAction[K] } = {
      sessionId: chatId,
      removeTagIds,
      unstar: entry.pinned,
    };
    if (entry.folderId !== null) {
      const prior = entry.priorFolderId !== null && folders[entry.priorFolderId] !== undefined ? entry.priorFolderId : null;
      action.folderId = prior;
      if (prior !== null) {
        action.appliedFolderId = prior;
      }
      afterFolder.set(chatId, prior);
    }
    for (const id of removeTagIds) {
      afterTags.get(chatId)?.delete(id);
    }
    actions.push(action);
  }
  const removedFolders = new Set<string>();
  const removeFolderIds: string[] = [];
  for (const folderId of [...ledger.createdFolderIds].reverse()) {
    if (folders[folderId] === undefined) {
      continue;
    }
    const hasChat = [...afterFolder.values()].some((f) => f === folderId);
    const hasChild = Object.values(folders).some((f) => f.parentId === folderId && !removedFolders.has(f.id));
    if (!hasChat && !hasChild) {
      removedFolders.add(folderId);
      removeFolderIds.push(folderId);
    }
  }
  const removeTagIds: string[] = [];
  for (const tagId of ledger.createdTagIds) {
    if (tags[tagId] === undefined) {
      continue;
    }
    if (![...afterTags.values()].some((set) => set.has(tagId))) {
      removeTagIds.push(tagId);
    }
  }
  return { actions, skipped, removeFolderIds, removeTagIds };
}
