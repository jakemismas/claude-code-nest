// Organize rules: Preview, Apply and Undo. No vscode import. Preview reads only. Apply and
// Undo write through the metadata store like a hand move, after the reconcile barrier, so
// a foreign sync write is classified before any change is staged. The undo snapshot lives
// in the store's never-synced local area.
import { MAX_FOLDER_CREATE_DEPTH, expandFolderPath } from '../model/folderTree';
import { mintTagId } from '../model/idFactory';
import { NestRule } from '../fleet/nestConfig';
import {
  OrganizePlan,
  PlanChatState,
  PlanMove,
  RuleSubject,
  compileRules,
  planOrganize,
  planUndo,
} from '../fleet/rules';
import { MetadataStore } from '../store/metadataStore';
import { OrganizeLedger, OrganizeLedgerEntry, ProjectMeta, Tag, isValidColor } from '../store/schema';

export const ORGANIZE_PREVIEW_COMMAND = 'claudeNest.organizePreview';
export const ORGANIZE_APPLY_COMMAND = 'claudeNest.organizeApply';
export const ORGANIZE_UNDO_COMMAND = 'claudeNest.organizeUndo';

export interface OrganizeDeps {
  readonly store: MetadataStore;
  readonly getProjectKey: () => string | undefined;
  // Every chat a rule can reach, with the facts rules match on. Archived chats excluded.
  readonly getSubjects: () => readonly RuleSubject[];
  readonly getRules: () => readonly NestRule[];
  // Tag name to hex color from the layout file, used for tags Apply creates.
  readonly getTagColors: () => { readonly [name: string]: string };
  readonly homedir: string;
  // Resolves once a foreign sync write has been reconciled. Every write awaits it first.
  readonly barrier: () => Promise<void>;
  // Re-renders the views and schedules the opt-in export.
  readonly refresh: () => void;
}

export type OrganizeKind = 'preview' | 'applied' | 'undone' | 'error';

export interface OrganizeReport {
  readonly kind: OrganizeKind;
  readonly moves: readonly PlanMove[];
  readonly matched: number;
  readonly skippedHandFiled: number;
  readonly rulesActive: number;
  readonly problems: readonly string[];
  readonly canUndo: boolean;
  // Chats the last Apply changed, i.e. what Undo would revert.
  readonly undoCount: number;
  // Chats Undo left alone because the user changed them since.
  readonly skippedOnUndo: number;
  readonly message: string;
}

function chatStateOf(meta: ProjectMeta, chatId: string): PlanChatState {
  const chat = meta.chats[chatId];
  const folderId = chat !== undefined && chat.folderId !== null && meta.folders[chat.folderId] !== undefined ? chat.folderId : null;
  return { folderId, tagIds: chat?.tags ?? [], starred: chat?.starred === true };
}

function emptyReport(kind: OrganizeKind, message: string, deps: OrganizeDeps, projectKey: string | undefined): OrganizeReport {
  const ledger = projectKey === undefined ? null : deps.store.getOrganizeLedger(projectKey);
  const undoCount = ledger === null ? 0 : Object.keys(ledger.snapshot).length;
  return {
    kind,
    moves: [],
    matched: 0,
    skippedHandFiled: 0,
    rulesActive: 0,
    problems: [],
    canUndo: undoCount > 0,
    undoCount,
    skippedOnUndo: 0,
    message,
  };
}

interface Computed {
  readonly plan: OrganizePlan;
  readonly rulesActive: number;
  readonly problems: string[];
  readonly meta: ProjectMeta;
  readonly ledger: OrganizeLedger | null;
}

function compute(deps: OrganizeDeps, projectKey: string): Computed {
  const compiled = compileRules(deps.getRules());
  const meta = deps.store.getProjectMeta(projectKey);
  const ledger = deps.store.getOrganizeLedger(projectKey);
  const plan = planOrganize({
    chats: deps.getSubjects().map((subject) => ({ subject, state: chatStateOf(meta, subject.sessionId) })),
    folders: meta.folders,
    tags: meta.tags,
    rules: compiled.rules,
    applied: ledger?.applied ?? {},
    homedir: deps.homedir,
  });
  return { plan, rulesActive: compiled.rules.length, problems: [...compiled.problems, ...plan.problems], meta, ledger };
}

