import { MetadataStore } from '../store/metadataStore';
import { Link } from '../store/schema';
import { LinkedChild, designatedParentOf, linksFromChats } from '../model/links';

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
