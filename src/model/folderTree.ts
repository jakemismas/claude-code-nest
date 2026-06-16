// folderTree: the PURE model behind the Folders view. It owns slash-path
// expansion (interpretation (b): a slash name expands into a CHAIN of real
// parent-child Folder records, never a literal '/' inside one Folder.name), the
// single-home assembly of a nested tree from flat Folder records, the synthetic
// Unfiled bucket, and the composite-id grammar for chat member nodes.
//
// This module is vscode-free (build contract): no vscode import, no filesystem.
// The view layer (foldersProvider.ts) renders the structures produced here into
// TreeItems and memoizes node objects; this module produces only plain data.
//
// Composite-id grammar (ARCHITECTURE.md "Tree and VSCode API binding rules"):
//   chat member node id = `${folderId}#${chatId}`
// folderId is separator-free (minted by idFactory or the '__unfiled__' sentinel)
// and chatId is a separator-free UUID, so the id splits unambiguously on the
// FIRST '#' back to its owning folder id. getParent for a chat node recovers
// exactly that one owning folder id.

import { Folder } from '../store/schema';
import { mintFolderId } from './idFactory';

// The Folders-view synthetic bucket for every chat with no home folder
// (ChatMeta.folderId null or absent). The sentinel mirrors the '__untagged__'
// convention (PLAN.md slice 3) and is excluded from the id factory's mintable
// space (idFactory.RESERVED_SENTINELS), so a real folder can never collide with
// it.
export const UNFILED_FOLDER_ID = '__unfiled__';
export const UNFILED_LABEL = 'Unfiled';

// The path separator used when a user types a nested folder name. 'Work/ClientA'
// expands into a Work folder (parentId null) with a ClientA child.
export const FOLDER_PATH_SEPARATOR = '/';

// One node in the assembled folder hierarchy. A folder node carries its Folder
// record and its child folder nodes plus the ids of the chats homed directly in
// it. The Unfiled bucket is represented as a folder node with id
// UNFILED_FOLDER_ID and a null record (it has no stored Folder).
export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  // The stored Folder this node renders, or null for the synthetic Unfiled node.
  folder: Folder | null;
  // Whether this is the synthetic Unfiled bucket.
  synthetic: boolean;
  childFolders: FolderNode[];
  // sessionIds of chats homed directly under this folder (not under a child).
  chatIds: string[];
}

