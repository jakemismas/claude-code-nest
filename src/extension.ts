import * as vscode from 'vscode';
import { FlatProvider, FlatChatItem, OPEN_CHAT_COMMAND } from './views/flatProvider';
import {
  FoldersProvider,
  FolderItem,
  ChatMemberItem,
  LinkedChildItem,
  FolderTreeNode,
} from './views/foldersProvider';
import { ChatsPreviewProvider, CHATS_PREVIEW_VIEW } from './views/chatsPreviewWebview';
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
import { OPEN_SETTINGS_COMMAND, openSettingsWebview } from './settings/settingsWebview';
import {
  AutoExporter,
  EXPORT_COMMAND,
  IMPORT_COMMAND,
  ExportImportDeps,
  exportLibrary,
  importLibrary,
  maybePromptAutoExport,
  reconcileAllProjects,
} from './commands/exportImportCommands';
import {
  RefreshScanUi,
  ScanPrimable,
  refreshWithProgress,
} from './commands/refreshScanCommands';
import {
  PREVIEW_CHAT_COMMAND,
  PreviewChatDeps,
  previewChatBody,
} from './commands/previewChatCommand';
import { ChatRecord } from './model/types';
import { ArchiveProvider, ArchivedChatItem } from './views/archiveProvider';
import {
  STAR_CHAT_COMMAND,
  UNSTAR_CHAT_COMMAND,
  ARCHIVE_CHAT_COMMAND,
  RESTORE_CHAT_COMMAND,
  CurationCommandDeps,
  CurationTarget,
  starChat,
  unstarChat,
  archiveChat,
  restoreChat,
} from './commands/curationCommands';
import { readTranscriptBodies } from './claude/bodyReader';
import {
  writeArchivedBody,
  deleteArchivedBody,
  updateStarFlag,
  readArchivedBody,
  pruneArchivedBodies,
} from './store/archiveBodyStore';
import { coerceKeepWindowDays } from './store/archiveRetention';

// Entry point for the Claude Code Nest extension. Slice 0 contributes the
// claudeNest Activity Bar view container and the claudeNest.flat chat list, and
// wires the open-chat command to Claude's documented URI handler. Slice 1 stands
// up the MetadataStore over context.globalState. Later slices add the Folders,
// Tags, Links, Smart Groups, and Settings surfaces here.
// The active store, held so deactivate() can await a final flush. VSCode awaits
// a Thenable returned from deactivate() during shutdown, which is the reliable
// teardown hook for persisting writes staged within the debounce window.
let activeStore: MetadataStore | undefined;

