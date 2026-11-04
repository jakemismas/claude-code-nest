// Pure drop reducer for the drag-and-drop controllers. It maps a drop (payload MIME, dragged
// chat ids, target view and node id) to the ordered store-mutation intents to apply, deciding
// by the target view only: the Tags view adds a tag, the Folders view moves the chat's home.
// It has no vscode import so tests can load it without the host. An unrecognized source yields
// no intents.

// The shared chat MIME that lets a chat dragged from one view drop on the other.
// The namespaced value cannot collide with VS Code's own tree MIME or another extension's.
export const NEST_CHAT_MIME = 'application/vnd.code.tree.claudenest.chat';

// The values match the contributed view ids, so a controller passes its own view id through.
export type DropTargetView = 'claudeNest.folders' | 'claudeNest.tags';

// 'setFolder' sets a chat's single home folder (null unfiles it); 'addTag' adds a tag.
// Each maps to one synchronous store call, and the store's debounce coalesces the burst.
export type DropIntent =
  | { kind: 'setFolder'; chatId: string; folderId: string | null }
  | { kind: 'addTag'; chatId: string; tagId: string };

// payloadMime is undefined or foreign when the drop carries no Nest payload. targetId is undefined
// for a drop on empty space.
export interface DropInput {
  payloadMime: string | undefined;
  sourceChatIds: string[];
  targetView: DropTargetView;
  targetId: string | undefined;
}

// Duplicated from the folder tree so this module imports nothing that could pull in vscode;
// a unit test asserts the values match. A drop on this bucket unfiles the chats.
const UNFILED_FOLDER_ID = '__unfiled__';

// A drop on the Untagged bucket yields no intents: there is no tag to add, and removing tags
// is a context-menu action, not a drag.
const UNTAGGED_TAG_ID = '__untagged__';

// Only the shared chat MIME is accepted. A per-view reserved MIME is rejected so a Folders
// payload cannot tag a chat on the other view.
// Folders view: one 'setFolder' per chat, unfiling when the target is the Unfiled bucket or empty space.
// Tags view: one 'addTag' per chat, none when the target is the Untagged bucket or empty space.
export function reduceDrop(input: DropInput): DropIntent[] {
  if (input.payloadMime !== NEST_CHAT_MIME) {
    return [];
  }

  // A chat listed twice gets one intent, keeping the batch count accurate.
  const chatIds = dedupePreserveOrder(input.sourceChatIds).filter(
    (id) => id.length > 0,
  );
  if (chatIds.length === 0) {
    return [];
  }

  if (input.targetView === 'claudeNest.folders') {
    const folderId =
      input.targetId === undefined || input.targetId === UNFILED_FOLDER_ID
        ? null
        : input.targetId;
    return chatIds.map((chatId) => ({ kind: 'setFolder', chatId, folderId }));
  }

  // Tags view.
  if (
    input.targetId === undefined ||
    input.targetId === UNTAGGED_TAG_ID
  ) {
    return [];
  }
  const tagId = input.targetId;
  return chatIds.map((chatId) => ({ kind: 'addTag', chatId, tagId }));
}

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