function reportFrom(kind: OrganizeKind, message: string, c: Computed, extra?: { undoCount?: number; canUndo?: boolean; skippedOnUndo?: number }): OrganizeReport {
  const undoCount = extra?.undoCount ?? (c.ledger === null ? 0 : Object.keys(c.ledger.snapshot).length);
  return {
    kind,
    moves: c.plan.moves,
    matched: c.plan.matched,
    skippedHandFiled: c.plan.skippedHandFiled,
    rulesActive: c.rulesActive,
    problems: c.problems,
    canUndo: extra?.canUndo ?? undoCount > 0,
    undoCount,
    skippedOnUndo: extra?.skippedOnUndo ?? 0,
    message,
  };
}

const NO_PROJECT = 'No Claude Code project is resolved for this workspace yet.';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Lists every move the rules would make. Writes nothing.
export function previewOrganize(deps: OrganizeDeps): OrganizeReport {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return emptyReport('error', NO_PROJECT, deps, undefined);
  }
  const c = compute(deps, projectKey);
  const message =
    c.rulesActive === 0
      ? 'No active rules. Add rules to the layout file.'
      : c.plan.moves.length === 0
        ? 'Nothing to move. Every chat the rules match is already in place.'
        : `${plural(c.plan.moves.length, 'chat', 'chats')} would change.`;
  return reportFrom('preview', message, c);
}

// Files the planned chats, creating missing folders and tags, then records the undo
// snapshot. The plan is recomputed after the barrier so it reflects reconciled state.
export async function applyOrganize(deps: OrganizeDeps): Promise<OrganizeReport> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return emptyReport('error', NO_PROJECT, deps, undefined);
  }
  await deps.barrier();
  const c = compute(deps, projectKey);
  const { store } = deps;
  if (c.plan.moves.length === 0) {
    return reportFrom('applied', 'Nothing to apply.', c);
  }

  const folders = { ...c.meta.folders };
  const createdFolderIds: string[] = [];
  const createdTagIds: string[] = [];
  const folderIdByPath = new Map<string, string>();
  const tagIdByLabel = new Map<string, string>();
  for (const tag of Object.values(c.meta.tags)) {
    tagIdByLabel.set(tag.label.toLowerCase(), tag.id);
  }
  const colors = deps.getTagColors();

  const folderFor = (folderPath: string): string | null => {
    const known = folderIdByPath.get(folderPath);
    if (known !== undefined) {
      return known;
    }
    const result = expandFolderPath(folderPath, folders, { maxDepth: MAX_FOLDER_CREATE_DEPTH });
    if (result.leafFolderId === null || result.chain.length === 0) {
      return null;
    }
    for (const segment of result.chain) {
      if (segment.mintNew) {
        if (!store.upsertFolder(projectKey, segment.folder)) {
          return null;
        }
        folders[segment.folder.id] = segment.folder;
        createdFolderIds.push(segment.folder.id);
      }
    }
    folderIdByPath.set(folderPath, result.leafFolderId);
    return result.leafFolderId;
  };
  const tagFor = (label: string): string | null => {
    const known = tagIdByLabel.get(label.toLowerCase());
    if (known !== undefined) {
      return known;
    }
    const color = colors[label];
    const tag: Tag = { id: mintTagId(), label, ...(isValidColor(color) ? { color } : {}) };
    if (!store.upsertTag(projectKey, tag)) {
      return null;
    }
    createdTagIds.push(tag.id);
    tagIdByLabel.set(label.toLowerCase(), tag.id);
    return tag.id;
  };

  const snapshot: { [chatId: string]: OrganizeLedgerEntry } = {};
  const applied: { [chatId: string]: string } = { ...(c.ledger?.applied ?? {}) };
  for (const move of c.plan.moves) {
    const prior = chatStateOf(c.meta, move.sessionId);
    let targetFolderId: string | null = null;
    if (move.toFolder !== null) {
      targetFolderId = folderFor(move.toFolder);
    }
    const added: string[] = [];
    for (const label of move.tagsAdded) {
      const tagId = tagFor(label);
      if (tagId !== null && store.addChatTag(projectKey, move.sessionId, tagId)) {
        added.push(tagId);
      }
    }
    if (targetFolderId !== null && store.setChatFolder(projectKey, move.sessionId, targetFolderId)) {
      applied[move.sessionId] = targetFolderId;
    } else {
      targetFolderId = null;
    }
    let pinned = false;
    if (move.pin && store.setChatStarred(projectKey, move.sessionId, true)) {
      pinned = true;
    }
    if (targetFolderId !== null || added.length > 0 || pinned) {
      snapshot[move.sessionId] = { folderId: targetFolderId, priorFolderId: prior.folderId, tagsAdded: added, pinned };
    }
  }
  // Folders and tags an earlier Apply created stay listed, so Undo still removes them
  // once nothing uses them.
  const ledger: OrganizeLedger = {
    at: Date.now(),
    createdFolderIds: [...(c.ledger?.createdFolderIds ?? []), ...createdFolderIds],
    createdTagIds: [...(c.ledger?.createdTagIds ?? []), ...createdTagIds],
    snapshot,
    applied,
  };
  await store.setOrganizeLedger(projectKey, ledger);
  await store.flush();
  deps.refresh();
  const changed = Object.keys(snapshot).length;
  return {
    ...reportFrom('applied', `${plural(changed, 'chat', 'chats')} organized.`, c, { undoCount: changed, canUndo: changed > 0 }),
    moves: [],
  };
}

