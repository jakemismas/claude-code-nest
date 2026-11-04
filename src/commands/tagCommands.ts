import { MetadataStore } from '../store/metadataStore';
import { Tag } from '../store/schema';
import { assertMintableId, mintTagId } from '../model/idFactory';
import { TagItem, ChatOccurrenceItem } from '../views/tagsProvider';

// The Tags-view commands: create a tag, delete a tag, and apply or remove a tag on a chat.
// Mutations go through MetadataStore and the view refreshes once. Tag ids come from mintTagId, so they never contain ':' and the occurrence id `${tagId}:${chatId}` splits on the first ':'.
// Deleting a tag strips it from every chat; a chat that loses its last tag shows under Untagged.

export const CREATE_TAG_COMMAND = 'claudeNest.createTag';
export const DELETE_TAG_COMMAND = 'claudeNest.deleteTag';
export const ADD_TAG_TO_CHAT_COMMAND = 'claudeNest.addTagToChat';
export const REMOVE_TAG_FROM_CHAT_COMMAND = 'claudeNest.removeTagFromChat';

// The injectable seam for prompts, confirmations and picks; extension.ts supplies the real vscode.window calls.
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
  // A structural refresher so the wiring can schedule the opt-in export snapshot after a mutation.
  provider: { refresh(): void };
  // Resolve the project key on demand so a project created after activation still resolves.
  getProjectKey: () => string | undefined;
  ui: TagCommandUi;
}

// Create a tag from a typed label and refresh once. Returns the new tag id, or null on cancel or no project.
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

    // Re-assert the separator-free id at the write boundary; the occurrence id grammar depends on it.
  const id = mintTagId();
  assertMintableId(id, 'tag id');
  const tag: Tag = { id, label };
  store.upsertTag(projectKey, tag);
  await store.flush();
  provider.refresh();
  return id;
}

// Delete a tag after confirmation. The store strips its id from every chat; chats are never deleted.
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

// Apply a tag to a chat from the context menu, offering tags not yet applied. The chat arrives as an occurrence item or a bare sessionId.
// With no tags to apply, it prompts to create one first.
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

// Remove the occurrence's owning tag from a chat; the chat keeps its other tags.
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
