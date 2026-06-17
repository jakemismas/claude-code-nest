import * as vscode from 'vscode';
import { FlatProvider, FlatChatItem, OPEN_CHAT_COMMAND } from './views/flatProvider';
import {
  FoldersProvider,
  FolderItem,
  ChatMemberItem,
  LinkedChildItem,
  FolderTreeNode,
} from './views/foldersProvider';
import { openChat, OpenUri } from './launch/uriLauncher';
import { MetadataStore, SyncMemento } from './store/metadataStore';
import { DeviceIdStore, getOrCreateDeviceId } from './store/deviceId';
import {
  CREATE_FOLDER_COMMAND,
  RENAME_FOLDER_COMMAND,
  DELETE_FOLDER_COMMAND,
  ASSIGN_CHAT_TO_FOLDER_COMMAND,
  FolderCommandDeps,
  FolderCommandUi,
  createFolder,
  renameFolder,
  deleteFolder,
  assignChatToFolder,
} from './commands/folderCommands';
import { TagsProvider, TagItem, ChatOccurrenceItem, TagTreeNode } from './views/tagsProvider';
import {
  CREATE_TAG_COMMAND,
  DELETE_TAG_COMMAND,
  ADD_TAG_TO_CHAT_COMMAND,
  REMOVE_TAG_FROM_CHAT_COMMAND,
  TagCommandDeps,
  TagCommandUi,
  createTag,
  deleteTag,
  addTagToChat,
  removeTagFromChat,
} from './commands/tagCommands';
import {
  NestDragAndDropController,
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
} from './dnd/dndController';
import {
  TAG_CHATS_COMMAND,
  TaggingCommandDeps,
  TagMultiPickUi,
  tagChats,
} from './commands/taggingCommands';
import { showTagMultiPick } from './ui/tagQuickPick';
import {
  LINK_TO_CHAT_COMMAND,
  UNLINK_CHAT_COMMAND,
  LinkCommandDeps,
  LinkCommandUi,
  linkToChat,
  unlinkChat,
} from './commands/linkCommands';
import { Link } from './store/schema';
import {
  SmartGroupsProvider,
  SmartBucketItem,
  SmartTreeNode,
} from './views/smartGroupsProvider';
import {
  PROMOTE_GROUP_TO_FOLDER_COMMAND,
  PROMOTE_GROUP_TO_TAG_COMMAND,
  PromoteDeps,
  PromotableGroup,
  promoteGroupToFolder,
  promoteGroupToTag,
} from './commands/promoteSmartGroup';

