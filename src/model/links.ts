// links: the PURE model behind the Folders view's linked-child nesting. A chat
// carries outbound Link records (ChatMeta.links); a Link of kind 'parent' on a
// SOURCE chat pointing at a TARGET chat means the target renders nested beneath
// the source in the Folders tree as a distinct linkedChild node. This module owns
// the link-graph build, the deterministic single-parent selector, the visited-set
// cycle/diamond detection with a capped depth, the broken-target rule, and the
// linkedChild composite-id grammar.
//
// This module is vscode-free (build contract; ARCHITECTURE.md unit-gate rule): no
// vscode import, no filesystem. The view layer (foldersProvider.ts) turns a
// LinkedChild into a TreeItem and memoizes the node object; this module produces
// only plain data and the grammar, so the unit test imports it without
// transitively requiring vscode (mirrors occurrence.ts vs tagsProvider.ts).
//
// Composite-id grammar (ARCHITECTURE.md "Tree and VSCode API binding rules"):
//   linked-child id = `${parentChatId}>link>${chatId}`
// parentChatId and chatId are separator-free UUIDs (chat ids are filenames =
// sessionIds, never carrying ':' '#' '>'), and the infix is the literal '>link>',
// so the id splits unambiguously on the FIRST '>' back to its owning PARENT
// chat-member occurrence. getParent for a linkedChild recovers that one parent
// chat occurrence (one parent per node, ARCHITECTURE.md line 100), NOT a folder.

import { ChatMeta, Link } from '../store/schema';

// The cap on how deep the Folders tree expands linked children beneath a parent.
// A proper visited-set traversal already blocks transitive cycles and diamonds;
// the depth cap is a SECOND, independent bound so even an acyclic but pathological
// chain (a long parent->child->grandchild line) cannot expand without limit in the
// tree. ARCHITECTURE.md "Link cycle detection ... Cap depth." Depth is measured in
// link hops from the root parent: a parent's direct linked children are depth 1.
export const MAX_LINK_DEPTH = 16;

// The linked-child composite-id grammar. The infix is a full token ('>link>') so
// the id is self-describing and the parser can split on the first '>' and then
// strip the remaining 'link>' prefix off the tail, recovering both chat ids even
// though both are UUIDs.
const LINK_ID_PREFIX_SEPARATOR = '>';
const LINK_ID_INFIX = '>link>';

// Build the linkedChild composite id `${parentChatId}>link>${chatId}`. parentChatId
// is the DESIGNATED parent chat occurrence's chat id (the smallest source chat id
// holding a kind:'parent' link to chatId; see designatedParentOf); chatId is the
// linked (child) chat's sessionId.
export function linkedChildId(parentChatId: string, chatId: string): string {
  return parentChatId + LINK_ID_INFIX + chatId;
}

