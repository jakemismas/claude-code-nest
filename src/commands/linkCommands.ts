import { MetadataStore } from '../store/metadataStore';
import { Link } from '../store/schema';
import {
  LinkedChild,
  designatedParentOf,
  linkedChildId,
  linksFromChats,
} from '../model/links';

// linkCommands: the link-to-chat and unlink commands that manage a chat's links[]
// (kind 'parent' or 'related'). A kind:'parent' link on a SOURCE chat pointing at a
// TARGET chat makes the target render nested beneath the source in the Folders tree
// as a linkedChild (links.ts). Every mutation runs through MetadataStore.addLink /
// removeLink (the synced ProjectMeta) and the Folders view is refreshed ONCE after
// the store flush (refresh coalescing, ARCHITECTURE.md).
//
// The injectable LinkCommandUi seam mirrors TagCommandUi so the command logic is
// exercisable without the real vscode UI; extension.ts wires the real window
// methods. The pick lists are built from the SCANNED chat records (a link target
// must be a real, present chat), so the command never offers a broken target.

export const LINK_TO_CHAT_COMMAND = 'claudeNest.linkToChat';
export const UNLINK_CHAT_COMMAND = 'claudeNest.unlinkChat';

// One selectable chat in the link-target / unlink pick list.
export interface ChatPickItem {
  label: string;
  description?: string;
  chatId: string;
}

// The injectable UI seam. extension.ts supplies the real vscode.window
// implementations; a test supplies a scripted double.
export interface LinkCommandUi {
  // Pick the link KIND: a parent link nests the target under this chat; a related
  // link is a plain cross-reference (no nesting). Returns the chosen kind, or
  // undefined on cancel.
  pickKind(): Thenable<Link['kind'] | undefined>;
  // Pick a single chat from a list (the link target / the link to remove). Returns
  // the chosen chat id, or undefined on cancel.
  pickChat(
    items: ChatPickItem[],
    placeholder: string,
  ): Thenable<{ chatId: string } | undefined>;
  showError(message: string): void;
  showInfo(message: string): void;
}

export interface LinkCommandDeps {
  store: MetadataStore;
  // Only refresh() is used; a structural refresher lets the wiring schedule the
  // opt-in auto-export snapshot after a link mutation. The concrete FoldersProvider
  // and the test stubs both satisfy it.
  provider: { refresh(): void };
  // Resolve the encoded project key ON DEMAND (mirroring the other command decks),
  // so a command invoked after Claude Code created the project dir resolves it.
  getProjectKey: () => string | undefined;
  // The scanned chat records for this project, so the target pick offers only real,
  // present chats and renders their titles. Re-read on demand (mirrors the
  // provider's lazy scan). Returns sessionId -> {title, timestamp}.
  getChatRecords: () => Map<string, { title: string; timestamp: number | null }>;
  ui: LinkCommandUi;
}

// Link the given SOURCE chat to a TARGET chat chosen from the other present chats,
// with a chosen kind. A 'parent' link nests the target under the source in the
// Folders tree; a 'related' link is a plain cross-reference. The store dedupes an
// identical (target, kind) pair, so re-linking is idempotent. Returns without
// mutating on cancel, no project, or when there is no other chat to link.
//
// sourceChatId is the chat the command fired on (a chat-member row in any view, a
// flat row, or a programmatic sessionId).
export async function linkToChat(
  deps: LinkCommandDeps,
  sourceChatId: string,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  if (sourceChatId.length === 0) {
    return;
  }

  const records = deps.getChatRecords();
  const targets: ChatPickItem[] = [];
  for (const [chatId, record] of records) {
    // Never offer the source chat itself (a chat cannot be its own linked child),
    // and only offer present chats (a link target must resolve).
    if (chatId === sourceChatId) {
      continue;
    }
    targets.push({ label: record.title, description: chatId, chatId });
  }
  if (targets.length === 0) {
    ui.showError('No other chat to link to.');
    return;
  }
  targets.sort((a, b) => a.label.localeCompare(b.label));

  const kind = await ui.pickKind();
  if (kind === undefined) {
    return;
  }
  const choice = await ui.pickChat(
    targets,
    kind === 'parent'
      ? 'Nest which chat beneath this one?'
      : 'Link this chat to which chat?',
  );
  if (choice === undefined) {
    return;
  }

  const link: Link = { targetChatId: choice.chatId, kind };
  store.addLink(projectKey, sourceChatId, link);
  await store.flush();
  provider.refresh();
}

