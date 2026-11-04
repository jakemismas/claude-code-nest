import { MetadataStore } from '../store/metadataStore';
import { Folder } from '../store/schema';
import {
  descendantFolderIds,
  expandFolderPath,
  findChildByName,
  folderDepthOf,
  splitFolderPath,
  MAX_FOLDER_CREATE_DEPTH,
  UNFILED_LABEL,
} from '../model/folderTree';
import { assertMintableId } from '../model/idFactory';
import { FolderItem, ChatMemberItem } from '../views/foldersProvider';

// The Folders-view commands: create (with slash-path expansion), rename, delete and assign-a-chat-to-a-folder, written through MetadataStore with one view refresh.
// Typing 'Work/ClientA' expands at create time into a chain of real Folder records, reusing existing segments by (parentId, name), so Folder.name never holds a '/'.

export const CREATE_FOLDER_COMMAND = 'claudeNest.createFolder';
export const RENAME_FOLDER_COMMAND = 'claudeNest.renameFolder';
export const DELETE_FOLDER_COMMAND = 'claudeNest.deleteFolder';
export const ASSIGN_CHAT_TO_FOLDER_COMMAND = 'claudeNest.assignChatToFolder';

// The injectable seam for prompts and confirmations; extension.ts wires the real window methods and tests supply fakes.
export interface FolderCommandUi {
  prompt(options: {
    title: string;
    placeholder?: string;
    value?: string;
    validateInput?: (value: string) => string | null;
  }): Thenable<string | undefined>;
  confirmWarning(message: string, confirmLabel: string): Thenable<boolean>;
  pickFolder(
    items: { label: string; description?: string; folderId: string | null }[],
    placeholder: string,
  ): Thenable<{ folderId: string | null } | undefined>;
  showError(message: string): void;
}

export interface FolderCommandDeps {
  store: MetadataStore;
  // Only refresh() is used; the wiring passes a closure that also schedules the opt-in auto-export snapshot.
  provider: { refresh(): void };
  // Resolve the project key on demand so a project created after activation still resolves.
  getProjectKey: () => string | undefined;
  ui: FolderCommandUi;
}

// Create a folder from a possibly slash-nested name. parentFolderItem roots the chain under a clicked folder; presetName skips the prompt (the in-panel popover).
// Returns the leaf folder id, or null on cancel, no project, or nothing creatable under the depth cap.
// MAX_FOLDER_CREATE_DEPTH limits the tree to one visible sublevel: creating under a folder at the cap is refused and a deeper path is clamped. Existing deeper folders are untouched.
export async function createFolder(
  deps: FolderCommandDeps,
  parentFolderItem?: FolderItem,
  presetName?: string,
): Promise<string | null> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return null;
  }

  const meta = store.getProjectMeta(projectKey);
  const startParentId = parentFolderItem ? parentFolderItem.folderId : null;

  // Refuse to create under a parent already at the deepest creatable level, so no over-deep folder is minted.
  if (startParentId !== null && folderDepthOf(meta.folders, startParentId) >= MAX_FOLDER_CREATE_DEPTH) {
    ui.showError('Folders nest one level deep. Create this folder at the top level instead.');
    return null;
  }

  let raw: string | undefined;
  if (presetName !== undefined) {
    // The popover already validated a non-empty name; still guard the expansion.
    if (splitFolderPath(presetName).length === 0) {
      return null;
    }
    raw = presetName;
  } else {
    raw = await ui.prompt({
      title: 'New Folder',
      placeholder: 'Name, or a slash path like Work/ClientA',
      validateInput: (value) =>
        splitFolderPath(value).length === 0
          ? 'Enter a folder name (slashes create nested folders).'
          : null,
    });
    if (raw === undefined) {
      return null;
    }
    if (splitFolderPath(raw).length === 0) {
      return null;
    }
  }

  // Root the expansion at the clicked folder's id (startParentId) rather than re-matching its name path, which could pick the first same-named sibling since renameFolder permits collisions. maxDepth clamps a deep path.
  const result = expandFolderPath(raw, meta.folders, {
    startParentId,
    maxDepth: MAX_FOLDER_CREATE_DEPTH,
  });
  if (result.chain.length === 0) {
    // The whole path was over the cap (nothing mintable). Nothing to persist.
    return null;
  }
  // Persist every segment; reused ones are re-upserted idempotently. assertMintableId re-checks ids at the write boundary.
  for (const segment of result.chain) {
    assertMintableId(segment.folder.id, 'folder id');
    store.upsertFolder(projectKey, segment.folder);
  }
  await store.flush();
  provider.refresh();
  return result.leafFolderId;
}