// Entry point for the Claude Code Nest extension. Slice 0 contributes the
// claudeNest Activity Bar view container and the claudeNest.flat chat list, and
// wires the open-chat command to Claude's documented URI handler. Slice 1 stands
// up the MetadataStore over context.globalState. Later slices add the Folders,
// Tags, Links, Smart Groups, and Settings surfaces here.
// The active store, held so deactivate() can await a final flush. VSCode awaits
// a Thenable returned from deactivate() during shutdown, which is the reliable
// teardown hook for persisting writes staged within the debounce window.
let activeStore: MetadataStore | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Adapt the real global Memento to the store's structural seams. The vscode
  // binding lives ONLY here; the store and deviceId modules stay vscode-free and
  // headless-testable (ARCHITECTURE.md build contract). context.globalState
  // structurally satisfies SyncMemento (get/update/keys/setKeysForSync) and the
  // DeviceIdStore getter/setter.
  const syncMemento: SyncMemento = context.globalState;
  const deviceIdStore: DeviceIdStore = {
    get: (key: string) => context.globalState.get<string>(key),
    set: (key: string, value: string) => {
      // The device id is install-local identity; it is intentionally NOT
      // registered for sync, so each install keeps its own. The void is
      // deliberate: persistence is fire-and-forget here.
      void context.globalState.update(key, value);
    },
  };
  // No seed: a per-INSTALL random UUID is generated on first run. machineId is a
  // per-MACHINE value (stable across installs/profiles on one computer), so
  // seeding with it would give two installs on the same machine (a second
  // profile, or Insiders + Stable) the SAME device id, defeating the
  // foreign-device overwrite detection the reconcile design depends on
  // (deviceId.ts: "two machines must NOT share it ... each install keeps its
  // own"; ARCHITECTURE.md: "a per-install deviceId").
  const deviceId = getOrCreateDeviceId(deviceIdStore);
  activeStore = new MetadataStore(syncMemento, { deviceId });
  const store = activeStore;
  context.subscriptions.push({ dispose: () => void store.dispose() });

  const flatProvider = new FlatProvider(workspacePath);
  const flatView = vscode.window.createTreeView('claudeNest.flat', {
    treeDataProvider: flatProvider,
    showCollapseAll: false,
    // canSelectMany enables ctrl/shift multi-select in the Chats view so the
    // contributed "Tag Chats..." command receives the full selection and tags
    // every chosen chat in one batched write (TESTING.md Slice 4 step 3). The flat
    // view has NO dragAndDropController, so this only unlocks multi-select for the
    // context-menu/inline tag command, not a drag path.
    canSelectMany: true,
  });
  context.subscriptions.push(flatView);

  // The encoded project key (the on-disk projects directory name) is resolved ON
  // DEMAND, not frozen here: it is undefined until Claude Code has created a project
  // dir for this workspace, and the dir can appear after activation (the Folders
  // view activates on first open, which may precede the first session). The provider
  // re-resolves it on every refresh via FoldersProvider.resolveProjectKey, and the
  // commands share that same resolution through FolderCommandDeps.getProjectKey, so
  // the view and its commands recover on the next Refresh Folders without a window
  // reload. The store keys ProjectMeta by this same string.
  const foldersProvider = new FoldersProvider(workspacePath, store);
  // The Folders-view drag-and-drop controller. It declares its own reserved MIME
  // plus the shared chat MIME, and interprets a drop as a single-home folder move
  // (ARCHITECTURE.md "Drag and drop": interpret by the TARGET view). Constructed
  // here and passed to createTreeView; it is not self-registering.
  const foldersDnd = new NestDragAndDropController<FolderTreeNode>(
    {
      store,
      getProjectKey: () => foldersProvider.resolveProjectKey(),
      provider: foldersProvider,
      // Resolve a dropped-on linked-child row to its chat's home folder id so a
      // drop files the dragged chat ALONGSIDE the linked child instead of
      // unfiling it. memberNodeForChat carries the resolved home (a real folder id
      // or the Unfiled sentinel); undefined when the chat is not currently homed.
      resolveChatHome: (chatId: string) =>
        foldersProvider.memberNodeForChat(chatId)?.folderId,
    },
    'claudeNest.folders',
    FOLDERS_RESERVED_MIME,
  );
  const foldersView = vscode.window.createTreeView('claudeNest.folders', {
    treeDataProvider: foldersProvider,
    showCollapseAll: true,
    // canSelectMany lets a multi-chat drag (and multi-select context-menu tag)
    // carry every selected chat; the controller batches the mutation into one
    // store write and a single refresh (ARCHITECTURE.md "Refresh coalescing").
    canSelectMany: true,
    dragAndDropController: foldersDnd,
  });
  context.subscriptions.push(foldersView);

  const folderUi: FolderCommandUi = {
    prompt: (options) =>
      vscode.window.showInputBox({
        title: options.title,
        placeHolder: options.placeholder,
        value: options.value,
        validateInput: options.validateInput
          ? (value) => options.validateInput?.(value) ?? null
          : undefined,
      }),
    confirmWarning: async (message, confirmLabel) => {
      const picked = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel,
      );
      return picked === confirmLabel;
    },
    pickFolder: async (items, placeholder) => {
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({
          label: item.label,
          description: item.description,
          folderId: item.folderId,
        })),
        { placeHolder: placeholder },
      );
      return picked ? { folderId: picked.folderId } : undefined;
    },
    showError: (message) => void vscode.window.showErrorMessage(message),
  };

  const folderDeps: FolderCommandDeps = {
    store,
    provider: foldersProvider,
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    ui: folderUi,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CREATE_FOLDER_COMMAND,
      (parent?: FolderTreeNode) =>
        createFolder(folderDeps, parent instanceof FolderItem ? parent : undefined),
    ),
    vscode.commands.registerCommand(RENAME_FOLDER_COMMAND, (item?: FolderTreeNode) =>
      item instanceof FolderItem ? renameFolder(folderDeps, item) : undefined,
    ),
    vscode.commands.registerCommand(DELETE_FOLDER_COMMAND, (item?: FolderTreeNode) =>
      item instanceof FolderItem ? deleteFolder(folderDeps, item) : undefined,
    ),
    vscode.commands.registerCommand(
      ASSIGN_CHAT_TO_FOLDER_COMMAND,
      (item?: FolderTreeNode | FlatChatItem | string) => {
        // The command fires from EITHER view (PLAN/TESTING: assign from either
        // list). VSCode passes the right-clicked tree item: a ChatMemberItem from
        // the Folders view or a FlatChatItem from the Chats view (both contextValue
        // 'claudeNest.chat'). A bare sessionId string covers a programmatic caller.
        if (typeof item === 'string') {
          return assignChatToFolder(folderDeps, item);
        }
        if (item instanceof ChatMemberItem) {
          return assignChatToFolder(folderDeps, item);
        }
        if (item instanceof FlatChatItem) {
          return assignChatToFolder(folderDeps, item.record.sessionId);
        }
        return undefined;
      },
    ),
    vscode.commands.registerCommand('claudeNest.refreshFolders', () =>
      foldersProvider.refresh(),
    ),
  );

  // The claudeNest.tags view: the many-to-many tag membership. It resolves the
  // project key on demand exactly like the Folders view, and its commands share
  // that resolution through TagCommandDeps.getProjectKey.
  const tagsProvider = new TagsProvider(workspacePath, store);
  // The Tags-view drag-and-drop controller. It declares its own reserved MIME
  // plus the shared chat MIME, and interprets a drop as a tag-add on the target
  // tag (ARCHITECTURE.md "Drag and drop": interpret by the TARGET view).
  const tagsDnd = new NestDragAndDropController<TagTreeNode>(
    {
      store,
      getProjectKey: () => tagsProvider.resolveProjectKey(),
      provider: tagsProvider,
    },
    'claudeNest.tags',
    TAGS_RESERVED_MIME,
  );
  const tagsView = vscode.window.createTreeView('claudeNest.tags', {
    treeDataProvider: tagsProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: tagsDnd,
  });
  context.subscriptions.push(tagsView);

  const tagUi: TagCommandUi = {
    prompt: (options) =>
      vscode.window.showInputBox({
        title: options.title,
        placeHolder: options.placeholder,
        value: options.value,
        validateInput: options.validateInput
          ? (value) => options.validateInput?.(value) ?? null
          : undefined,
      }),
    confirmWarning: async (message, confirmLabel) => {
      const picked = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel,
      );
      return picked === confirmLabel;
    },
    pickTag: async (items, placeholder) => {
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({
          label: item.label,
          description: item.description,
          tagId: item.tagId,
        })),
        { placeHolder: placeholder },
      );
      return picked ? { tagId: picked.tagId } : undefined;
    },
    showError: (message) => void vscode.window.showErrorMessage(message),
  };

  const tagDeps: TagCommandDeps = {
    store,
    provider: tagsProvider,
    getProjectKey: () => tagsProvider.resolveProjectKey(),
    ui: tagUi,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(CREATE_TAG_COMMAND, () => createTag(tagDeps)),
    vscode.commands.registerCommand(DELETE_TAG_COMMAND, (item?: TagTreeNode) =>
      item instanceof TagItem ? deleteTag(tagDeps, item) : undefined,
    ),
    vscode.commands.registerCommand(
      ADD_TAG_TO_CHAT_COMMAND,
      (item?: TagTreeNode | FlatChatItem | ChatMemberItem | string) => {
        // Fires from EITHER the Folders or Chats view (a chat row) or from the
        // Tags view (an occurrence). A bare sessionId covers a programmatic caller.
        if (typeof item === 'string') {
          return addTagToChat(tagDeps, item);
        }
        if (item instanceof ChatOccurrenceItem) {
          return addTagToChat(tagDeps, item);
        }
        if (item instanceof ChatMemberItem) {
          return addTagToChat(tagDeps, item.record.sessionId);
        }
        if (item instanceof FlatChatItem) {
          return addTagToChat(tagDeps, item.record.sessionId);
        }
        return undefined;
      },
    ),
    vscode.commands.registerCommand(
      REMOVE_TAG_FROM_CHAT_COMMAND,
      (item?: TagTreeNode) =>
        item instanceof ChatOccurrenceItem ? removeTagFromChat(tagDeps, item) : undefined,
    ),
    vscode.commands.registerCommand('claudeNest.refreshTags', () =>
      tagsProvider.refresh(),
    ),
  );

  // The multi-select tag command: the canPickMany QuickPick affordance. It fires
  // from a chat row in ANY view (Chats, Folders) or a tag occurrence in the Tags
  // view, applies to the WHOLE current multi-selection, and refreshes BOTH the
  // Folders and Tags views once (a tag change alters Tags membership and can move
  // a chat out of Untagged, which the Folders view does not render, but refreshing
  // both keeps every surface consistent in one shot).
  const taggingUi: TagMultiPickUi = {
    pickTags: (options, placeholder) => showTagMultiPick(options, placeholder),
    showError: (message) => void vscode.window.showErrorMessage(message),
  };
  const taggingDeps: TaggingCommandDeps = {
    store,
    // Refresh both membership views after a multi-select tag change.
    provider: {
      refresh: () => {
        tagsProvider.refresh();
        foldersProvider.refresh();
      },
    },
    getProjectKey: () => tagsProvider.resolveProjectKey(),
    ui: taggingUi,
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      TAG_CHATS_COMMAND,
      (
        item?: TagTreeNode | FolderTreeNode | FlatChatItem | string,
        selection?: (TagTreeNode | FolderTreeNode | FlatChatItem)[],
      ) => {
        // VSCode passes the clicked node first and the full multi-selection second
        // for a tree context-menu command. Prefer the selection (so a multi-select
        // tags every chosen chat); fall back to the single clicked node, then to a
        // bare sessionId for a programmatic caller.
        const chatIds = collectChatSessionIds(item, selection);
        if (chatIds.length === 0) {
          return undefined;
        }
        return tagChats(taggingDeps, chatIds);
      },
    ),
  );

  // The Links commands: link-to-chat and unlink. A kind:'parent' link nests the
  // target under the source chat in the Folders tree; unlink removes the parent link
  // from a linked child's designated parent. Both refresh the Folders view once
  // after the store flush.
  const linkUi: LinkCommandUi = {
    // Slice 5 ships ONLY the kind:'parent' link (the nesting affordance). A
    // kind:'related' link has no read, navigate, or remove surface yet, so offering
    // it would let a user create an invisible, unremovable link (a write-only dead
    // end). The schema and the pure links model already carry 'related' as a
    // non-nesting kind for a future slice that renders and unlinks it; until then the
    // picker resolves directly to 'parent' with no prompt (a single choice needs no
    // QuickPick). The LinkCommandUi.pickKind seam is retained so the deferred kind can
    // be re-enabled here without touching the command logic.
    pickKind: () => Promise.resolve('parent' as Link['kind']),
    pickChat: async (items, placeholder) => {
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({
          label: item.label,
          description: item.description,
          chatId: item.chatId,
        })),
        { placeHolder: placeholder },
      );
      return picked ? { chatId: picked.chatId } : undefined;
    },
    showError: (message) => void vscode.window.showErrorMessage(message),
    showInfo: (message) => void vscode.window.showInformationMessage(message),
  };
  const linkDeps: LinkCommandDeps = {
    store,
    provider: foldersProvider,
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    getChatRecords: () => foldersProvider.chatRecords(),
    ui: linkUi,
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      LINK_TO_CHAT_COMMAND,
      (item?: FolderTreeNode | FlatChatItem | string) => {
        // Fires from a chat-member row (Folders), a flat row (Chats), or a bare
        // sessionId. A folder row or a linked-child row is not a valid source.
        if (typeof item === 'string') {
          return linkToChat(linkDeps, item);
        }
        if (item instanceof ChatMemberItem) {
          return linkToChat(linkDeps, item.record.sessionId);
        }
        if (item instanceof FlatChatItem) {
          return linkToChat(linkDeps, item.record.sessionId);
        }
        return undefined;
      },
    ),
    vscode.commands.registerCommand(UNLINK_CHAT_COMMAND, (item?: FolderTreeNode) =>
      item instanceof LinkedChildItem ? unlinkChat(linkDeps, item.child) : undefined,
    ),
  );

  // The claudeNest.smartGroups view: read-only, recomputed-on-refresh buckets
  // over the four signals. It scans transcripts (read-only) and writes nothing on
  // its own; the only mutations are the explicit promote commands below, which
  // write synced ProjectMeta through the store exactly like the folder/tag
  // commands. The provider resolves the project key on demand like the others.
  const smartGroupsProvider = new SmartGroupsProvider(workspacePath);
  const smartGroupsView = vscode.window.createTreeView('claudeNest.smartGroups', {
    treeDataProvider: smartGroupsProvider,
    showCollapseAll: true,
    // No dragAndDropController: smart groups are read-only and not a drop target.
  });
  context.subscriptions.push(smartGroupsView);

  // The promote commands turn a chosen bucket into a real folder/tag. A promote
  // creates folders/tags and files/tags member chats, then refreshes the affected
  // views once (folders + tags reflect the new membership; the smart-groups view
  // refreshes so its description counts stay live). The promote is idempotent both
  // on chat membership and on group identity (reuse-by-name); see
  // promoteSmartGroup.ts.
  const promoteDeps: PromoteDeps = {
    store,
    provider: {
      refresh: () => {
        foldersProvider.refresh();
        tagsProvider.refresh();
        smartGroupsProvider.refresh();
      },
    },
    getProjectKey: () => smartGroupsProvider.resolveProjectKey(),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      PROMOTE_GROUP_TO_FOLDER_COMMAND,
      (item?: SmartTreeNode) => {
        const group = promotableFrom(item);
        return group ? promoteGroupToFolder(promoteDeps, group) : undefined;
      },
    ),
    vscode.commands.registerCommand(
      PROMOTE_GROUP_TO_TAG_COMMAND,
      (item?: SmartTreeNode) => {
        const group = promotableFrom(item);
        return group ? promoteGroupToTag(promoteDeps, group) : undefined;
      },
    ),
    vscode.commands.registerCommand('claudeNest.refreshSmartGroups', () =>
      smartGroupsProvider.refresh(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CHAT_COMMAND, (sessionId: string) => {
      // Compose vscode.Uri.from with vscode.env.openExternal as the injected
      // opener. The launcher builds the OpenUri; here we adapt it to a real Uri.
      return openChat(sessionId, (uri: OpenUri) =>
        vscode.env.openExternal(
          vscode.Uri.from({
            scheme: uri.scheme,
            authority: uri.authority,
            path: uri.path,
            query: uri.query,
          }),
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNest.refresh', () => flatProvider.refresh()),
  );
}

export function deactivate(): Thenable<void> | void {
  // Persist any write staged within the debounce window before the host tears
  // the extension down. VSCode awaits a returned Thenable here, so this is the
  // reliable flush point at window close (the subscription dispose also flushes,
  // but its promise is not awaited by the host).
  const store = activeStore;
  activeStore = undefined;
  if (store) {
    return store.flush();
  }
}

// Recover a PromotableGroup from a clicked Smart Groups row. Only a bucket row
// (SmartBucketItem) is promotable; a group row or chat row contributes nothing.
// The bucket's label becomes the folder name / tag label and its memberChatIds
// the chats to file/tag.
function promotableFrom(item?: SmartTreeNode): PromotableGroup | undefined {
  if (item instanceof SmartBucketItem) {
    return {
      name: item.bucket.label,
      memberChatIds: item.bucket.memberChatIds,
    };
  }
  return undefined;
}

// Recover the dragged/clicked chats' sessionIds from a tag-command invocation.
// VSCode passes the clicked node first and the full multi-selection second for a
// tree context-menu command. The selection (when present) wins so a multi-select
// tags every chosen chat; otherwise the single clicked node is used, then a bare
// sessionId string for a programmatic caller. A chat node resolves to its
// record.sessionId (Folders/Chats) or its occurrence chat (Tags); a folder/tag
// row contributes nothing. The result is de-duplicated in first-seen order.
function collectChatSessionIds(
  item: TagTreeNode | FolderTreeNode | FlatChatItem | string | undefined,
  selection: (TagTreeNode | FolderTreeNode | FlatChatItem)[] | undefined,
): string[] {
  const nodes =
    selection !== undefined && selection.length > 0
      ? selection
      : typeof item === 'object' && item !== undefined
        ? [item]
        : [];
  const ids: string[] = [];
  if (typeof item === 'string') {
    ids.push(item);
  }
  for (const node of nodes) {
    if (node instanceof ChatOccurrenceItem) {
      ids.push(node.record.sessionId);
    } else if (node instanceof ChatMemberItem) {
      ids.push(node.record.sessionId);
    } else if (node instanceof FlatChatItem) {
      ids.push(node.record.sessionId);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