// Restores the last Apply's snapshot. A chat the user changed since is left alone; folders
// and tags Apply created are removed when nothing uses them any more.
export async function undoOrganize(deps: OrganizeDeps): Promise<OrganizeReport> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return emptyReport('error', NO_PROJECT, deps, undefined);
  }
  await deps.barrier();
  const { store } = deps;
  const ledger = store.getOrganizeLedger(projectKey);
  if (ledger === null || Object.keys(ledger.snapshot).length === 0) {
    return emptyReport('undone', 'There is nothing to undo.', deps, projectKey);
  }
  const meta = store.getProjectMeta(projectKey);
  const chats: { [chatId: string]: PlanChatState } = {};
  // Every chat counts when deciding whether a created folder or tag is still in use.
  for (const chatId of Object.keys(meta.chats)) {
    chats[chatId] = chatStateOf(meta, chatId);
  }
  for (const chatId of Object.keys(ledger.snapshot)) {
    if (chats[chatId] === undefined && meta.chats[chatId] !== undefined) {
      chats[chatId] = chatStateOf(meta, chatId);
    }
  }
  const plan = planUndo(ledger, chats, meta.folders, meta.tags);
  for (const action of plan.actions) {
    if (action.folderId !== undefined) {
      store.setChatFolder(projectKey, action.sessionId, action.folderId);
    }
    for (const tagId of action.removeTagIds) {
      store.removeChatTag(projectKey, action.sessionId, tagId);
    }
    if (action.unstar) {
      store.setChatStarred(projectKey, action.sessionId, false);
    }
  }
  for (const folderId of plan.removeFolderIds) {
    store.deleteFolder(projectKey, folderId);
  }
  for (const tagId of plan.removeTagIds) {
    store.deleteTag(projectKey, tagId);
  }
  // The snapshot is spent. Chats Undo skipped keep whatever the user set, so they are
  // treated as filed by hand from now on.
  const applied = { ...ledger.applied };
  for (const chatId of Object.keys(ledger.snapshot)) {
    delete applied[chatId];
  }
  const rest: OrganizeLedger = { at: ledger.at, createdFolderIds: [], createdTagIds: [], snapshot: {}, applied };
  await store.setOrganizeLedger(projectKey, Object.keys(applied).length > 0 ? rest : null);
  await store.flush();
  deps.refresh();
  const reverted = plan.actions.length;
  const message =
    plan.skipped.length > 0
      ? `${plural(reverted, 'chat', 'chats')} restored. ${plural(plan.skipped.length, 'chat', 'chats')} changed since and left alone.`
      : `${plural(reverted, 'chat', 'chats')} restored.`;
  return {
    kind: 'undone',
    moves: [],
    matched: 0,
    skippedHandFiled: 0,
    rulesActive: compileRules(deps.getRules()).rules.length,
    problems: [],
    canUndo: false,
    undoCount: 0,
    skippedOnUndo: plan.skipped.length,
    message,
  };
}

// The report the panel shows when it opens: no moves listed until Preview runs.
export function idleOrganizeReport(deps: OrganizeDeps): OrganizeReport {
  const projectKey = deps.getProjectKey();
  const compiled = compileRules(deps.getRules());
  const base = emptyReport('preview', '', deps, projectKey);
  return { ...base, rulesActive: compiled.rules.length, problems: compiled.problems };
}
