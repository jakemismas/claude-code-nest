// Pure model for the Folders view: slash-path expansion into real parent-child Folder
// records, single-home tree assembly, the synthetic Unfiled bucket, and the chat node id
// `${folderId}#${chatId}`. No vscode dependency, so the unit suite runs headless.

import { Folder } from '../store/schema';
import { mintFolderId } from './idFactory';

// Sentinel for chats with no home folder; it is outside the id factory's mintable space.
export const UNFILED_FOLDER_ID = '__unfiled__';
export const UNFILED_LABEL = 'Unfiled';

// Separator for nested folder names: 'Work/ClientA' becomes Work with a ClientA child.
export const FOLDER_PATH_SEPARATOR = '/';

// Depths are 0-based: a root is 0, its direct child is 1.
// Creation allows one sublevel. Rendering tolerates one level deeper so legacy or synced
// deeper folders stay visible; the clamp applies to display only and never alters parentId.
export const MAX_FOLDER_CREATE_DEPTH = 1;
export const MAX_FOLDER_RENDER_DEPTH = 2;

// Clamps display depth to MAX_FOLDER_RENDER_DEPTH; a negative or non-finite depth becomes 0.
export function clampFolderDepth(depth: number): number {
  if (!Number.isFinite(depth) || depth < 0) {
    return 0;
  }
  return depth > MAX_FOLDER_RENDER_DEPTH ? MAX_FOLDER_RENDER_DEPTH : depth;
}

// 0-based depth of a folder in the stored hierarchy. A visited set stops a corrupt cyclic
// parent chain; an unknown id counts as a root.
export function folderDepthOf(
  folders: { [id: string]: Folder },
  folderId: string | null,
): number {
  let depth = 0;
  const visited = new Set<string>();
  let current: string | null = folderId;
  while (current !== null && !visited.has(current)) {
    const folder: Folder | undefined = folders[current];
    if (folder === undefined) {
      break;
    }
    visited.add(current);
    const parentId: string | null = folder.parentId ?? null;
    if (parentId === null) {
      break;
    }
    depth += 1;
    current = parentId;
  }
  return depth;
}

// A folder node with its child folders and the chats homed directly in it. The Unfiled
// bucket is a node with id UNFILED_FOLDER_ID and a null folder.
export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  // Null for the synthetic Unfiled node.
  folder: Folder | null;
  synthetic: boolean;
  childFolders: FolderNode[];
  // Chats homed directly here, not under a child.
  chatIds: string[];
}

