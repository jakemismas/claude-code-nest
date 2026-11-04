// Turns a drop inside the panel webview into store mutations through reduceDrop.
// The webview message carries the dragged chat ids directly, so no dragContext stash is
// needed (that exists only for cross-tree drags). No vscode import.
// A folder row or empty space maps to the Folders view and a tag chip to the Tags view.
// The payload MIME is always the shared chat MIME so the reducer's guard passes.

import { MetadataStore } from '../store/metadataStore';
import {
  DropInput,
  DropIntent,
  DropTargetView,
  NEST_CHAT_MIME,
  reduceDrop,
} from './dropReducer';

// The message the panel webview posts on a drop. targetKind keeps the webview unaware of view ids:
//   'folder': targetId is a folder id, '__unfiled__' or undefined for empty space
//   'tag': targetId is a tag id
export interface WebviewDropMessage {
  sourceChatIds: string[];
  targetKind: 'folder' | 'tag';
  targetId: string | undefined;
}

// The project key is resolved per drop because the project dir can appear after activation.
export interface WebviewDropDeps {
  store: MetadataStore;
  getProjectKey: () => string | undefined;
  refresh: () => void;
}

export function dropInputFromMessage(message: WebviewDropMessage): DropInput {
  const targetView: DropTargetView =
    message.targetKind === 'tag' ? 'claudeNest.tags' : 'claudeNest.folders';
  return {
    payloadMime: NEST_CHAT_MIME,
    sourceChatIds: Array.isArray(message.sourceChatIds) ? message.sourceChatIds : [],
    targetView,
    targetId: message.targetId,
  };
}

// Returns the number of intents applied. An unresolved project key applies nothing and does not refresh.
export async function handleWebviewDrop(
  deps: WebviewDropDeps,
  message: WebviewDropMessage,
): Promise<number> {
  const intents = reduceDrop(dropInputFromMessage(message));
  if (intents.length === 0) {
    return 0;
  }
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return 0;
  }
  applyIntents(deps.store, projectKey, intents);
  // One flush and one refresh cover a multi-select drop.
  await deps.store.flush();
  deps.refresh();
  return intents.length;
}

// One synchronous store call per intent; the store's debounce coalesces them into one write.
function applyIntents(store: MetadataStore, projectKey: string, intents: DropIntent[]): void {
  for (const intent of intents) {
    if (intent.kind === 'setFolder') {
      store.setChatFolder(projectKey, intent.chatId, intent.folderId);
    } else {
      store.addChatTag(projectKey, intent.chatId, intent.tagId);
    }
  }
}
