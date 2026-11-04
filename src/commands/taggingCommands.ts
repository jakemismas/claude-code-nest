import { MetadataStore } from '../store/metadataStore';
import { effectiveTagIds } from '../model/untagged';

// taggingCommands: the multi-select tag command over a canPickMany QuickPick, plus the pure tag diff that turns a chosen set into adds and removes.
// A multi-chat change is one batched store write and one refresh. The command takes injected seams; the QuickPick lives in ui/tagQuickPick.ts.

export const TAG_CHATS_COMMAND = 'claudeNest.tagChats';

// The injectable multi-select tag picker seam. Returns the final selected tag ids, or undefined when dismissed; options carry each tag's applied state to pre-check.
export interface TagMultiPickUi {
  pickTags(
    options: { tagId: string; label: string; picked: boolean }[],
    placeholder: string,
  ): Thenable<string[] | undefined>;
  showError(message: string): void;
}

export interface TaggingCommandDeps {
  store: MetadataStore;
  provider: { refresh(): void };
  getProjectKey: () => string | undefined;
  ui: TagMultiPickUi;
}

// The adds and removes a multi-select confirmation implies for one chat.
export interface TagSetDelta {
  add: string[];
  remove: string[];
}

// Compute the per-chat delta between the current applied tag set and the selected set.
// Inputs collapse to sets: add is selected minus current, remove is current minus selected, so an unchanged confirm yields an empty delta.
export function tagSetDiff(current: string[], selected: string[]): TagSetDelta {
  const currentSet = new Set(current);
  const selectedSet = new Set(selected);
  const add: string[] = [];
  const seenAdd = new Set<string>();
  for (const id of selected) {
    if (!currentSet.has(id) && !seenAdd.has(id)) {
      seenAdd.add(id);
      add.push(id);
    }
  }
  const remove: string[] = [];
  const seenRemove = new Set<string>();
  for (const id of current) {
    if (!selectedSet.has(id) && !seenRemove.has(id)) {
      seenRemove.add(id);
      remove.push(id);
    }
  }
  return { add, remove };
}

// The tag set common to all selected chats: a tag is pre-checked only when every chat has it, so an unchanged confirm is a no-op.
// An empty chat list yields an empty set.
export function commonAppliedTagIds(
  perChatTagIds: string[][],
): string[] {
  if (perChatTagIds.length === 0) {
    return [];
  }
  const [first, ...rest] = perChatTagIds;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of first) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (rest.every((tagIds) => tagIds.includes(id))) {
      result.push(id);
    }
  }
  return result;
}

// Tag one or more chats via the multi-select QuickPick with the common set pre-checked, applying each chat's own diff as one batched store write and one refresh.
// Returns without mutating on no tags, no project, an empty selection, or cancel.
export async function tagChats(
  deps: TaggingCommandDeps,
  chatIds: string[],
): Promise<void> {
  const { store, provider, ui } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    ui.showError('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  const targets = dedupePreserveOrder(chatIds).filter((id) => id.length > 0);
  if (targets.length === 0) {
    return;
  }

  const meta = store.getProjectMeta(projectKey);
  const allTags = Object.values(meta.tags);
  if (allTags.length === 0) {
    ui.showError('No tags to apply. Create a tag first.');
    return;
  }

  // Resolve each chat's tags through effectiveTagIds so dangling ids (a tag deleted on another machine) stay untouched in storage.
  // Diffing the raw array would put them in delta.remove and let last-writer-wins drop a membership permanently.
  const perChatTagIds = targets.map((chatId) =>
    effectiveTagIds(meta.tags, meta.chats[chatId]?.tags),
  );
  const common = new Set(commonAppliedTagIds(perChatTagIds));

  const options = allTags
    .map((tag) => ({ tagId: tag.id, label: tag.label, picked: common.has(tag.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const placeholder =
    targets.length === 1
      ? 'Toggle tags for this chat'
      : `Toggle tags for ${targets.length} chats`;
  const selected = await ui.pickTags(options, placeholder);
  if (selected === undefined) {
    return;
  }

  // Apply each chat's own diff so a partially applied tag is added to the rest when left checked, and removed everywhere when unchecked.
  const selectedSet = selected;
  let mutated = false;
  targets.forEach((chatId, index) => {
    const delta = tagSetDiff(perChatTagIds[index], selectedSet);
    for (const tagId of delta.add) {
      store.addChatTag(projectKey, chatId, tagId);
      mutated = true;
    }
    for (const tagId of delta.remove) {
      store.removeChatTag(projectKey, chatId, tagId);
      mutated = true;
    }
  });

  if (!mutated) {
    return;
  }
  await store.flush();
  provider.refresh();
}

// De-duplicate a list of strings preserving first-seen order.
function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
