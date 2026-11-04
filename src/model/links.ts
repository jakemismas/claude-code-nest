// Pure model for linked-child nesting in the Folders view: a 'parent' Link from a
// source chat to a target chat nests the target beneath the source. Covers the link
// graph, single-parent selection, cycle and depth bounds, and the node id grammar
// `${parentChatId}>link>${chatId}`. No vscode dependency, so the unit suite runs headless.

import { ChatMeta, Link } from '../store/schema';

// Depth cap (in link hops from the root parent) on top of the visited-set check, so an
// acyclic but very long chain cannot expand without limit.
export const MAX_LINK_DEPTH = 16;

// The infix is a full token so the parser can split on the first '>' and strip 'link>'
// from the tail.
const LINK_ID_PREFIX_SEPARATOR = '>';
const LINK_ID_INFIX = '>link>';

// Builds the linked-child node id. parentChatId is the designated parent (see
// designatedParentOf).
export function linkedChildId(parentChatId: string, chatId: string): string {
  return parentChatId + LINK_ID_INFIX + chatId;
}

// Splits on the first '>' and requires the tail to start with '>link>'. Returns null for
// a malformed id (no infix, empty parent or child side).
export function parseLinkedChildId(
  nodeId: string,
): { parentChatId: string; chatId: string } | null {
  const firstSep = nodeId.indexOf(LINK_ID_PREFIX_SEPARATOR);
  if (firstSep <= 0) {
    return null;
  }
  const parentChatId = nodeId.slice(0, firstSep);
  const tail = nodeId.slice(firstSep);
  if (!tail.startsWith(LINK_ID_INFIX)) {
    return null;
  }
  const chatId = tail.slice(LINK_ID_INFIX.length);
  if (parentChatId.length === 0 || chatId.length === 0) {
    return null;
  }
  return { parentChatId, chatId };
}

// One linked child: its designated parent, node id and depth (a direct child is depth 1).
// A broken child (target has no scanned record) still renders so the link can be removed,
// but it is a leaf.
export interface LinkedChild {
  chatId: string;
  parentChatId: string;
  id: string;
  depth: number;
  broken: boolean;
}

// links maps each source chat id to its stored Links. A target absent from knownChatIds
// is broken.
export interface LinkGraphInput {
  links: { [sourceChatId: string]: Link[] };
  knownChatIds: Set<string>;
}

// Direct children per parent, built in a single pass so cyclic stored links cannot make
// the build loop. Deeper levels are expanded lazily through childrenOf.
export interface LinkForest {
  // Sorted by child chat id.
  childrenByParent: Map<string, LinkedChild[]>;
  // Inverse map of childrenByParent.
  designatedParentByChild: Map<string, string>;
}

// Source chat ids holding a 'parent' link to childChatId, deduplicated. Self-links are
// ignored because a chat cannot be its own child.
export function parentSourcesOf(
  links: { [sourceChatId: string]: Link[] },
  childChatId: string,
): string[] {
  const sources = new Set<string>();
  for (const [sourceChatId, linkList] of Object.entries(links)) {
    if (sourceChatId === childChatId) {
      continue;
    }
    for (const link of linkList) {
      if (link.kind === 'parent' && link.targetChatId === childChatId) {
        sources.add(sourceChatId);
        break;
      }
    }
  }
  return Array.from(sources);
}

// The designated parent is the lexicographically smallest source chat id, so a child with
// several parents nests under the same one on every render. Returns null when none.
export function designatedParentOf(
  links: { [sourceChatId: string]: Link[] },
  childChatId: string,
): string | null {
  const sources = parentSourcesOf(links, childChatId);
  if (sources.length === 0) {
    return null;
  }
  let smallest = sources[0];
  for (const source of sources) {
    if (source < smallest) {
      smallest = source;
    }
  }
  return smallest;
}