// The PALETTE entry for "Link to Chat..." (slice s3a-view-consolidation): with the
// flat Chats tree retired, no tree row supplies the source chat any more, so a
// palette invocation arrives with NO argument. This path first picks the SOURCE
// chat from the same scanned records the target pick uses, then delegates to
// linkToChat (which picks the kind and the target). Requires at least two present
// chats (a source and a distinct target); with fewer there is nothing linkable.
export async function linkToChatFromPalette(deps: LinkCommandDeps): Promise<void> {
  const { ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  const records = deps.getChatRecords();
  if (records.size < 2) {
    ui.showError('No other chat to link to.');
    return;
  }
  const sources: ChatPickItem[] = [];
  for (const [chatId, record] of records) {
    sources.push({ label: record.title, description: chatId, chatId });
  }
  sources.sort((a, b) => a.label.localeCompare(b.label));
  const choice = await ui.pickChat(
    sources,
    'Link from which chat? (the target nests beneath it)',
  );
  if (choice === undefined) {
    return;
  }
  await linkToChat(deps, choice.chatId);
}

// The PALETTE entry for "Unlink" (slice s3a-view-consolidation): with the Folders
// tree retired nothing mints a linked-child row, so a palette invocation arrives
// with NO argument. This path enumerates the project's CURRENT parent links as one
// pick entry per linked CHILD, labeled with its DESIGNATED parent (the exact
// nesting unlinkChat removes), then delegates to unlinkChat with the chosen child.
// A broken child (its target chat is no longer on disk) is still offered so a
// dangling link stays cleanable, mirroring the retired tree's broken-row Unlink.
export async function unlinkChatFromPalette(deps: LinkCommandDeps): Promise<void> {
  const { store, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  const meta = store.getProjectMeta(projectKey);
  const links = linksFromChats(meta.chats);
  const records = deps.getChatRecords();

  const childrenByChatId = new Map<string, LinkedChild>();
  for (const linkList of Object.values(links)) {
    for (const link of linkList) {
      if (link.kind !== 'parent' || childrenByChatId.has(link.targetChatId)) {
        continue;
      }
      const parentChatId = designatedParentOf(links, link.targetChatId);
      if (parentChatId === null) {
        // Only self-links point at this target (parentSourcesOf drops them), so it
        // is not a linked child of anyone; there is no nesting to remove.
        continue;
      }
      childrenByChatId.set(link.targetChatId, {
        chatId: link.targetChatId,
        parentChatId,
        id: linkedChildId(parentChatId, link.targetChatId),
        depth: 1,
        broken: !records.has(link.targetChatId),
      });
    }
  }
  if (childrenByChatId.size === 0) {
    ui.showInfo('No linked chats to unlink.');
    return;
  }

  const items: ChatPickItem[] = [];
  for (const child of childrenByChatId.values()) {
    items.push({
      label: pickTitleOf(records, child.chatId),
      description: 'nested under ' + pickTitleOf(records, child.parentChatId),
      chatId: child.chatId,
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  const choice = await ui.pickChat(items, 'Unlink which chat from its parent?');
  if (choice === undefined) {
    return;
  }
  const chosen = childrenByChatId.get(choice.chatId);
  if (chosen === undefined) {
    return;
  }
  await unlinkChat(deps, chosen);
}

// The pick-list title for a chat id: its scanned title when present, else the raw
// id marked missing (a broken link target has no record to resolve a title from).
function pickTitleOf(
  records: Map<string, { title: string; timestamp: number | null }>,
  chatId: string,
): string {
  const record = records.get(chatId);
  return record !== undefined ? record.title : chatId + ' (missing)';
}

// Unlink a linked-child occurrence: remove the kind:'parent' link from its
// DESIGNATED parent (the parent under which it renders) to this child, so it stops
// nesting there. The designated parent is recomputed from the current store (the
// smallest source chat id holding a parent link to the child), matching what the
// view rendered, so the unlink targets exactly the visible nesting. Other parent
// links to the same child from OTHER sources are left intact: the child then nests
// under the NEXT smallest source on the following refresh (the single-parent
// selector is re-evaluated), which is the correct "remove this one nesting"
// semantics. A 'related' link is not touched here (it does not produce a nesting).
//
// The command receives the linked-child model node (its parent chat id and child
// chat id are both on it); it recomputes the authoritative parent from the store to
// avoid acting on a stale rendered value.
export async function unlinkChat(
  deps: LinkCommandDeps,
  child: LinkedChild,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const meta = store.getProjectMeta(projectKey);
  const links = linksFromChats(meta.chats);
  // The authoritative current designated parent for this child (smallest source
  // chat id with a parent link to it). Prefer it over the rendered parentChatId so a
  // concurrent change does not make the unlink miss.
  const parentChatId = designatedParentOf(links, child.chatId) ?? child.parentChatId;

  store.removeLink(projectKey, parentChatId, child.chatId, 'parent');
  await store.flush();
  provider.refresh();
  ui.showInfo('Unlinked.');
}