// The active auto-exporter, held so deactivate() can cancel a pending debounced
// snapshot at shutdown.
let activeAutoExporter: AutoExporter | undefined;

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

  // Forward handle to the debounced opt-in auto-export. The AutoExporter is
  // constructed lower (it shares the export/import deps), but the user's own
  // organization-mutation refresh closures (folder/tag/link/tagging/promote) are
  // built ABOVE it, so they call through this indirection. Without it the snapshot
  // would only fire on import/reconcile merges, never on the user's own edits,
  // defeating the feature's stated purpose (PLAN.md slice 8: a backup of the user's
  // work, snapshotted on a sync-time change). Assigned once the AutoExporter exists;
  // a mutation before that point (none occur during synchronous activation) is a
  // harmless no-op.
  let scheduleAutoExport: () => void = () => {};

  // The shared progress + cancellation UI for the explicit Refresh commands
  // (Polish slice). vscode.window.withProgress shows a cancellable notification
  // while a provider primes its snapshot via a transcript scan; the scanner stays
  // vscode-free and receives only the plain onProgress/shouldCancel callbacks. The
  // passive getChildren/getParent path is unaffected and stays synchronous.
  const refreshScanUi: RefreshScanUi = {
    withProgress: (title, work) =>
      Promise.resolve(
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: true,
          },
          (progress, token) => {
            let last = 0;
            const report = (done: number, total: number): void => {
              if (total <= 0) {
                return;
              }
              const pct = Math.min(100, Math.round((done / total) * 100));
              const increment = pct - last;
              last = pct;
              if (increment > 0) {
                progress.report({ increment, message: done + ' of ' + total });
              }
            };
            return Promise.resolve(work(report, () => token.isCancellationRequested));
          },
        ),
      ),
    showError: (message) => void vscode.window.showErrorMessage(message),
  };
  const runRefreshScan = (provider: ScanPrimable, scanLabel: string): Promise<void> =>
    refreshWithProgress({ provider, ui: refreshScanUi, scanLabel });

  const flatProvider = new FlatProvider(workspacePath, store);
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

  // PROOF-OF-CONCEPT (Tier 2 webview demo): a webview-rendered twin of the Chats
  // list, registered alongside the native tree so the two render side by side for
  // visual comparison. Same scanChats data, same OPEN_CHAT_COMMAND opener.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHATS_PREVIEW_VIEW,
      new ChatsPreviewProvider(context.extensionUri, workspacePath, context.globalStorageUri),
    ),
  );

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
    provider: {
      refresh: () => {
        foldersProvider.refresh();
        scheduleAutoExport();
      },
    },
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
      runRefreshScan(foldersProvider, 'folders'),
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
    provider: {
      refresh: () => {
        tagsProvider.refresh();
        scheduleAutoExport();
      },
    },
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
      runRefreshScan(tagsProvider, 'tags'),
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
        scheduleAutoExport();
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
    provider: {
      refresh: () => {
        foldersProvider.refresh();
        scheduleAutoExport();
      },
    },
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
        scheduleAutoExport();
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
      runRefreshScan(smartGroupsProvider, 'smart groups'),
    ),
  );

  // The claudeNest.archive view (Slice 4): a flat, read-mostly list of the chats
  // the user has user-archived (the SYNCED ChatMeta.userArchived flag, NOT the
  // local orphan flag). Registered WITHOUT a dragAndDropController (archive/restore
  // are commands, matching the smartGroups read-only registration shape). The
  // provider resolves the project key on demand like the others.
  const archiveProvider = new ArchiveProvider(workspacePath, store);
  const archiveView = vscode.window.createTreeView('claudeNest.archive', {
    treeDataProvider: archiveProvider,
    showCollapseAll: false,
    // No dragAndDropController: archive/restore are commands, not drops.
  });
  context.subscriptions.push(archiveView);

  // Read the configured keep-window (the extension's FIRST contributes.configuration
  // value) in the vscode-thin layer and coerce it to a plain keepWindowDays number
  // here, so the pure archiveRetention policy never reads getConfiguration (slice
  // patch "KEEP-WINDOW SETTING MECHANISM"). Re-read on each prune so a settings
  // change takes effect without a reload.
  const keepWindowDays = (): number =>
    coerceKeepWindowDays(
      vscode.workspace.getConfiguration('claudeNest').get<number>('archiveKeepWindowDays'),
    );

  // Load fallback titles for archived chats whose transcript was cleaned up out of
  // band, from the Nest-owned body copies, and hand them to the provider so a
  // missing-transcript row shows its stored title instead of a raw UUID. Async and
  // best-effort: getChildren stays synchronous and reads whatever titles have loaded.
  const loadArchiveFallbackTitles = async (): Promise<void> => {
    const ids = archiveProvider.archivedSessionIds();
    const titles = new Map<string, string>();
    for (const id of ids) {
      const env = await readArchivedBody(context.globalStorageUri, id);
      if (env !== null && typeof env.title === 'string' && env.title.length > 0) {
        titles.set(id, env.title);
      }
    }
    if (titles.size > 0) {
      archiveProvider.setFallbackTitles(titles);
    }
  };

  // The curation commands (STAR/UNSTAR/ARCHIVE/RESTORE). A curation change alters
  // the Archive view membership and the star badge across every chat surface, so the
  // refresh re-renders all chat views plus the archive view and schedules the opt-in
  // auto-export snapshot (a synced scalar changed). The archive body IO is wired to
  // archiveBodyStore (-> exportIO, guarded); the body read to bodyReader.
  const curationDeps: CurationCommandDeps = {
    store,
    provider: {
      refresh: () => {
        flatProvider.refresh();
        foldersProvider.refresh();
        tagsProvider.refresh();
        archiveProvider.refresh();
        scheduleAutoExport();
        // Re-load fallback titles for any newly-archived chat whose transcript may
        // already be gone (and to drop titles for restored chats). Fire-and-forget.
        void loadArchiveFallbackTitles();
      },
    },
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    readBody: (filePath: string) => readTranscriptBodies(filePath),
    writeBody: (envelope) => writeArchivedBody(context.globalStorageUri, envelope),
    deleteBody: (sessionId: string) => deleteArchivedBody(context.globalStorageUri, sessionId),
    updateBodyStarFlag: (sessionId: string, starred: boolean) =>
      updateStarFlag(context.globalStorageUri, sessionId, starred),
    now: () => Date.now(),
    showInfo: (message: string) => void vscode.window.showInformationMessage(message),
    showError: (message: string) => void vscode.window.showErrorMessage(message),
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(STAR_CHAT_COMMAND, (item?: CurationClickable) => {
      const target = curationTargetFrom(item);
      return target ? starChat(curationDeps, target) : undefined;
    }),
    vscode.commands.registerCommand(UNSTAR_CHAT_COMMAND, (item?: CurationClickable) => {
      const target = curationTargetFrom(item);
      return target ? unstarChat(curationDeps, target) : undefined;
    }),
    vscode.commands.registerCommand(ARCHIVE_CHAT_COMMAND, (item?: CurationClickable) => {
      const target = curationTargetFrom(item);
      return target ? archiveChat(curationDeps, target) : undefined;
    }),
    vscode.commands.registerCommand(RESTORE_CHAT_COMMAND, (item?: CurationClickable) => {
      const target = curationTargetFrom(item);
      return target ? restoreChat(curationDeps, target) : undefined;
    }),
    vscode.commands.registerCommand('claudeNest.refreshArchive', async () => {
      await runRefreshScan(archiveProvider, 'archive');
      void loadArchiveFallbackTitles();
    }),
  );

  // Prune lapsed body copies on activation (best-effort, fire-and-forget): a copy
  // past the keep-window and not starred is removed. Starred copies are exempt
  // (archiveRetention.decideRetention). A failure never blocks activation.
  void pruneArchivedBodies(context.globalStorageUri, keepWindowDays(), Date.now());
  // Prime the archive fallback titles once on activation so a missing-transcript row
  // shows its stored title from the first render.
  void loadArchiveFallbackTitles();

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
    vscode.commands.registerCommand('claudeNest.refresh', () =>
      runRefreshScan(flatProvider, 'chats'),
    ),
  );

  // The "Preview Full Chat" command (Slice 1): the on-demand single-chat body
  // reader's production caller. It opens the clicked chat's FULL prose in a
  // read-only editor document by reading ONE transcript via bodyReader and
  // discarding the bodies. The pure formatter and orchestrator live in
  // previewChatCommand.ts; here we wire the real document open. Fires from a chat
  // row in any view (Chats, Folders, Tags occurrence), each of which carries the
  // shared ChatRecord on .record.
  const previewChatDeps: PreviewChatDeps = {
    openPreview: async (content: string) => {
      const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    showInfo: (message: string) => void vscode.window.showInformationMessage(message),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      PREVIEW_CHAT_COMMAND,
      (item?: FlatChatItem | ChatMemberItem | ChatOccurrenceItem) => {
        const record = chatRecordFrom(item);
        return record ? previewChatBody(previewChatDeps, record) : undefined;
      },
    ),
  );

  // The Settings gear (Slice 7): opens a CSP-locked, nonce-scripted WebviewPanel
  // that reads and surgically edits cleanupPeriodDays in Claude's settings.json,
  // routed through the read-only chokepoint. context.extensionUri is needed so the
  // webview can build asWebviewUri asset URLs and set localResourceRoots to the
  // shipped media dir.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, () =>
      openSettingsWebview(context.extensionUri),
    ),
  );

  // Slice 8: export/import plus cross-machine sync hardening. The export writes
  // ALL projects (with stamps) to a user-chosen JSON as the authoritative backup;
  // import validates and migrates a scratch copy then atomically swaps and merges
  // additively per project (never deleting an absent project). The additive
  // cross-machine reconcile runs on activation and on window focus (best-effort
  // polling; there is no Memento remote-change event), unioning tags and links and
  // applying LWW-per-folderId by updatedAt, and surfaces the honest LWW warning. A
  // debounced opt-in auto-export snapshot with retention writes to globalStorage.
  //
  // All filesystem IO here goes through vscode.workspace.fs (a vscode API, not
  // node fs), so the export/import file writes never trip the read-only lint bank
  // and need no new chokepoint carve-out; the pure store modules stay vscode-free.
  const autoExporter = new AutoExporter({
    store,
    globalStorageUri: context.globalStorageUri,
    flags: {
      get: (key: string) => context.globalState.get<boolean>(key),
      update: (key: string, value: boolean) => context.globalState.update(key, value),
    },
    deviceId,
    refresh: () => {
      foldersProvider.refresh();
      tagsProvider.refresh();
      smartGroupsProvider.refresh();
      archiveProvider.refresh();
    },
  });
  activeAutoExporter = autoExporter;
  context.subscriptions.push({ dispose: () => autoExporter.dispose() });
  // Now that the AutoExporter exists, point the forward handle at it so the
  // user's own organization mutations (folder/tag/link/tagging/promote refresh
  // closures above) schedule a debounced snapshot. schedule() is a no-op when the
  // opt-in flag is off, so this is inert until the user enables auto-export.
  scheduleAutoExport = () => autoExporter.schedule();

  // The export/import deps. refresh re-renders every membership view after a
  // reconcile/import applies merges, and schedules a debounced auto-export
  // snapshot so a sync-time change is captured to the backup dir.
  const exportImportDeps: ExportImportDeps = {
    store,
    globalStorageUri: context.globalStorageUri,
    flags: {
      get: (key: string) => context.globalState.get<boolean>(key),
      update: (key: string, value: boolean) => context.globalState.update(key, value),
    },
    deviceId,
    refresh: () => {
      foldersProvider.refresh();
      tagsProvider.refresh();
      smartGroupsProvider.refresh();
      archiveProvider.refresh();
      autoExporter.schedule();
    },
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(EXPORT_COMMAND, () =>
      exportLibrary(exportImportDeps),
    ),
    vscode.commands.registerCommand(IMPORT_COMMAND, () =>
      importLibrary(exportImportDeps),
    ),
  );

  // Reconcile on ACTIVATION: a foreign-device sync write may have landed while
  // this window was closed. The extension activates on its first view open (the
  // onView:* events), which is early enough to reconcile before the user touches
  // organization. Best-effort and fire-and-forget; a failure must never block
  // activation.
  void reconcileAllProjects(exportImportDeps);

  // Reconcile on window FOCUS: the only signal available for a Settings Sync
  // remote write (no Memento change event). Poll on focus-gain (state.focused) so
  // a foreign write that landed while the window was in the background is merged
  // when the user returns. Pushed to subscriptions so it is disposed on shutdown.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void reconcileAllProjects(exportImportDeps);
      }
    }),
  );

  // The one-time opt-in prompt for the auto-export snapshot and the
  // synced/git-tracked canonical export location. Fire-and-forget; shown once.
  void maybePromptAutoExport(exportImportDeps);
}

