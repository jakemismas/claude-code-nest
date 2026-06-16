import { MetadataStore } from '../store/metadataStore';
import { Folder } from '../store/schema';
import {
  descendantFolderIds,
  expandFolderPath,
  findChildByName,
  splitFolderPath,
  UNFILED_LABEL,
} from '../model/folderTree';
import { assertMintableId } from '../model/idFactory';
import { FoldersProvider, FolderItem, ChatMemberItem } from '../views/foldersProvider';

// The Folders-view commands: create (with slash-path expansion), rename, delete,
// and assign-a-chat-to-a-folder. Every store mutation runs through MetadataStore
// (the synced ProjectMeta), and the view is refreshed ONCE after the store flush
// (refresh coalescing, ARCHITECTURE.md).
//
// Slash-path expansion (accepted patch, interpretation (b)): typing 'Work/ClientA'
// in the create command expands into a CHAIN of real parent-child Folder records,
// reusing any existing segment by (parentId, name) and minting only missing ones.
// No literal '/' is ever stored in a single Folder.name. The split happens HERE at
// create time, not at render time, so Folder.parentId stays meaningful for the
// delete cascade and getParent.

export const CREATE_FOLDER_COMMAND = 'claudeNest.createFolder';
export const RENAME_FOLDER_COMMAND = 'claudeNest.renameFolder';
export const DELETE_FOLDER_COMMAND = 'claudeNest.deleteFolder';
export const ASSIGN_CHAT_TO_FOLDER_COMMAND = 'claudeNest.assignChatToFolder';

// The injectable seam for the prompts and confirmations, so the command logic can
// be exercised without the real vscode UI. extension.ts wires the real window
// methods; a test (integration or a future host test) can supply fakes. The pure
// expansion/cascade logic itself already lives in the vscode-free model.
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
  provider: FoldersProvider;
  // Resolve the encoded project key ON DEMAND (mirroring scanChats), so a command
  // invoked after Claude Code created the project dir resolves it instead of acting
  // on a value frozen at activation. extension.ts wires this to
  // FoldersProvider.resolveProjectKey; a test supplies a fixed closure.
  getProjectKey: () => string | undefined;
  ui: FolderCommandUi;
}

// Create a folder from a (possibly slash-nested) name. parentFolderItem, when
// supplied (right-click "New Folder" on a folder row), prefixes the new chain
// under that folder. Returns the leaf folder id, or null when cancelled / no
// project.
export async function createFolder(
  deps: FolderCommandDeps,
  parentFolderItem?: FolderItem,
): Promise<string | null> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return null;
  }

  const raw = await ui.prompt({
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

  const meta = store.getProjectMeta(projectKey);
  // When created under an existing folder, root the expansion at the clicked
  // folder's AUTHORITATIVE id (startParentId), not by recomposing and re-matching
  // its name path. A name-path round-trip would resolve through findChildByName
  // and could attach the new child to the FIRST same-named sibling instead of the
  // folder the user actually clicked (sibling names are not unique: renameFolder
  // permits a collision). Passing the id directly removes that ambiguity.
  const result = expandFolderPath(raw, meta.folders, {
    startParentId: parentFolderItem ? parentFolderItem.folderId : null,
  });
  // Persist every segment record. mintNew segments are new; reused ones are
  // re-upserted idempotently (a no-op shape-wise). assertMintableId is the
  // id-factory guard re-run at the write boundary as defense in depth.
  for (const segment of result.chain) {
    assertMintableId(segment.folder.id, 'folder id');
    store.upsertFolder(projectKey, segment.folder);
  }
  await store.flush();
  provider.refresh();
  return result.leafFolderId;
}

// Rename a folder. Renames only the single segment (the folder's own name); it
// does not re-expand slashes, so typing a slash here is rejected (a rename targets
// one node, not a re-parenting). The cascade and getParent semantics are unchanged
// because parentId is untouched.
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
      // Reject a rename that would make this folder share (parentId, name) with a
      // sibling. Two same-named siblings break the (parentId, name) reuse key and
      // make a slash-path round-trip ambiguous, so the name path no longer
      // uniquely identifies a folder. The create command roots under a parent id
      // directly and is unaffected, but the assign-to-folder picker and any
      // name-based lookup still rely on sibling-name uniqueness, so the guard
      // belongs here at the source.
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

// Delete a folder and every descendant folder, after a confirmation. The store's
// deleteFolder detaches each member chat (sets folderId null) per folder; deleting
// the descendants bottom-up via the model's cascade set unfiles every chat that
// was homed anywhere in the subtree. Chats are never deleted.
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

  // Coalesce the cascade into the store's debounced single write, then refresh
  // once. deleteFolder unfiles the folder's own member chats; deleting every
  // descendant id covers nested members too.
  for (const id of cascade) {
    store.deleteFolder(projectKey, id);
  }
  await store.flush();
  provider.refresh();
}

// Assign a chat to a folder via the context menu. Presents the folder list (plus
// an Unfiled / "Move out of folder" choice) and sets the chat's single home. The
// chat node may arrive as a ChatMemberItem (right-clicked in this view) or as a
// bare sessionId (invoked from another surface).
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
  store.setChatFolder(projectKey, chatId, choice.folderId);
  await store.flush();
  provider.refresh();
}

// Build the slash path of a folder by walking its parent chain to the root. Used
// to prefix a child create and to label folders in the assign picker. Bounded by a
// visited set against a corrupt cyclic parent chain.
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

// The assign-to-folder picker items: an Unfiled choice first, then every folder by
// its full slash path, sorted alphabetically for a stable list.
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
