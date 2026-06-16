import { MetadataStore } from '../store/metadataStore';
import { Tag } from '../store/schema';
import { assertMintableId, mintTagId } from '../model/idFactory';
import { TagsProvider, TagItem, ChatOccurrenceItem } from '../views/tagsProvider';

// The Tags-view commands: create a tag, delete a tag, and apply/remove a tag on a
// chat. Every store mutation runs through MetadataStore (the synced ProjectMeta),
// and the view is refreshed ONCE after the store flush (refresh coalescing,
// ARCHITECTURE.md "Refresh coalescing").
//
// Create mints a SEPARATOR-FREE tag id through the shared id factory
// (mintTagId), so a tag id can never carry ':' '#' '>' and the occurrence
// composite id `${tagId}:${chatId}` always splits unambiguously on the first ':'.
// Delete removes the tag and (via the store's deleteTag) strips the tag id from
// every chat that referenced it, so no occurrence survives a delete and a chat
// whose last tag was deleted recomputes into Untagged on the next refresh.
//
// The injectable TagCommandUi seam mirrors FolderCommandUi so the command logic is
// exercisable without the real vscode UI; extension.ts wires the real window
// methods.

export const CREATE_TAG_COMMAND = 'claudeNest.createTag';
export const DELETE_TAG_COMMAND = 'claudeNest.deleteTag';
export const ADD_TAG_TO_CHAT_COMMAND = 'claudeNest.addTagToChat';
export const REMOVE_TAG_FROM_CHAT_COMMAND = 'claudeNest.removeTagFromChat';

// The injectable seam for prompts, confirmations, and picks. Mirrors
// FolderCommandUi. extension.ts supplies the real vscode.window implementations.
export interface TagCommandUi {
  prompt(options: {
    title: string;
    placeholder?: string;
    value?: string;
    validateInput?: (value: string) => string | null;
  }): Thenable<string | undefined>;
  confirmWarning(message: string, confirmLabel: string): Thenable<boolean>;
  // Pick a single tag from a list (apply-to-chat / remove-from-chat). Returns the
  // chosen tag id, or undefined on cancel.
  pickTag(
    items: { label: string; description?: string; tagId: string }[],
    placeholder: string,
  ): Thenable<{ tagId: string } | undefined>;
  showError(message: string): void;
}

export interface TagCommandDeps {
  store: MetadataStore;
  provider: TagsProvider;
  // Resolve the encoded project key ON DEMAND (mirroring FoldersProvider), so a
  // command invoked after Claude Code created the project dir resolves it instead
  // of acting on a value frozen at activation.
  getProjectKey: () => string | undefined;
  ui: TagCommandUi;
}

// Create a tag from a typed label. Mints a fresh separator-free id, persists the
// tag, and refreshes once. Returns the new tag id, or null when cancelled / no
// project. A blank label is rejected by validateInput and as a post-prompt guard.
export async function createTag(deps: TagCommandDeps): Promise<string | null> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return null;
  }

  const raw = await ui.prompt({
    title: 'New Tag',
    placeholder: 'Tag label',
    validateInput: (value) =>
      value.trim().length === 0 ? 'Enter a tag label.' : null,
  });
  if (raw === undefined) {
    return null;
  }
  const label = raw.trim();
  if (label.length === 0) {
    return null;
  }

  // Mint a separator-free id and re-assert it at the write boundary (defense in
  // depth: the factory already guarantees this, but the assertion documents and
  // enforces the invariant the occurrence grammar depends on).
  const id = mintTagId();
  assertMintableId(id, 'tag id');
  const tag: Tag = { id, label };
  store.upsertTag(projectKey, tag);
  await store.flush();
  provider.refresh();
  return id;
}

// Delete a tag after a confirmation. The store's deleteTag removes the tag record
// AND strips its id from every chat's tags array; a chat that loses its last tag
// recomputes into Untagged on the next refresh. Chats are never deleted.
export async function deleteTag(
  deps: TagCommandDeps,
  tagItem: TagItem,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const meta = store.getProjectMeta(projectKey);
  const target = meta.tags[tagItem.tagId];
  if (target === undefined) {
    return;
  }

  const confirmed = await ui.confirmWarning(
    `Delete tag "${target.label}"? It is removed from every chat that has it; ` +
      `no chats are deleted.`,
    'Delete',
  );
  if (!confirmed) {
    return;
  }
  store.deleteTag(projectKey, tagItem.tagId);
  await store.flush();
  provider.refresh();
}

// Apply a tag to a chat via the context menu. Presents the tag list (the chat's
// not-yet-applied tags); the store's addChatTag is a no-op when already present.
// The chat may arrive as a ChatOccurrenceItem (right-clicked in this view) or as a
// bare sessionId (from another surface). When there are no tags to apply, prompts
// to create one first.
export async function addTagToChat(
  deps: TagCommandDeps,
  target: ChatOccurrenceItem | string,
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const chatId = typeof target === 'string' ? target : target.record.sessionId;

  const meta = store.getProjectMeta(projectKey);
  const current = new Set(meta.chats[chatId]?.tags ?? []);
  const applicable = Object.values(meta.tags).filter((t) => !current.has(t.id));
  if (applicable.length === 0) {
    ui.showError('No tags to apply. Create a tag first.');
    return;
  }
  const choice = await ui.pickTag(
    applicable
      .map((t) => ({ label: t.label, tagId: t.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    'Apply tag to chat',
  );
  if (choice === undefined) {
    return;
  }
  store.addChatTag(projectKey, chatId, choice.tagId);
  await store.flush();
  provider.refresh();
}

// Remove a tag from a chat via the context menu on an occurrence. The occurrence's
// owning tag is the one removed (a many-to-many chat keeps its other tags). After
// the removal, a chat that loses its last tag recomputes into Untagged.
export async function removeTagFromChat(
  deps: TagCommandDeps,
  occurrenceItem: ChatOccurrenceItem,
): Promise<void> {
  const { store, provider } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return;
  }
  const { tagId, chatId } = occurrenceItem.occurrence;
  store.removeChatTag(projectKey, chatId, tagId);
  await store.flush();
  provider.refresh();
}