// Attaches each child, sorted by chat id, under its designated parent at depth 1.
export function buildLinkForest(input: LinkGraphInput): LinkForest {
  const { links, knownChatIds } = input;

  const childCandidates = new Set<string>();
  for (const linkList of Object.values(links)) {
    for (const link of linkList) {
      if (link.kind === 'parent') {
        childCandidates.add(link.targetChatId);
      }
    }
  }

  const childrenByParent = new Map<string, LinkedChild[]>();
  const designatedParentByChild = new Map<string, string>();

  for (const childChatId of childCandidates) {
    const parentChatId = designatedParentOf(links, childChatId);
    if (parentChatId === null) {
      // Only self-links point at this child.
      continue;
    }
    designatedParentByChild.set(childChatId, parentChatId);
    const child: LinkedChild = {
      chatId: childChatId,
      parentChatId,
      id: linkedChildId(parentChatId, childChatId),
      depth: 1,
      broken: !knownChatIds.has(childChatId),
    };
    const siblings = childrenByParent.get(parentChatId) ?? [];
    siblings.push(child);
    childrenByParent.set(parentChatId, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0));
  }

  return { childrenByParent, designatedParentByChild };
}

// Linked children to render beneath a chat. visitedChatIds is the path from the root
// parent down to parentChatId. A child already on the path is skipped (transitive cycle or
// diamond), and nothing is returned past MAX_LINK_DEPTH. Broken children are returned but
// the caller must not recurse into them.
export function childrenOf(
  forest: LinkForest,
  parentChatId: string,
  visitedChatIds: Set<string>,
  currentDepth: number,
): LinkedChild[] {
  const nextDepth = currentDepth + 1;
  if (nextDepth > MAX_LINK_DEPTH) {
    return [];
  }
  const direct = forest.childrenByParent.get(parentChatId) ?? [];
  const out: LinkedChild[] = [];
  for (const child of direct) {
    // Prune a child already on the current path.
    if (visitedChatIds.has(child.chatId)) {
      continue;
    }
    out.push({ ...child, depth: nextDepth });
  }
  return out;
}

// True when the view may recurse into a child: it is not broken, below the depth cap and
// not already on the path.
export function canExpandChild(
  child: LinkedChild,
  visitedChatIds: Set<string>,
): boolean {
  if (child.broken) {
    return false;
  }
  if (child.depth >= MAX_LINK_DEPTH) {
    return false;
  }
  if (visitedChatIds.has(child.chatId)) {
    return false;
  }
  return true;
}

// True when the chat is the designated parent of at least one child.
export function hasLinkedChildren(forest: LinkForest, parentChatId: string): boolean {
  const direct = forest.childrenByParent.get(parentChatId);
  return direct !== undefined && direct.length > 0;
}

// True when walking the designated-parent forest from rootChatId reaches a chat already
// on the path. A diamond is pruned by the visited set but is not a cycle.
export function hasCycleFrom(forest: LinkForest, rootChatId: string): boolean {
  const onPath = new Set<string>();
  return detectCycle(forest, rootChatId, onPath, 0);
}

function detectCycle(
  forest: LinkForest,
  chatId: string,
  onPath: Set<string>,
  depth: number,
): boolean {
  if (onPath.has(chatId)) {
    return true;
  }
  if (depth > MAX_LINK_DEPTH) {
    // Backstop in case the onPath check is evaded.
    return false;
  }
  onPath.add(chatId);
  const direct = forest.childrenByParent.get(chatId) ?? [];
  for (const child of direct) {
    if (detectCycle(forest, child.chatId, onPath, depth + 1)) {
      return true;
    }
  }
  onPath.delete(chatId);
  return false;
}

// VSCode caches tree elements by object reference, so a refresh must reuse the node for
// an unchanged id. Rebuild when the title, timestamp or broken state changes. A broken
// child has no record, so its title and timestamp are null.
export function canReuseLinkedChildItem(
  cached:
    | { title: string | null; timestamp: number | null; broken: boolean }
    | undefined,
  current: { title: string | null; timestamp: number | null; broken: boolean },
): boolean {
  return (
    cached !== undefined &&
    cached.title === current.title &&
    cached.timestamp === current.timestamp &&
    cached.broken === current.broken
  );
}

// Projects a chats map to source chat id -> Links, omitting chats without links.
export function linksFromChats(chats: {
  [chatId: string]: ChatMeta;
}): { [sourceChatId: string]: Link[] } {
  const out: { [sourceChatId: string]: Link[] } = {};
  for (const [chatId, meta] of Object.entries(chats)) {
    if (meta.links.length > 0) {
      out[chatId] = meta.links;
    }
  }
  return out;
}