// Rename a folder's own segment only; a slash is rejected because a rename targets one node, not a re-parenting.
export async function renameFolder(
  deps: FolderCommandDeps,
  folderItem: FolderItem,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const meta = store.getProjectMeta(projectKey);
  const current = meta.folders[folderItem.folderId];
  if (current === undefined) {
    ui.showError('That folder no longer exists.');
    return;
  }

  const next = await ui.prompt({
    title: 'Rename Folder',
    value: current.name,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Enter a folder name.';
      }
      if (trimmed.includes('/')) {
        return 'A rename sets one name; use New Folder to create nested folders.';
      }
      // Reject a name that collides with a sibling: the (parentId, name) reuse key and the assign picker rely on sibling-name uniqueness.
      const sibling = findChildByName(meta.folders, current.parentId, trimmed);
      if (sibling !== null && sibling.id !== current.id) {
        return 'A folder with that name already exists here.';
      }
      return null;
    },
  });
  if (next === undefined) {
    return;
  }
  const trimmed = next.trim();
  if (trimmed.length === 0 || trimmed === current.name) {
    return;
  }

  const updated: Folder = { ...current, name: trimmed };
  store.upsertFolder(projectKey, updated);
  await store.flush();
  provider.refresh();
}

// Delete a folder and every descendant after confirmation, unfiling every chat homed in the subtree. Chats are never deleted.
export async function deleteFolder(
  deps: FolderCommandDeps,
  folderItem: FolderItem,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const meta = store.getProjectMeta(projectKey);
  const target = meta.folders[folderItem.folderId];
  if (target === undefined) {
    return;
  }

  const cascade = descendantFolderIds(meta.folders, folderItem.folderId);
  const extra = cascade.length - 1;
  const detail =
    extra > 0
      ? ` and ${extra} nested folder${extra === 1 ? '' : 's'}`
      : '';
  const confirmed = await ui.confirmWarning(
    `Delete folder "${target.name}"${detail}? Chats inside move to ${UNFILED_LABEL}; ` +
      `no chats are deleted.`,
    'Delete',
  );
  if (!confirmed) {
    return;
  }

  // Coalesce the cascade into one debounced write and refresh once; deleting every descendant id covers nested members.
  for (const id of cascade) {
    store.deleteFolder(projectKey, id);
  }
  await store.flush();
  provider.refresh();
}

// Assign a chat to a folder from the context menu, with an Unfiled choice to move it out. The chat arrives as a member item or a bare sessionId.
export async function assignChatToFolder(
  deps: FolderCommandDeps,
  target: ChatMemberItem | string,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const chatId = typeof target === 'string' ? target : target.record.sessionId;

  const meta = store.getProjectMeta(projectKey);
  const items = folderPickItems(meta.folders);
  // The first item is the unfile choice; the rest are real folders by path.
  const choice = await ui.pickFolder(items, 'Move chat to folder');
  if (choice === undefined) {
    return;
  }
  store.setChatFolder(projectKey, chatId, choice.folderId, true);
  await store.flush();
  provider.refresh();
}

// Build a folder's slash path by walking its parents to the root, bounded by a visited set against a cyclic chain.
export function folderPathFor(
  folders: { [id: string]: Folder },
  folderId: string,
): string {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: string | null = folderId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const folder: Folder | undefined = folders[current];
    if (folder === undefined) {
      break;
    }
    segments.unshift(folder.name);
    current = folder.parentId;
  }
  return segments.join('/');
}

// The assign-to-folder picker items: an Unfiled choice first, then every folder by its full slash path, sorted alphabetically.
function folderPickItems(folders: {
  [id: string]: Folder;
}): { label: string; description?: string; folderId: string | null }[] {
  const items: { label: string; description?: string; folderId: string | null }[] = [
    { label: `$(inbox) ${UNFILED_LABEL}`, description: 'Move out of any folder', folderId: null },
  ];
  const folderItems = Object.values(folders)
    .map((folder) => ({
      label: '$(folder) ' + folderPathFor(folders, folder.id),
      folderId: folder.id as string | null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return items.concat(folderItems);
}