// Split a folder path into its non-empty trimmed segments. 'Work / ClientA /'
// yields ['Work', 'ClientA']. Empty or whitespace-only segments are dropped, so
// leading/trailing/double slashes do not create blank folders.
export function splitFolderPath(rawPath: string): string[] {
  return rawPath
    .split(FOLDER_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// One folder record to upsert as part of a slash-path expansion. mintNew is true
// when this segment did not already exist and a fresh id was minted for it;
// false when an existing folder was reused. The caller persists only the records
// (existing ones are already in the store, but re-upserting them is harmless and
// idempotent).
export interface ExpandedSegment {
  folder: Folder;
  mintNew: boolean;
}

// The result of expanding a slash path against the existing folders: the ordered
// chain of segment records (root first) and the leaf folder id (the deepest
// segment), which becomes the assignment target / newly-created folder. When the
// path has no usable segments, leafFolderId is null and chain is empty.
export interface ExpandResult {
  chain: ExpandedSegment[];
  leafFolderId: string | null;
}

// Expand a slash path into a chain of real parent-child Folder records, reusing
// any existing segment matched by (parentId, name) and minting a new Folder only
// for a missing segment. This is the create-time expansion (interpretation (b)):
// 'Work/ClientA' against an empty store yields two records (Work parentId=null,
// ClientA parentId=Work.id); run again it reuses both and mints nothing.
//
// existing is the flat map of stored folders (ProjectMeta.folders). orderFor
// supplies the `order` for a newly minted sibling (defaults to an
// append-at-end-of-siblings count). mint supplies ids (defaults to the id
// factory; injectable for deterministic tests). startParentId roots the
// expansion under a KNOWN parent folder id rather than at the top level: a
// right-click "New Folder" on a folder row passes that folder's authoritative id
// so the new chain hangs under exactly the clicked folder, never re-resolved
// through its name path. This is the uniqueness-safe alternative to prefixing the
// parent's slash path and re-matching it by name, which can resolve to the wrong
// same-named sibling. When startParentId is omitted the expansion roots at the
// top level (parentId null) exactly as before. The chain returned does NOT
// include the startParentId folder itself, only the new/reused descendant
// segments.
export function expandFolderPath(
  rawPath: string,
  existing: { [id: string]: Folder },
  options: {
    mint?: () => string;
    orderFor?: (parentId: string | null) => number;
    startParentId?: string | null;
  } = {},
): ExpandResult {
  const mint = options.mint ?? mintFolderId;
  const orderFor = options.orderFor ?? defaultOrderFor(existing);
  const startParentId = options.startParentId ?? null;

  const segments = splitFolderPath(rawPath);
  if (segments.length === 0) {
    return { chain: [], leafFolderId: null };
  }

  // A working view of folders that grows as new segments are minted, so a later
  // segment in the SAME path can match a sibling minted earlier in this call.
  const working: { [id: string]: Folder } = { ...existing };
  const chain: ExpandedSegment[] = [];
  // Root the expansion under the clicked parent's authoritative id when supplied,
  // otherwise at the top level (parentId null).
  let parentId: string | null = startParentId;

  for (const name of segments) {
    const match = findChildByName(working, parentId, name);
    if (match !== null) {
      chain.push({ folder: match, mintNew: false });
      parentId = match.id;
      continue;
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
  }

  return { chain, leafFolderId: parentId };
}

// Find a folder that is a direct child of parentId with a case-sensitive exact
// name match. Reuse keys on (parentId, name): two folders named 'ClientA' under
// different parents are distinct, but a second 'ClientA' under the same parent
// reuses the first. Returns null when none matches.
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

// The default order for a newly minted child of parentId: one past the current
// sibling count, so a new folder appends after existing siblings.
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

// Inputs to a tree assembly: the flat folder map plus each chat's single home
// folder id. chatHomes maps a sessionId to its ChatMeta.folderId (null/absent =>
// unfiled). Only chats present in chatHomes are placed; the caller supplies the
// set of known sessionIds it wants rendered.
export interface AssembleInput {
  folders: { [id: string]: Folder };
  // sessionId -> home folder id (null or undefined => Unfiled).
  chatHomes: { [chatId: string]: string | null | undefined };
}

// The assembled tree: the ordered top-level folder nodes followed by the Unfiled
// node. The Unfiled node is always present in the model (the view may choose to
// hide it when empty); it is appended LAST so real folders sort above it.
export interface AssembledTree {
  roots: FolderNode[];
  unfiled: FolderNode;
}

// SINGLE-HOME INVARIANT: every chat appears under EXACTLY one folder node. A chat
// whose home folder id exists in `folders` is placed under that one folder; a
// chat with a null/absent home, or a home id that no longer resolves to a real
// folder (a dangling reference), falls into the Unfiled bucket. No chat is ever
// placed under two folders, and none is dropped.
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

  // Wire parent/child folder links. A folder whose parentId does not resolve to a
  // real folder is treated as a root (a dangling parent reference must not orphan
  // it out of the tree). Self-parenting is ignored.
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

  // Place each chat under its single home (exactly one of: a resolved folder, or
  // Unfiled). A home id absent from nodesById (dangling) routes to Unfiled.
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

// Build the chatId -> owning-folderId inverse for an assembled tree. Every chat
// is recorded against the single folder node that directly homes it; a chat in
// the Unfiled bucket maps to the Unfiled sentinel id so a reveal-by-chat still
// resolves a parent. This is the PURE half of the provider's getParent: the
// vscode-bound layer turns the resolved folder id into a TreeItem, but the
// single-home resolution itself (and the Unfiled fallback) lives here so it can
// be unit-tested without the vscode host. Mirrors the SINGLE-HOME INVARIANT of
// assembleFolderTree: exactly one entry per placed chat.
export function buildChatHomeIndex(tree: AssembledTree): Map<string, string> {
  const into = new Map<string, string>();
  indexChatHomesInto(tree.roots, into);
  for (const chatId of tree.unfiled.chatIds) {
    into.set(chatId, tree.unfiled.id);
  }
  return into;
}

// Resolve the single owning folder id for a chat from a home index, falling back
// to a hint (the folder id carried on the chat's member node) when the index has
// no entry for the chat. The hint defaults to the Unfiled sentinel so a chat that
// is not in the current index still resolves to a parent rather than orphaning.
// This is the exact resolution the provider's getParent performs before turning
// the id into a TreeItem; extracted so the rule is unit-testable.
export function resolveChatHomeFolderId(
  index: Map<string, string>,
  chatId: string,
  hint: string = UNFILED_FOLDER_ID,
): string {
  return index.get(chatId) ?? hint;
}

// Node-object memoization reuse rule (the PURE half of the provider's
// folderItemFor / chatMemberItemFor). VSCode caches tree elements by object
// reference, so a refresh must REUSE the existing node object for an unchanged id
// rather than return a fresh object with the same id, or reveal and selection
// break (ARCHITECTURE.md "Memoize node objects by id across refreshes"). These
// predicates decide whether a cached object is still valid for the current data;
// the provider holds the actual TreeItem objects and the Map, but the
// reuse-vs-rebuild decision lives here so the rule is unit-testable headless.

// A cached folder node may be reused when its memoized name still equals the
// node's current name (a rename must rebuild so the label updates).
export function canReuseFolderItem(
  cachedName: string | undefined,
  currentName: string,
): boolean {
  return cachedName !== undefined && cachedName === currentName;
}

// A cached chat-member node may be reused when its memoized title and timestamp
// both still match the current record (either changing must rebuild so the label
// and relative time update). timestamp is number | null (a transcript with no
// timestamped line yields null), so the comparison must accept null and treat
// null === null as unchanged.
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

// Recurse the folder nodes recording the chatId -> owning folderId entry for each
// directly-homed chat. Internal helper for buildChatHomeIndex.
function indexChatHomesInto(nodes: FolderNode[], into: Map<string, string>): void {
  for (const node of nodes) {
    for (const chatId of node.chatIds) {
      into.set(chatId, node.id);
    }
    indexChatHomesInto(node.childFolders, into);
  }
}

// Sort folder siblings by (order, name) and recurse. Chat ids within a folder are
// left in the caller-supplied iteration order; the view sorts them by the chat's
// own timestamp/title since that data lives outside this pure model.
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

// ---- Composite-id grammar for chat member nodes ----

const CHAT_NODE_SEPARATOR = '#';

// Build the composite id for a chat homed under a folder: `${folderId}#${chatId}`.
// Used for BOTH real folders and the Unfiled bucket (folderId === '__unfiled__').
export function chatNodeId(folderId: string, chatId: string): string {
  return folderId + CHAT_NODE_SEPARATOR + chatId;
}

// Recover the owning folder id from a chat member node id by splitting on the
// FIRST '#'. folderId is separator-free (factory-minted or the '__unfiled__'
// sentinel) so the first '#' is always the grammar separator; chatId is a
// separator-free UUID so the remainder is the whole chat id even if it somehow
// contained another '#'. Returns null for a value that is not a chat node id.
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

// Collect a folder and all its descendant folder ids (the cascade set used by a
// delete). Bounded against a cyclic parentId chain (a corrupt store) by a
// visited set, so a cycle cannot make this loop forever.
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
