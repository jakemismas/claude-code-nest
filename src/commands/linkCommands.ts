import { MetadataStore } from '../store/metadataStore';
import { Link } from '../store/schema';
import {
  LinkedChild,
  designatedParentOf,
  linkedChildId,
  linksFromChats,
} from '../model/links';

// linkCommands: link-to-chat and unlink, which manage a chat's links[] (kind 'parent' or 'related').
// A 'parent' link nests the target under the source in the Folders tree; mutations go through MetadataStore and the view refreshes once.
// The pick lists come from scanned chat records, so a target is always a present chat.

export const LINK_TO_CHAT_COMMAND = 'claudeNest.linkToChat';
export const UNLINK_CHAT_COMMAND = 'claudeNest.unlinkChat';

// One selectable chat in the link-target / unlink pick list.
export interface ChatPickItem {
  label: string;
  description?: string;
  chatId: string;
}

// The injectable UI seam; extension.ts supplies the real vscode.window calls.
export interface LinkCommandUi {
  // Pick the link kind: 'parent' nests the target under this chat, 'related' is a plain cross-reference. Undefined on cancel.
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
  // A structural refresher so the wiring can schedule the opt-in export snapshot after a mutation.
  provider: { refresh(): void };
  // Resolve the project key on demand so a project created after activation still resolves.
  getProjectKey: () => string | undefined;
  // Scanned chat records, re-read on demand, so the target pick offers only present chats. Returns sessionId to {title, timestamp}.
  getChatRecords: () => Map<string, { title: string; timestamp: number | null }>;
  ui: LinkCommandUi;
}

// Link the source chat to a target chosen from the other present chats. The store dedupes an identical (target, kind) pair, so re-linking is idempotent.
// Returns without mutating on cancel, no project, or no other chat to link.
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
    // Exclude the source (a chat cannot be its own child) and chats that no longer resolve.
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

// Palette entry for "Link to Chat...": it arrives with no argument, so it picks the source chat first, then delegates to linkToChat.
// It needs at least two present chats.
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

// Palette entry for "Unlink": lists current parent links as one entry per linked child, labeled with its designated parent, then delegates to unlinkChat.
// A child whose target chat is gone is still offered so a dangling link stays cleanable.
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
        // Only self-links point here, so no nesting exists to remove.
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

// Remove the parent link from the child's designated parent (the smallest source chat id holding one), so it stops nesting there.
// Parent links from other sources stay, so the child then nests under the next smallest source. 'related' links are untouched.
// The designated parent is recomputed from the store rather than trusted from the rendered node.
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
  // Recompute the designated parent from the store so a concurrent change does not make the unlink miss.
  const parentChatId = designatedParentOf(links, child.chatId) ?? child.parentChatId;

  store.removeLink(projectKey, parentChatId, child.chatId, 'parent');
  await store.flush();
  provider.refresh();
  ui.showInfo('Unlinked.');
}