export function deactivate(): Thenable<void> | void {
  // Persist any write staged within the debounce window before the host tears
  // the extension down. VSCode awaits a returned Thenable here, so this is the
  // reliable flush point at window close (the subscription dispose also flushes,
  // but its promise is not awaited by the host).
  const store = activeStore;
  activeStore = undefined;
  // Cancel any pending debounced auto-export snapshot so it cannot fire during
  // teardown. The snapshot is best-effort; the store flush below persists the
  // authoritative live data.
  if (activeAutoExporter) {
    activeAutoExporter.dispose();
    activeAutoExporter = undefined;
  }
  if (store) {
    return store.flush();
  }
}

// Recover the shared ChatRecord from a clicked chat row in any view (Chats,
// Folders member, Tags occurrence). All three wrappers dereference the ONE shared
// ChatRecord (ARCHITECTURE.md tree binding rule). A non-chat node yields undefined,
// so the Preview Full Chat command is a no-op on a folder/tag/group row.
function chatRecordFrom(
  item?: FlatChatItem | ChatMemberItem | ChatOccurrenceItem,
): ChatRecord | undefined {
  if (
    item instanceof FlatChatItem ||
    item instanceof ChatMemberItem ||
    item instanceof ChatOccurrenceItem
  ) {
    return item.record;
  }
  return undefined;
}

