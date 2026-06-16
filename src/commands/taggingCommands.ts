import { MetadataStore } from '../store/metadataStore';
import { effectiveTagIds } from '../model/untagged';

// taggingCommands: the multi-select tag command driven by the canPickMany
// QuickPick (the slice's primary tagging affordance), plus the pure tag-diff that
// turns a chosen tag-id set into the adds and removes to stage. Applying a
// multi-tag, multi-chat change is batched into ONE store write (N synchronous
// store calls coalesced by the store's debounce) and a SINGLE refresh, matching
// the drag-and-drop drop path and the deleteFolder cascade (ARCHITECTURE.md
// "Refresh coalescing").
//
// The command depends only on injectable seams (a tag-multi-pick presenter, a
// project-key resolver, a refreshable provider, the store), so its orchestration
// is exercisable headless; the concrete QuickPick lives in ui/tagQuickPick.ts.
// The pure tagSetDiff is exported and unit-tested directly.

export const TAG_CHATS_COMMAND = 'claudeNest.tagChats';

// The injectable multi-select tag picker seam. Returns the FINAL selected tag-id
// set (checked rows), or undefined when dismissed without confirming. extension.ts
// wires this to ui/tagQuickPick.showTagMultiPick; a test supplies a scripted
// double. The options carry each tag's current applied state so the picker can
// pre-check it.
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

// The adds and removes a multi-select tag confirmation implies for ONE chat: the
// tag ids newly checked (to add) and the tag ids unchecked that were applied (to
// remove). Pure data so the command can stage exactly these mutations.
export interface TagSetDelta {
  add: string[];
  remove: string[];
}

// Compute the per-chat add/remove delta between the chat's CURRENT applied tag set
// and the SELECTED set returned by the multi-pick. This is the pure core of the
// multi-select tagging mutation, exported and unit-tested without vscode:
// - add: selected ids not currently applied (order follows `selected`).
// - remove: currently-applied ids not in the selection (order follows `current`).
// Both inputs are treated as sets (duplicates collapse). An id that is both absent
// from current and present in selected is an add; one present in current and
// absent from selected is a remove; an unchanged id appears in neither list, so a
// confirm-without-changes yields an empty delta and the command no-ops.
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

// The COMMON applied-tag set across a multi-chat selection: a tag is pre-checked
// only when EVERY selected chat already has it, so confirming an unchanged picker
// is a no-op for the whole selection and toggling a partially-applied tag ON adds
// it everywhere (rather than the picker lying about a mixed state). Pure;
// unit-tested directly. An empty chat list yields an empty common set.
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

// Tag one or more chats via the multi-select QuickPick. Presents every tag with
// the COMMON applied set pre-checked, then applies the confirmed selection to
// EVERY chat in the selection as one batched store write: for each chat, the adds
// and removes from its OWN diff against the confirmed set are staged as synchronous
// store calls (coalesced into one pending write), then a single flush and a single
// refresh. Returns without mutating when there are no tags, no project, an empty
// chat selection, or the picker is cancelled.
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

  // The per-chat current tag sets, RESOLVED to real tags (effectiveTagIds drops
  // dangling ids — a tag created/deleted on another machine, not yet reconciled
  // locally). Diffing against the raw stored array would place every dangling id
  // into delta.remove (the picker only ever offers real tags, so a dangling id can
  // never be re-selected), and the resulting removeChatTag would stamp the record
  // and let last-writer-wins reconcile permanently drop a membership that
  // untagged.effectiveTagIds was written to preserve. Resolving here keeps dangling
  // ids untouched in storage while still computing correct adds/removes for real
  // tags. The common set pre-checked in the picker is computed from the same
  // resolved sets.
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

  // Apply the confirmed selection to each chat via its OWN diff, so a tag that
  // was applied to only some chats is added to the rest (it was unchecked in the
  // common set) when the user leaves it checked, and removed everywhere when the
  // user unchecks it. Every store call is synchronous and coalesces into one
  // pending write.
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
