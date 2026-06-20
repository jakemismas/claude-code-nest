import { ProjectMeta } from '../store/schema';

// Small PURE resolvers that turn a project's curation document plus a chatId into
// the plain folder NAME and the full tag LABEL set the hover card needs. The
// providers already read ProjectMeta at their render call site; these centralize
// the name/label lookup so all three views (flat, folders, tags) feed
// buildChatTooltip the SAME values rather than each re-deriving them. vscode-free:
// it operates on the plain schema shape, so it stays in the headless unit gate.

// The resolved home-folder name for a chat, or null when the chat is unfiled, its
// folder no longer resolves, or there is no meta. The hover card renders null as
// "Unfiled". A missing meta (project key not resolved yet) yields null, so the
// card degrades gracefully rather than throwing.
export function resolveFolderName(
  meta: ProjectMeta | undefined,
  chatId: string,
): string | null {
  if (meta === undefined) {
    return null;
  }
  const chatMeta = meta.chats[chatId];
  const folderId = chatMeta ? chatMeta.folderId : null;
  if (folderId === null || folderId === undefined) {
    return null;
  }
  const folder = meta.folders[folderId];
  return folder ? folder.name : null;
}

// The full set of tag LABELS assigned to a chat, in the chat's stored tag-id
// order, resolving each id to its Tag.label and dropping ids that no longer
// resolve. Returns [] when the chat has no tags or there is no meta. The hover
// card renders [] as "none". Deduping is left to the card builder (displayTags),
// which also drops blank labels.
export function resolveTagLabels(
  meta: ProjectMeta | undefined,
  chatId: string,
): string[] {
  if (meta === undefined) {
    return [];
  }
  const chatMeta = meta.chats[chatId];
  if (chatMeta === undefined || !Array.isArray(chatMeta.tags)) {
    return [];
  }
  const labels: string[] = [];
  for (const tagId of chatMeta.tags) {
    const tag = meta.tags[tagId];
    if (tag !== undefined && typeof tag.label === 'string' && tag.label.length > 0) {
      labels.push(tag.label);
    }
  }
  return labels;
}
