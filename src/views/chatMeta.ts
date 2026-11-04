import { ProjectMeta } from '../store/schema';

// Pure, vscode-free resolvers from a project's curation document to the folder name,
// starred flag and tag labels that every chat-row builder feeds the hover card.

// The home-folder name for a chat, or null when it is unfiled, its folder is gone, or
// meta is missing. The hover card renders null as "Unfiled".
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

// Whether a chat has the synced starred flag, the same one the star command writes and
// the Archive view reads. Never consults local-only orphan state.
export function resolveStarred(
  meta: ProjectMeta | undefined,
  chatId: string,
): boolean {
  if (meta === undefined) {
    return false;
  }
  const chatMeta = meta.chats[chatId];
  return chatMeta?.starred === true;
}

// Tag labels for a chat in stored order, skipping ids that no longer resolve. The card
// builder (displayTags) does the deduping.
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