// Recover the designated-parent chat id and the child chat id from a linkedChild
// node id. Split on the FIRST '>' for the parent chat id, then require the tail to
// begin with the rest of the infix ('link>') and take everything after it as the
// child chat id. Returns null for any value that is not a well-formed linkedChild
// id (no infix, empty parent or child side). This is the PURE half of the
// provider's getParent for a linkedChild: it yields the owning PARENT chat id,
// which the view turns into the single parent chat-member occurrence node (NOT a
// folder). Mirrors occurrence.ts parseTagOccurrenceId / folderTree.ts
// parseChatNodeId (split on the first separator).
export function parseLinkedChildId(
  nodeId: string,
): { parentChatId: string; chatId: string } | null {
  const firstSep = nodeId.indexOf(LINK_ID_PREFIX_SEPARATOR);
  if (firstSep <= 0) {
    return null;
  }
  const parentChatId = nodeId.slice(0, firstSep);
  // The tail from the first '>' must be the full infix tail ('>link>') followed by
  // a non-empty child chat id.
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

// One linked child of a parent in the assembled link forest: the child chat id,
// its designated parent chat id, the composite node id, the depth (link hops from
// the root parent; a direct child is depth 1), and whether the child's target is
// BROKEN (its chat id does not resolve to a known/scanned chat record, e.g. the
// target was deleted on disk). A broken child still renders (muted) so the link is
// visible and unlink-able, but it is a leaf (its own children are not expanded
// because its record is unknown).
export interface LinkedChild {
  chatId: string;
  parentChatId: string;
  id: string;
  depth: number;
  broken: boolean;
}

// The inputs to a link-graph build. links maps each SOURCE chat id to its stored
// Link list (ChatMeta.links). knownChatIds is the set of chat ids that resolve to a
// scanned ChatRecord; a target chat id absent from this set is BROKEN. Only the
// links are needed (folders are orthogonal: a chat's folder home and its link
// parentage are independent, and a linked child renders under its parent occurrence
// wherever that parent sits in the folder tree).
export interface LinkGraphInput {
  links: { [sourceChatId: string]: Link[] };
  knownChatIds: Set<string>;
}

// Build the map of parent chat id -> its ordered direct linked children (depth 1).
// A child's designated parent is the SMALLEST source chat id holding a kind:'parent'
// link to it (designatedParentOf), so a child with parent links from several sources
// nests under exactly one parent every render (DECISIONS.md slice-5 entry). The
// returned children carry depth 1 and their broken flag; transitive descendants are
// expanded lazily by the view (childrenOf with the visited set), not precomputed
// here, so a cycle in the stored links cannot make THIS build loop.
export interface LinkForest {
  // parent chat id -> its direct linked children (depth 1), child-chat-id sorted.
  childrenByParent: Map<string, LinkedChild[]>;
  // The designated parent chat id for each child chat id (the inverse, for a
  // deterministic single-parent check and for getParent recovery cross-checks).
  designatedParentByChild: Map<string, string>;
}

// Collect, for a TARGET child chat id, every SOURCE chat id that holds a
// kind:'parent' link pointing at it. A self-link (a chat that lists itself as a
// parent target) is ignored: a chat can never be its own linked child. The result
// is de-duplicated. Exported for direct unit testing of the candidate set.
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

// The DETERMINISTIC single-parent selector (DECISIONS.md slice-5 entry): among all
// source chats that hold a kind:'parent' link to childChatId, the designated parent
// is the lexicographically SMALLEST source chat id. Returns null when the child has
// no parent link pointing at it (it is not a linked child of anyone and renders only
// in its folder home). Total, stable, and order-independent (a min over a value, not
// a first-seen pick), so the child nests under the SAME parent on every render and
// the cycle/diamond traversal is deterministic.
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

// Build the link forest: for every child chat id that has at least one kind:'parent'
// link pointing at it, attach it (depth 1) under its single DESIGNATED parent. Each
// child carries its broken flag (target not in knownChatIds). The per-parent child
// lists are sorted by child chat id for a stable render order. This build is finite
// and cannot loop regardless of cycles in the stored links: it is a single pass that
// assigns each child to one parent; the cycle/diamond bound is enforced later, at
// EXPANSION time, by childrenOf's visited set + depth cap.
export function buildLinkForest(input: LinkGraphInput): LinkForest {
  const { links, knownChatIds } = input;

  // Gather every chat id that is the TARGET of any kind:'parent' link (the set of
  // potential linked children), then assign each to its designated parent.
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
      // Only self-links pointed at this child (parentSourcesOf drops self-links),
      // so it has no real parent; it is not a linked child of anyone.
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

// The visited-set graph traversal that yields the linked children to render BENEATH
// a given chat occurrence, blocking transitive cycles and diamonds with a capped
// depth (ARCHITECTURE.md "Link cycle detection uses a proper visited-set graph
// traversal (transitive cycles and diamonds) ... Cap depth.").
//
// `visitedChatIds` is the set of chat ids already on the path from the ROOT parent
// down to (and including) `parentChatId`. A candidate child is SKIPPED when:
//   - it is already in visitedChatIds  -> a transitive cycle (A parent of B, B
//     parent of C, C parent of A) OR a diamond (A->B, A->C, B->D, C->D: D is
//     reached twice; the second path is pruned so D renders once per ancestor
//     path-set, never duplicated within one path), or
//   - the next depth would exceed MAX_LINK_DEPTH                 -> the depth cap.
// A broken child (target not scanned) is still returned (rendered muted) but a
// caller must NOT recurse into it (its record is unknown); childrenOf marks it and
// leaves recursion to the caller's broken check.
//
// This is the read-time expansion: the provider calls childrenOf(parentChatId,
// visited) when expanding a parent or linkedChild node, passing the path's visited
// set so the SAME chat appearing twice on one path is pruned. Returns the direct
// children with their depth set to currentDepth + 1.
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
    // Cycle / diamond prune: a child already on the current path (including the
    // root and every ancestor down to this parent) is not expanded again.
    if (visitedChatIds.has(child.chatId)) {
      continue;
    }
    out.push({ ...child, depth: nextDepth });
  }
  return out;
}

// A child is EXPANDABLE (the view may recurse into it to render ITS linked children)
// only when it is not broken (its record is known) AND expanding it would not exceed
// the depth cap AND it is not already on the path. This centralizes the recurse-or-
// stop decision so the provider and the unit test share one rule. A broken child is
// always a leaf.
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

// True when a chat has at least one direct linked child under it (so the view
// renders the parent chat-member node collapsible rather than a leaf). A broken
// parent reference is irrelevant here: this asks whether THIS chat is a designated
// parent of anyone.
export function hasLinkedChildren(forest: LinkForest, parentChatId: string): boolean {
  const direct = forest.childrenByParent.get(parentChatId);
  return direct !== undefined && direct.length > 0;
}

// Detect whether the stored links contain a transitive cycle reachable from a given
// root chat id by walking the DESIGNATED-parent forest (the same single-parent graph
// the view renders), bounded by a visited set. Returns true when a chat is reached
// that is already on the path (a cycle). Exported so the cycle-detection contract is
// unit-testable directly against the forest, independent of the view. Diamonds are
// NOT cycles: a diamond (two paths to one node) is pruned by the visited set on the
// second path but is not reported as a cycle here.
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
    // The depth cap also backstops cycle detection: even if a pathological store
    // somehow evaded the onPath check, the bounded depth stops the walk.
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

// Node-object memoization reuse rule for a linkedChild node (the PURE half of the
// provider's linkedChildItemFor). VSCode caches tree elements by object reference,
// so a refresh must REUSE the existing wrapper's TreeItem for an unchanged id rather
// than return a fresh object with the same id, or reveal/selection break
// (ARCHITECTURE.md "Memoize node objects by id across refreshes"). A linkedChild's
// RENDERED content is the TARGET chat's title + timestamp PLUS its broken state (a
// broken child renders muted and label-only, so a target that comes back / goes
// missing must rebuild). timestamp is number | null; null === null is unchanged. A
// broken child has no record, so title/timestamp are compared as null/null and the
// broken flag is the discriminator.
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

// Adapt a ProjectMeta.chats map to the LinkGraphInput.links shape (source chat id ->
// its stored Link list). A chat with no links contributes an empty list (or is
// omitted; buildLinkForest treats an absent entry as no links). Pure helper so the
// provider does not hand-roll the projection and the test can build inputs from a
// chats map. knownChatIds is supplied separately by the provider (the scanned set).
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
