import * as vscode from 'vscode';
import * as fs from 'fs';
import { FlatProvider, FlatChatItem, OPEN_CHAT_COMMAND } from './views/flatProvider';
import {
  FoldersProvider,
  FolderItem,
  ChatMemberItem,
  LinkedChildItem,
  FolderTreeNode,
} from './views/foldersProvider';
import { OrgPanelProvider, ORG_PANEL_VIEW, OrgPanelActions, OrgPanelStateStore } from './views/orgPanelWebview';
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
  PREVIEW_ARCHIVED_CHAT_COMMAND,
  PreviewChatDeps,
  PreviewArchivedChatDeps,
  previewChatBody,
  previewArchivedBody,
} from './commands/previewChatCommand';
import { ChatRecord } from './model/types';
import { findChildByName } from './model/folderTree';
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
import {
  EXPORT_CHAT_COMMAND,
  ExportChatDeps,
  ExportFormat,
  exportChat,
} from './commands/exportChatCommands';
import {
  SHOW_TOKEN_ROLLUP_COMMAND,
  TokenRollupDeps,
  showTokenRollup,
} from './commands/tokenRollupCommand';
import { ExportOrgLayer } from './export/chatExport';
import { writeTextFile } from './store/exportIO';
import { resolveFolderName, resolveStarred, resolveTagLabels } from './views/chatMeta';

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

  // Forward handle to the primary org-panel webview's refresh, assigned once the
  // OrgPanelProvider is constructed (it needs foldersProvider/tagsProvider, built
  // below). Every organization-mutation refresh closure (folder/tag/link/tagging/
  // promote/curation/reconcile) calls through this so the PRIMARY surface re-renders
  // on a mutation, the same way scheduleAutoExport is forwarded. A call before the
  // provider exists (none occur during synchronous activation) is a harmless no-op.
  let refreshOrgPanel: () => void = () => {};

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

  // The encoded project key (the on-disk projects directory name) is resolved ON
  // DEMAND, not frozen here: it is undefined until Claude Code has created a project
  // dir for this workspace, and the dir can appear after activation. The provider
  // re-resolves it on every refresh via FoldersProvider.resolveProjectKey, and the
  // commands share that same resolution through FolderCommandDeps.getProjectKey. The
  // store keys ProjectMeta by this same string.
  //
  // Slice s2-org-panel-webview RETIRES the native Folders TreeView and its
  // drag-and-drop controller: the primary org panel (a WebviewView, registered
  // below) supersedes them. FoldersProvider is KEPT as a non-view service: the
  // folder/link/tag/promote/curation commands still depend on it for on-demand
  // project-key resolution (resolveProjectKey), the link target pick list
  // (chatRecords), the rollup token seam (tokenTotalsByChat), and reveal/home
  // resolution (memberNodeForChat). Its refresh() still fires onDidChangeTreeData,
  // which no longer drives a tree but is harmless; the org panel's refresh is folded
  // into every refresh closure so the primary surface re-renders on a mutation.
  const foldersProvider = new FoldersProvider(workspacePath, store);

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
        refreshOrgPanel();
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

  // The many-to-many tag membership service. Like FoldersProvider, the native Tags
  // TreeView and its drag-and-drop controller are RETIRED in slice
  // s2-org-panel-webview (the org panel renders tag chips and handles tag DnD).
  // TagsProvider is KEPT as a non-view service: the tag commands resolve the project
  // key through it (TagCommandDeps.getProjectKey) and its refresh() participates in
  // the shared refresh closures. Tag-add by drag is handled by the org panel through
  // the webviewDropAdapter, which reuses the UNCHANGED reduceDrop.
  const tagsProvider = new TagsProvider(workspacePath, store);

  // The PRIMARY org-panel webview (slice s2-org-panel-webview). It supersedes the
  // retired native Folders and Tags trees: it renders the section model (Starred,
  // Questions heuristic, the folder hierarchy with per-folder color, Unsorted), tag
  // filter chips, sort and density modes, folder rename, and webview drag-and-drop.
  // The drop path reuses the UNCHANGED reduceDrop through webviewDropAdapter, and the
  // cross-tree dragContext stash is NOT involved (a webview drag is in-process). The
  // shared refresh closure re-renders the flat Chats tree (the accessible fallback),
  // the (now view-less) folders/tags services, the archive view, and this panel, and
  // schedules the opt-in auto-export, so a mutation from any surface keeps all of
  // them consistent. Constructed after both providers exist so their refresh and
  // project-key resolution are available.
  const refreshAllOrgSurfaces = (): void => {
    flatProvider.refresh();
    foldersProvider.refresh();
    tagsProvider.refresh();
    refreshOrgPanel();
    scheduleAutoExport();
  };
  // The org panel's rename/color actions route through the existing store mutations
  // (the same setFolderColor the schema/store slice added, and a direct rename via
  // upsertFolder preserving the folder's parent/order) then flush + refresh once, so
  // the webview never couples to the command layer or invents a new write path.
  const orgPanelActions: OrgPanelActions = {
    renameFolder: async (folderId: string, name: string): Promise<void> => {
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      const meta = store.getProjectMeta(projectKey);
      const existing = meta.folders[folderId];
      if (existing === undefined) {
        return;
      }
      const trimmed = name.trim();
      // Enforce the SAME rename invariants the native renameFolder command does
      // (folderCommands.ts): no slash (a rename sets one name; nesting is via New
      // Folder), and no sibling-name collision under the same parent (sibling-name
      // uniqueness backs the assign-to-folder picker and the slash-path round-trip).
      // A violating rename is silently ignored here; the webview keeps the old name.
      if (trimmed.length === 0 || trimmed === existing.name || trimmed.includes('/')) {
        return;
      }
      const sibling = findChildByName(meta.folders, existing.parentId, trimmed);
      if (sibling !== null && sibling.id !== existing.id) {
        void vscode.window.showErrorMessage('A folder with that name already exists here.');
        return;
      }
      store.upsertFolder(projectKey, { ...existing, name: trimmed });
      await store.flush();
      refreshAllOrgSurfaces();
    },
    setFolderColor: async (folderId: string, color: string | null): Promise<void> => {
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      store.setFolderColor(projectKey, folderId, color);
      await store.flush();
      refreshAllOrgSurfaces();
    },
    deleteFolder: async (folderId: string): Promise<void> => {
      // Reuse the existing deleteFolder command (modal confirm + descendant
      // cascade + unfile, never deleting a chat). It takes a FolderItem; build one
      // from the live folder record. folderDeps.provider.refresh already folds in
      // refreshOrgPanel, so the panel re-renders after the delete.
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      const folder = store.getProjectMeta(projectKey).folders[folderId];
      if (folder === undefined) {
        return;
      }
      const item = new FolderItem(folder.id, folder.parentId, folder.name, false);
      await deleteFolder(folderDeps, item);
    },
  };
  // The org panel's webview drop deps: the adapter applies the reducer's intents as
  // one coalesced write, then this refresh re-renders every org surface.
  const orgPanelDropDeps = {
    store,
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    refresh: () => refreshAllOrgSurfaces(),
  };
  // Persist the user's sort/density choice on workspaceState (per-workspace, not
  // synced) so the panel reopens in the same mode without expanding the sync surface.
  const orgPanelStateStore: OrgPanelStateStore = {
    get: (key: string) => context.workspaceState.get<string>(key),
    set: (key: string, value: string) => void context.workspaceState.update(key, value),
  };
  const orgPanelProvider = new OrgPanelProvider(
    context.extensionUri,
    workspacePath,
    store,
    () => foldersProvider.resolveProjectKey(),
    orgPanelActions,
    orgPanelDropDeps,
    orgPanelStateStore,
    context.globalStorageUri,
  );
  refreshOrgPanel = () => orgPanelProvider.refresh();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ORG_PANEL_VIEW, orgPanelProvider),
  );

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
        refreshOrgPanel();
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
    // Refresh both membership services and the primary org panel after a
    // multi-select tag change.
    provider: {
      refresh: () => {
        tagsProvider.refresh();
        foldersProvider.refresh();
        refreshOrgPanel();
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
        refreshOrgPanel();
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
        refreshOrgPanel();
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
  // patch "KEEP-WINDOW SETTING MECHANISM"). Evaluated at each prune invocation, which
  // currently runs once per activation, so a mid-session settings change applies on
  // the next window reload.
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
        refreshOrgPanel();
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
    // READ-ONLY existence check (fs.existsSync is not a write verb, so it clears the
    // read-only lint bank). Restore uses this to gate the body-copy delete: on a
    // copy-only archived row whose transcript Claude already cleaned up, the copy is
    // the sole surviving form, so it must be kept.
    transcriptExists: (filePath: string) => {
      try {
        return fs.existsSync(filePath);
      } catch {
        return false;
      }
    },
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

  // The live-store backstop for the prune. A body copy carries its OWN snapshot of
  // {archivedAt, starred}, kept current only best-effort, and archivedAt is a synced
  // scalar arbitrated by per-record LWW: a foreign device can win an OLDER archivedAt
  // that drives the copy's recorded snapshot past the keep-window even though THIS
  // user still wants the chat archived. So before deleting a copy whose snapshot says
  // prune, re-check the LIVE synced state: if the chat is still userArchived, force
  // keep, regardless of starred. Archive itself is the user's "keep this" signal (a
  // star is a stronger emphasis, not the only thing worth keeping), and after Claude's
  // cleanup the copy is the chat's only durable form, so an unstarred-but-archived
  // chat must never be pruned out from under a foreign-LWW-adopted older archivedAt.
  // Reads the synced meta (no write, so the sync surface is unchanged). Resolves the
  // project key on demand; when no project is resolved, nothing is protected (the
  // prune then trusts the copy snapshot alone, as before).
  const isArchivedCopyLiveProtected = (sessionId: string): boolean => {
    const projectKey = foldersProvider.resolveProjectKey();
    if (projectKey === undefined) {
      return false;
    }
    const chat = store.getProjectMeta(projectKey).chats[sessionId];
    if (chat === undefined) {
      return false;
    }
    return chat.userArchived === true;
  };

  // Prune lapsed body copies on activation (best-effort, fire-and-forget): a copy
  // past the keep-window and not starred is removed UNLESS the live synced state
  // still protects it (a starred chat whose copy snapshot drifted stale-false). A
  // failure never blocks activation.
  void pruneArchivedBodies(
    context.globalStorageUri,
    keepWindowDays(),
    Date.now(),
    isArchivedCopyLiveProtected,
  );
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

  // The "Preview Archived Copy" command (Slice 4): the READ counterpart to the
  // archived body copy. It renders the Nest-owned copy (globalStorage) for one
  // archived chat, so the saved bodies are reachable AFTER Claude cleans up the live
  // transcript. The body source is the copy (by sessionId), not a transcript path,
  // which is exactly why this path survives cleanup. Fires from an archived row (its
  // default click when the transcript is gone, and its context action always) or
  // from a sessionId string argument.
  const previewArchivedChatDeps: PreviewArchivedChatDeps = {
    readArchivedBody: (sessionId: string) =>
      readArchivedBody(context.globalStorageUri, sessionId),
    openPreview: async (content: string) => {
      const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    showInfo: (message: string) => void vscode.window.showInformationMessage(message),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      PREVIEW_ARCHIVED_CHAT_COMMAND,
      (item?: ArchivedChatItem | string) => {
        const sessionId =
          typeof item === 'string'
            ? item
            : item instanceof ArchivedChatItem
              ? item.sessionId
              : undefined;
        return sessionId !== undefined
          ? previewArchivedBody(previewArchivedChatDeps, sessionId)
          : undefined;
      },
    ),
  );

  // The "Export Chat" command (Slice 5): exports ONE chat to Markdown or JSON via the
  // GUARDED exportIO write. The org layer (folder name, full tag set, starred, link
  // target ids) is resolved on demand from the current ProjectMeta via the chatMeta
  // resolvers so the export carries the live curation state; the body is read once via
  // bodyReader and discarded. The write goes through exportIO.writeTextFile, which
  // runtime-asserts the target is not under ~/.claude/projects, so an export the user
  // navigates into a transcript dir is refused. Fires from a chat row in any view.
  const exportChatDeps: ExportChatDeps = {
    pickFormat: async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Markdown', description: 'Front-matter org layer plus the chat body', format: 'markdown' as ExportFormat },
          { label: 'JSON', description: 'A single round-trippable JSON document', format: 'json' as ExportFormat },
        ],
        { placeHolder: 'Export this chat as...' },
      );
      return picked ? picked.format : null;
    },
    showSaveDialog: async (format, suggestedName) => {
      const filters: { [name: string]: string[] } =
        format === 'markdown' ? { Markdown: ['md'] } : { JSON: ['json'] };
      const target = await vscode.window.showSaveDialog({
        title: 'Export chat',
        saveLabel: 'Export',
        filters,
        defaultUri: vscode.Uri.joinPath(context.globalStorageUri, suggestedName),
      });
      return target ?? null;
    },
    resolveOrgLayer: (sessionId: string): ExportOrgLayer => {
      const projectKey = foldersProvider.resolveProjectKey();
      const meta = projectKey !== undefined ? store.getProjectMeta(projectKey) : undefined;
      const chat = meta?.chats[sessionId];
      return {
        folder: resolveFolderName(meta, sessionId),
        tags: resolveTagLabels(meta, sessionId),
        starred: resolveStarred(meta, sessionId),
        links: chat ? chat.links.map((l) => l.targetChatId) : [],
      };
    },
    writeExport: (target, content) => writeTextFile(target as vscode.Uri, content),
    showInfo: (message: string) => void vscode.window.showInformationMessage(message),
    showError: (message: string) => void vscode.window.showErrorMessage(message),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      EXPORT_CHAT_COMMAND,
      (item?: FlatChatItem | ChatMemberItem | ChatOccurrenceItem) => {
        const record = chatRecordFrom(item);
        return record ? exportChat(exportChatDeps, record) : undefined;
      },
    ),
  );

  // The "Show Token Cost Rollup" command (Slice 5): rolls up tier-A token totals by
  // folder and by tag (tokens only, NO USD) and opens the report in a read-only
  // document. The id set comes from FoldersProvider.chatRecords() and the per-chat
  // token totals from the narrow tokenTotalsByChat() seam (chatRecords() drops
  // tokenTotals); the pure reducer + renderer build the report and never read the
  // provider. The lightest surface that meets the AC (a virtual read-only document)
  // avoids a webview/CSP dependency.
  const tokenRollupDeps: TokenRollupDeps = {
    getChatIds: () => Array.from(foldersProvider.chatRecords().keys()),
    getTokenTotals: () => foldersProvider.tokenTotalsByChat(),
    getProjectMeta: () => {
      const projectKey = foldersProvider.resolveProjectKey();
      return projectKey !== undefined ? store.getProjectMeta(projectKey) : null;
    },
    openReport: async (content: string) => {
      const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    showInfo: (message: string) => void vscode.window.showInformationMessage(message),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_TOKEN_ROLLUP_COMMAND, () =>
      showTokenRollup(tokenRollupDeps),
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
      refreshOrgPanel();
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