// The chat-row node shapes a curation command (star/unstar/archive/restore) can
// fire on: a flat row, a folder member, a tags occurrence, or an archived row.
type CurationClickable =
  | FlatChatItem
  | ChatMemberItem
  | ChatOccurrenceItem
  | ArchivedChatItem
  | string;

// Recover the CurationTarget (sessionId + filePath + title) from a clicked chat
// row in any view. All chat-row wrappers dereference the ONE shared ChatRecord,
// which carries filePath and title; an ArchivedChatItem whose transcript was
// cleaned up has no record, so it yields a target with an EMPTY filePath (archive
// would read no body, but star/unstar/restore on an already-archived chat need only
// the sessionId). A non-chat node yields undefined, so a curation command is a
// no-op on a folder/tag/group row.
function curationTargetFrom(item?: CurationClickable): CurationTarget | undefined {
  if (typeof item === 'string') {
    return { sessionId: item, filePath: '', title: item };
  }
  if (
    item instanceof FlatChatItem ||
    item instanceof ChatMemberItem ||
    item instanceof ChatOccurrenceItem
  ) {
    return { sessionId: item.record.sessionId, filePath: item.record.filePath, title: item.record.title };
  }
  if (item instanceof ArchivedChatItem) {
    // A present archived chat carries its record (filePath/title); a cleaned-up one
    // has none, so fall back to the sessionId for identity and an empty filePath.
    if (item.record !== undefined) {
      return {
        sessionId: item.record.sessionId,
        filePath: item.record.filePath,
        title: item.record.title,
      };
    }
    return { sessionId: item.sessionId, filePath: '', title: item.sessionId };
  }
  return undefined;
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