// Splits a path into trimmed non-empty segments, so stray slashes create no blank folders.
export function splitFolderPath(rawPath: string): string[] {
  return rawPath
    .split(FOLDER_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// One record from a slash-path expansion; mintNew is false when an existing folder was
// reused.
export interface ExpandedSegment {
  folder: Folder;
  mintNew: boolean;
}

// The segment chain, root first, and the leaf folder id (null when the path has no segments).
export interface ExpandResult {
  chain: ExpandedSegment[];
  leafFolderId: string | null;
}

// Expands a slash path into a chain of Folder records, reusing an existing segment matched
// by (parentId, name) and minting only missing ones. startParentId roots the chain under a
// known folder id: matching by id avoids resolving the wrong same-named sibling. The chain
// excludes the startParentId folder itself.
export function expandFolderPath(
  rawPath: string,
  existing: { [id: string]: Folder },
  options: {
    mint?: () => string;
    orderFor?: (parentId: string | null) => number;
    startParentId?: string | null;
    // Maximum depth for NEWLY minted segments. Reused deeper segments are never blocked.
    // Omit for no cap.
    maxDepth?: number;
  } = {},
): ExpandResult {
  const mint = options.mint ?? mintFolderId;
  const orderFor = options.orderFor ?? defaultOrderFor(existing);
  const startParentId = options.startParentId ?? null;
  const maxDepth = options.maxDepth;

  const segments = splitFolderPath(rawPath);
  if (segments.length === 0) {
    return { chain: [], leafFolderId: null };
  }

  // Grows as segments are minted so a later segment can match one minted earlier.
  const working: { [id: string]: Folder } = { ...existing };
  const chain: ExpandedSegment[] = [];
  let parentId: string | null = startParentId;
  // Depth of the next segment to place.
  let nextDepth = startParentId === null ? 0 : folderDepthOf(existing, startParentId) + 1;

  for (const name of segments) {
    const match = findChildByName(working, parentId, name);
    if (match !== null) {
      chain.push({ folder: match, mintNew: false });
      parentId = match.id;
      nextDepth += 1;
      continue;
    }
    // Stop minting once the next segment would exceed the depth cap; the leaf is then the
    // deepest segment placed.
    if (maxDepth !== undefined && nextDepth > maxDepth) {
      break;
    }
    const folder: Folder = {
      id: mint(),
      name,
      parentId,
      order: orderFor(parentId),
    };
    working[folder.id] = folder;
    chain.push({ folder, mintNew: true });
    parentId = folder.id;
    nextDepth += 1;
  }

  return { chain, leafFolderId: parentId };
}

// Exact, case-sensitive match among the direct children of parentId. Returns null when none.
export function findChildByName(
  folders: { [id: string]: Folder },
  parentId: string | null,
  name: string,
): Folder | null {
  for (const folder of Object.values(folders)) {
    if (folder.parentId === parentId && folder.name === name) {
      return folder;
    }
  }
  return null;
}

// Order for a new child: one past the current sibling count.
function defaultOrderFor(
  existing: { [id: string]: Folder },
): (parentId: string | null) => number {
  return (parentId) => {
    let count = 0;
    for (const folder of Object.values(existing)) {
      if (folder.parentId === parentId) {
        count++;
      }
    }
    return count;
  };
}

// Inputs to tree assembly. chatHomes maps a sessionId to its folder id; null or absent
// means Unfiled.
export interface AssembleInput {
  folders: { [id: string]: Folder };
  chatHomes: { [chatId: string]: string | null | undefined };
}

// Top-level folder nodes, then the Unfiled node, which is always present so the view can
// hide it when empty.
export interface AssembledTree {
  roots: FolderNode[];
  unfiled: FolderNode;
}

// Every chat lands under exactly one folder. A null home or a dangling home id goes to
// Unfiled, so no chat is dropped or duplicated.
export function assembleFolderTree(input: AssembleInput): AssembledTree {
  const { folders, chatHomes } = input;

  const nodesById = new Map<string, FolderNode>();
  for (const folder of Object.values(folders)) {
    nodesById.set(folder.id, {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      folder,
      synthetic: false,
      childFolders: [],
      chatIds: [],
    });
  }

  const unfiled: FolderNode = {
    id: UNFILED_FOLDER_ID,
    name: UNFILED_LABEL,
    parentId: null,
    folder: null,
    synthetic: true,
    childFolders: [],
    chatIds: [],
  };

  // A folder with a dangling or self parentId becomes a root so it is not orphaned.
  const roots: FolderNode[] = [];
  for (const node of nodesById.values()) {
    const parentId = node.parentId;
    const parent =
      parentId !== null && parentId !== node.id ? nodesById.get(parentId) : undefined;
    if (parent) {
      parent.childFolders.push(node);
    } else {
      roots.push(node);
    }
  }

  // A dangling home id routes to Unfiled.
  for (const [chatId, home] of Object.entries(chatHomes)) {
    const target =
      typeof home === 'string' && nodesById.has(home)
        ? (nodesById.get(home) as FolderNode)
        : unfiled;
    target.chatIds.push(chatId);
  }

  sortTree(roots);
  sortChildFolders(unfiled);

  return { roots, unfiled };
}

// Builds the chatId to owning folderId map. Unfiled chats map to the Unfiled sentinel so
// a reveal by chat still resolves a parent.
export function buildChatHomeIndex(tree: AssembledTree): Map<string, string> {
  const into = new Map<string, string>();
  indexChatHomesInto(tree.roots, into);
  for (const chatId of tree.unfiled.chatIds) {
    into.set(chatId, tree.unfiled.id);
  }
  return into;
}

// Owning folder id for a chat, falling back to hint (default Unfiled) so a chat missing
// from the index still has a parent.
export function resolveChatHomeFolderId(
  index: Map<string, string>,
  chatId: string,
  hint: string = UNFILED_FOLDER_ID,
): string {
  return index.get(chatId) ?? hint;
}

// VSCode caches tree elements by object reference, so a refresh must reuse the node for
// an unchanged id. These predicates decide whether a cached node is still valid.
// A rename must rebuild the node so the label updates.
export function canReuseFolderItem(
  cachedName: string | undefined,
  currentName: string,
): boolean {
  return cachedName !== undefined && cachedName === currentName;
}

// Reuse only when title and timestamp both match; timestamp can be null.
export function canReuseChatMemberItem(
  cached: { title: string; timestamp: number | null } | undefined,
  current: { title: string; timestamp: number | null },
): boolean {
  return (
    cached !== undefined &&
    cached.title === current.title &&
    cached.timestamp === current.timestamp
  );
}

function indexChatHomesInto(nodes: FolderNode[], into: Map<string, string>): void {
  for (const node of nodes) {
    for (const chatId of node.chatIds) {
      into.set(chatId, node.id);
    }
    indexChatHomesInto(node.childFolders, into);
  }
}

// Sorts siblings by (order, name) recursively. Chats within a folder keep caller order;
// the view sorts them using data outside this model.
function sortTree(nodes: FolderNode[]): void {
  nodes.sort(compareFolderNodes);
  for (const node of nodes) {
    sortChildFolders(node);
  }
}

function sortChildFolders(node: FolderNode): void {
  node.childFolders.sort(compareFolderNodes);
  for (const child of node.childFolders) {
    sortChildFolders(child);
  }
}

function compareFolderNodes(a: FolderNode, b: FolderNode): number {
  const ao = a.folder ? a.folder.order : 0;
  const bo = b.folder ? b.folder.order : 0;
  if (ao !== bo) {
    return ao - bo;
  }
  return a.name.localeCompare(b.name);
}

const CHAT_NODE_SEPARATOR = '#';

export function chatNodeId(folderId: string, chatId: string): string {
  return folderId + CHAT_NODE_SEPARATOR + chatId;
}

// Splits on the FIRST '#' because folder ids never contain one. Returns null when the id
// has no separator or an empty side.
export function parseChatNodeId(
  nodeId: string,
): { folderId: string; chatId: string } | null {
  const idx = nodeId.indexOf(CHAT_NODE_SEPARATOR);
  if (idx <= 0 || idx === nodeId.length - 1) {
    return null;
  }
  return {
    folderId: nodeId.slice(0, idx),
    chatId: nodeId.slice(idx + 1),
  };
}

// True when a folder id names the synthetic Unfiled bucket.
export function isUnfiledId(folderId: string): boolean {
  return folderId === UNFILED_FOLDER_ID;
}

// A folder and all its descendants, for cascade delete. A visited set stops a cyclic
// parentId chain.
export function descendantFolderIds(
  folders: { [id: string]: Folder },
  rootId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of Object.values(folders)) {
    if (folder.parentId !== null) {
      const list = childrenByParent.get(folder.parentId) ?? [];
      list.push(folder.id);
      childrenByParent.set(folder.parentId, list);
    }
  }
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    result.push(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!visited.has(childId)) {
        stack.push(childId);
      }
    }
  }
  return result;
}
