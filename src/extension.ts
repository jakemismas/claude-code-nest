import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  FoldersProvider,
  FolderItem,
  ChatMemberItem,
  LinkedChildItem,
  FolderTreeNode,
} from './views/foldersProvider';
import {
  OrgPanelProvider,
  ORG_PANEL_VIEW,
  OrgPanelActions,
  OrgPanelStateStore,
  OPEN_SETTINGS_COMMAND,
} from './views/orgPanelWebview';
import { ReadStateStore } from './views/readState';
import { matchTabLabelToChat, isClaudeChatViewType } from './views/tabFocusMatch';
import { OPEN_CHAT_COMMAND, openChat, OpenUri } from './launch/uriLauncher';
import { launchNewSession } from './launch/newSessionLauncher';
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
  linkToChatFromPalette,
  unlinkChat,
  unlinkChatFromPalette,
} from './commands/linkCommands';
import { Link, isValidColor } from './store/schema';
import { mintTagId } from './model/idFactory';
import {
  PROMOTE_GROUP_TO_FOLDER_COMMAND,
  PROMOTE_GROUP_TO_TAG_COMMAND,
  PromoteDeps,
  PromotableGroup,
  promoteGroupToFolder,
  promoteGroupToTag,
} from './commands/promoteSmartGroup';
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
  hasArchivedBody,
} from './store/archiveBodyStore';
import { coerceKeepWindowDays } from './store/archiveRetention';
import { runAutoArchivePass, AutoArchiveChat } from './store/autoArchiveEngine';
import {
  readCleanupPeriodDays,
  CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS,
} from './settings/claudeSettingsIO';
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

// Entry point for the Claude Code Nest extension. It contributes the claudeNest
// Activity Bar view container, wires the open-chat command to Claude's documented
// URI handler, and stands up the MetadataStore over context.globalState. Slice
// s3a-view-consolidation retired the flat Chats and Smart Groups trees: the org
// panel webview is the ONLY browsing surface (UI-SPEC.md deviation 5), with the
// Archive tree and the settings editor tab surviving until part 2 ships their
// in-panel replacements.
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

  // Forward handle to the auto-archive engine pass (slice s3b-settings-overlay, issue
  // #86), assigned once the OrgPanelProvider and the archive-body seams exist (it reads
  // the provider's scan + the current auto-archive window). Called on activation, after
  // a scan refresh, and when the user changes the window in the Settings overlay. A
  // call before it is assigned (none occur during synchronous activation before the
  // provider is built) is a harmless no-op.
  let runAutoArchiveNow: () => Promise<void> = () => Promise.resolve();

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
      (item?: FolderTreeNode | string) => {
        // With the trees retired (slice s3a-view-consolidation) no view mints a
        // chat row for this command any more; a ChatMemberItem still resolves for
        // a legacy caller, and a bare sessionId string covers a programmatic one.
        if (typeof item === 'string') {
          return assignChatToFolder(folderDeps, item);
        }
        if (item instanceof ChatMemberItem) {
          return assignChatToFolder(folderDeps, item);
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

  // The PRIMARY org-panel webview (slice s2-org-panel-webview; the SOLE browsing
  // surface since slice s3a-view-consolidation, UI-SPEC.md deviation 5). It renders
  // the section model (Starred, Questions heuristic, the folder hierarchy with
  // per-folder color, Unsorted), tag filter chips, sort and density modes, folder
  // rename, and webview drag-and-drop. The drop path reuses the UNCHANGED
  // reduceDrop through webviewDropAdapter, and the cross-tree dragContext stash is
  // NOT involved (a webview drag is in-process). The shared refresh closure
  // re-renders the (view-less) folders/tags services and this panel, and schedules
  // the opt-in auto-export, so a mutation from any surface keeps all of them
  // consistent. Constructed after both providers exist so their refresh and
  // project-key resolution are available.
  const refreshAllOrgSurfaces = (): void => {
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
    createFolder: async (name?: string): Promise<void> => {
      // Reuse the existing createFolder command (store mutation + slash-path
      // expansion + the one-sublevel depth cap). When the in-panel "New folder"
      // popover supplies a name (issue #82 AC3), pass it as presetName so the command
      // skips its native input box; otherwise it prompts as before.
      // folderDeps.provider.refresh folds in refreshOrgPanel, so the panel
      // re-renders with the new folder after it is created.
      await createFolder(folderDeps, undefined, name);
    },
    newSession: async (): Promise<void> => {
      // Best-effort launch of a new Claude Code chat via the probed contributed
      // command chain (newSessionLauncher). A graceful toast on total failure
      // (UI-SPEC.md deviation 6): the entry points are undocumented Claude Code
      // contact points and may be absent in a given environment.
      const ok = await launchNewSession((command) =>
        vscode.commands.executeCommand(command),
      );
      if (!ok) {
        void vscode.window.showInformationMessage(
          'Could not start a new Claude Code chat. Open Claude Code and start one there.',
        );
      }
    },
    loadArchivedTitles: async (): Promise<Map<string, string>> => {
      // Load the stored body-copy titles for archived chats whose live transcript was
      // cleaned up out of band (issue #87, patch item 3), keyed by sessionId, from the
      // Nest-owned body copies. Read-only (readArchivedBody reads the globalStorage copy);
      // best-effort per id so one unreadable copy does not fail the whole overlay. Only the
      // gone-transcript rows consult this; a present chat's title rides the scan. Uses the
      // panel's scan to find which archived chats are missing (the same records the overlay
      // posts), then reads only those copies.
      const projectKey = foldersProvider.resolveProjectKey();
      const titles = new Map<string, string>();
      if (projectKey === undefined) {
        return titles;
      }
      const meta = store.getProjectMeta(projectKey);
      const scanned = new Set(orgPanelProvider.scanRecords().map((r) => r.sessionId));
      for (const [chatId, chatMeta] of Object.entries(meta.chats)) {
        if (chatMeta.userArchived !== true || scanned.has(chatId)) {
          continue;
        }
        const env = await readArchivedBody(context.globalStorageUri, chatId);
        if (env !== null && typeof env.title === 'string' && env.title.length > 0) {
          titles.set(chatId, env.title);
        }
      }
      return titles;
    },
    restoreArchivedChat: async (sessionId: string): Promise<void> => {
      // Restore from the overlay (issue #87 AC #3): clear the synced userArchived flag,
      // keep the star. Route to the EXISTING restoreChat curation command with a
      // CurationTarget built from the scan record when present (real filePath so the command
      // can delete the now-redundant copy), or an empty filePath when the transcript was
      // cleaned up (a copy-only row) so restoreChat KEEPS the copy (its transcriptExists
      // guard). A missing/unresolvable id still restores the flag with an empty filePath.
      const record = orgPanelProvider.resolveRecord(sessionId);
      await restoreChat(curationDeps, {
        sessionId,
        filePath: record?.filePath ?? '',
        title: record?.title ?? sessionId,
      });
    },
    runAutoArchive: async (): Promise<void> => {
      // The user changed the auto-archive window in the Settings overlay; run a fresh
      // pass so a shortened window applies without a window reload (issue #86 AC #4). A
      // no-op when auto-archiving is disabled (Never) or nothing is past the window.
      await runAutoArchiveNow();
    },
    setStarred: async (sessionId: string, starred: boolean): Promise<void> => {
      // Route the row's star toggle to the EXISTING star/unstar curation commands
      // (store.setChatStarred + flush + refresh), so the click persists immediately
      // through the store and the badge updates on every surface. The commands accept a
      // bare sessionId (curationTargetFrom handles a string); starring needs only the
      // id, never the filePath.
      await vscode.commands.executeCommand(
        starred ? STAR_CHAT_COMMAND : UNSTAR_CHAT_COMMAND,
        sessionId,
      );
    },
    toggleChatTag: async (sessionId: string, tagId: string, on: boolean): Promise<void> => {
      // Route the context-menu tag toggle straight to the store's add/remove (which
      // coalesce into one pending write), then flush + refresh, mirroring setStarred so
      // the webview never invents a mutation. addChatTag is a no-op when the tag is
      // already present and removeChatTag when absent, so a redundant toggle is harmless.
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      if (on) {
        store.addChatTag(projectKey, sessionId, tagId);
      } else {
        store.removeChatTag(projectKey, sessionId, tagId);
      }
      await store.flush();
      refreshAllOrgSurfaces();
    },
    createTagWithColor: async (
      sessionId: string,
      label: string,
      color: string | null,
    ): Promise<void> => {
      // Mint a NEW colored tag and apply it to the chat (issue #85 AC #2). The existing
      // createTag command opens a modal prompt and mints a COLORLESS tag, so this seam
      // exists to satisfy the in-panel name + swatch create-with-color flow. Mint via the
      // id factory (separator-free, mintable), upsert the Tag with an isValidColor-guarded
      // color (defense in depth: coerce already validated it), then addChatTag it. The two
      // store writes coalesce into one pending write; a single flush + refresh follows.
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      const trimmed = label.trim();
      if (trimmed.length === 0) {
        return;
      }
      const tagId = mintTagId();
      const safeColor = isValidColor(color) ? color : undefined;
      store.upsertTag(projectKey, { id: tagId, label: trimmed, color: safeColor });
      store.addChatTag(projectKey, sessionId, tagId);
      await store.flush();
      refreshAllOrgSurfaces();
    },
    exportChat: async (sessionId: string, format: ExportFormat): Promise<void> => {
      // Resolve the chat's transcript record (with its real filePath) from the org
      // panel's scan cache, then route to the EXISTING exportChat pipeline (save dialog +
      // exportIO chokepoint + projects-path guard). The format the user picked in the
      // in-panel menu is threaded through the deps' pickFormat so the menu, not a second
      // QuickPick, chooses it. A missing/unresolvable id is a no-op.
      const record = orgPanelProvider.resolveRecord(sessionId);
      if (record === undefined) {
        return;
      }
      await exportChat({ ...exportChatDeps, pickFormat: async () => format }, record);
    },
    archiveChat: async (sessionId: string): Promise<void> => {
      // Resolve the chat's record from the scan cache and route to the EXISTING archiveChat
      // command (synced userArchived flag + read-only Nest-owned body copy). The command
      // takes a CurationTarget {sessionId, filePath, title}; build it from the resolved
      // record so the body copy is saved (a bare sessionId would archive with no copy).
      const record = orgPanelProvider.resolveRecord(sessionId);
      if (record === undefined) {
        return;
      }
      await archiveChat(curationDeps, {
        sessionId: record.sessionId,
        filePath: record.filePath,
        title: record.title,
      });
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
  // The per-device read-state store (lastSeenAt per chat) on workspaceState, which is
  // structurally NEVER synced, so the unread signal cannot widen the sync surface
  // (UI-SPEC.md "Read state"). Backed by the same workspaceState Memento; readState.ts
  // owns the single-key JSON shape.
  const readStateStore = new ReadStateStore({
    get: (key: string) => context.workspaceState.get<string>(key),
    update: (key: string, value: string) => void context.workspaceState.update(key, value),
  });
  // The effective DEFAULT auto-archive window in days when the user has not chosen one
  // (issue #86 AC #2): the effective Claude cleanupPeriodDays read from settings.json,
  // or CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS (30) when Claude itself has not set it. Read
  // fresh each call so a settings.json change is reflected without a reload. Read-only
  // (readCleanupPeriodDays does a plain readFileSync + tolerant parse).
  const effectiveAutoArchiveDefaultDays = (): number => {
    const read = readCleanupPeriodDays();
    return read.usingDefault || read.value === null
      ? CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS
      : read.value;
  };
  const orgPanelProvider = new OrgPanelProvider(
    context.extensionUri,
    workspacePath,
    store,
    () => foldersProvider.resolveProjectKey(),
    orgPanelActions,
    orgPanelDropDeps,
    orgPanelStateStore,
    readStateStore,
    context.globalStorageUri,
    effectiveAutoArchiveDefaultDays,
  );
  refreshOrgPanel = () => orgPanelProvider.refresh();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ORG_PANEL_VIEW, orgPanelProvider),
  );
  // Reveal the org panel and open the in-panel Archive overlay (issue #87). The auto-archive
  // toast's "Open Archive" action calls this now that the Archive tree is retired: focus the
  // view (async), then the provider posts the archived rows + open message (deferring to
  // 'ready' when the view has not resolved yet). A focus failure is swallowed so a missing
  // view never throws out of a toast callback.
  const openArchiveOverlay = async (): Promise<void> => {
    try {
      await vscode.commands.executeCommand(ORG_PANEL_VIEW + '.focus');
    } catch {
      // The view may not be resolvable yet; the provider still defers the open.
    }
    orgPanelProvider.openArchiveOverlay();
  };

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
      (item?: TagTreeNode | ChatMemberItem | string) => {
        // With the trees retired no view mints these rows any more; the node
        // branches still resolve for a legacy caller, and a bare sessionId covers
        // a programmatic one.
        if (typeof item === 'string') {
          return addTagToChat(tagDeps, item);
        }
        if (item instanceof ChatOccurrenceItem) {
          return addTagToChat(tagDeps, item);
        }
        if (item instanceof ChatMemberItem) {
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
        item?: TagTreeNode | FolderTreeNode | string,
        selection?: (TagTreeNode | FolderTreeNode)[],
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
      (item?: FolderTreeNode | string) => {
        // A palette invocation arrives with NO argument (the trees that supplied a
        // source row are retired): the palette path first quick-picks the source
        // chat. A bare sessionId or a legacy ChatMemberItem still resolves for a
        // programmatic caller. A folder or linked-child row is not a valid source.
        if (item === undefined) {
          return linkToChatFromPalette(linkDeps);
        }
        if (typeof item === 'string') {
          return linkToChat(linkDeps, item);
        }
        if (item instanceof ChatMemberItem) {
          return linkToChat(linkDeps, item.record.sessionId);
        }
        return undefined;
      },
    ),
    vscode.commands.registerCommand(UNLINK_CHAT_COMMAND, (item?: FolderTreeNode) => {
      // A palette invocation arrives with NO argument: the palette path picks the
      // linked child to unlink from the project's current parent links. A legacy
      // LinkedChildItem still resolves for a programmatic caller.
      if (item === undefined) {
        return unlinkChatFromPalette(linkDeps);
      }
      return item instanceof LinkedChildItem ? unlinkChat(linkDeps, item.child) : undefined;
    }),
  );

  // The promote commands turn a described smart-group bucket into a real
  // folder/tag. The Smart Groups TREE is retired (slice s3a-view-consolidation),
  // so no view mints a bucket row any more: the commands stay registered (and
  // palette-hidden) for a PROGRAMMATIC caller passing a plain PromotableGroup
  // ({name, memberChatIds}), validated structurally below. A promote creates
  // folders/tags and files/tags member chats, then refreshes the kept surfaces
  // once. The promote is idempotent both on chat membership and on group identity
  // (reuse-by-name); see promoteSmartGroup.ts.
  const promoteDeps: PromoteDeps = {
    store,
    provider: {
      refresh: () => {
        foldersProvider.refresh();
        tagsProvider.refresh();
        refreshOrgPanel();
        scheduleAutoExport();
      },
    },
    getProjectKey: () => foldersProvider.resolveProjectKey(),
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(PROMOTE_GROUP_TO_FOLDER_COMMAND, (item?: unknown) => {
      const group = promotableFrom(item);
      return group ? promoteGroupToFolder(promoteDeps, group) : undefined;
    }),
    vscode.commands.registerCommand(PROMOTE_GROUP_TO_TAG_COMMAND, (item?: unknown) => {
      const group = promotableFrom(item);
      return group ? promoteGroupToTag(promoteDeps, group) : undefined;
    }),
  );

  // The Archive tree view (claudeNest.archive) is RETIRED this slice
  // (s3b-archive-overlay, issue #87). The archived chats now live behind the in-panel
  // Archive overlay inside the org panel webview, reached from the bottom "Archived (N)"
  // row, so the org panel is Nest's ONLY contributed view. The archived membership,
  // Nest-owned body copy, preview, and the star/restore curation commands all survive; only
  // the tree surface is gone. See DECISIONS.md Slice s3b-archive-overlay.

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

  // Missing-transcript archived chats get their stored body-copy title from the
  // orgPanelActions.loadArchivedTitles seam (the Archive overlay's on-demand title load,
  // issue #87), which reads the same Nest-owned copies. The old provider-side fallback-title
  // loader was retired with the Archive tree.

  // The curation commands (STAR/UNSTAR/ARCHIVE/RESTORE). A curation change alters
  // the Archive view membership and the star badge across every chat surface, so the
  // refresh re-renders all chat views plus the archive view and schedules the opt-in
  // auto-export snapshot (a synced scalar changed). The archive body IO is wired to
  // archiveBodyStore (-> exportIO, guarded); the body read to bodyReader.
  const curationDeps: CurationCommandDeps = {
    store,
    provider: {
      refresh: () => {
        foldersProvider.refresh();
        tagsProvider.refresh();
        refreshOrgPanel();
        scheduleAutoExport();
        // The org panel re-renders the tree AND, when the Archive overlay is open, the
        // client re-requests the archived rows on the next openArchive; the retired tree's
        // fallback-title loader is gone (the overlay loads copy titles on demand).
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
    // claudeNest.refreshArchive is retired with the Archive tree (issue #87): the org
    // panel's Refresh (claudeNest.refresh) re-primes the shared scan snapshot, and the
    // Archive overlay re-requests its rows each time it opens, so a dedicated archive
    // refresh command has no surface.
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
  // The archive fallback titles are now loaded on demand by the Archive overlay
  // (orgPanelActions.loadArchivedTitles) each time it opens, so no activation-time prime is
  // needed (the retired Archive tree needed one because its rows rendered eagerly).

  // ---- Auto-archive engine (slice s3b-settings-overlay, issue #86 AC #4/#5) ----
  //
  // A batched pass over the workspace's scanned chats: an unstarred chat whose last
  // activity is older than the auto-archive window is userArchived (synced flag +
  // stamped archivedAt) AND gets a Nest-owned body copy; a starred chat past the window
  // is NEVER archived but receives a protective body copy once. All flag flips coalesce
  // into ONE store flush; then the org surfaces refresh once. Reuses the SAME store +
  // archiveBodyStore seams the interactive archive command uses (no new fs write path),
  // and reads the window from the org panel's persisted setting (workspaceState). Runs
  // on activation, after a scan refresh, and when the user shortens the window in the
  // Settings overlay. Best-effort: a failure never blocks activation.
  //
  // FIRST-RUN NOTIFICATION (AC #4): the first pass that actually archives a chat shows
  // a one-time toast explaining the move and pointing at Restore (the Archive view).
  const AUTO_ARCHIVE_FIRST_RUN_KEY = 'claudeNest.autoArchive.firstRunNotified';
  runAutoArchiveNow = async (): Promise<void> => {
    try {
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      // Two windows (issue #86 AC #4 vs AC #5): the user's auto-archive window governs
      // UNSTARRED archiving (0 = Never = disabled); the effective Claude cleanup age
      // governs the STARRED protective copy, INDEPENDENT of the auto-archive window so
      // "Never" does not strip a starred chat of its durable copy. When BOTH are
      // disabled there is nothing to do.
      const archiveWindowDays = orgPanelProvider.autoArchiveWindowDays();
      const protectiveWindowDays = effectiveAutoArchiveDefaultDays();
      if (archiveWindowDays <= 0 && protectiveWindowDays <= 0) {
        return;
      }
      const records = orgPanelProvider.scanRecords();
      if (records.length === 0) {
        return;
      }
      const meta = store.getProjectMeta(projectKey);
      const chats: AutoArchiveChat[] = records.map((r) => {
        const chatMeta = meta.chats[r.sessionId];
        return {
          sessionId: r.sessionId,
          filePath: r.filePath,
          title: r.title,
          lastActivity: r.timestamp,
          starred: chatMeta?.starred === true,
          archived: chatMeta?.userArchived === true,
        };
      });
      const result = await runAutoArchivePass(
        {
          setArchived: (sessionId) => store.setChatArchived(projectKey, sessionId, true),
          flush: () => store.flush(),
          readBody: (filePath) => readTranscriptBodies(filePath),
          writeBody: (envelope) => writeArchivedBody(context.globalStorageUri, envelope),
          hasBody: (sessionId) => hasArchivedBody(context.globalStorageUri, sessionId),
          getArchivedAt: (sessionId) =>
            store.getProjectMeta(projectKey).chats[sessionId]?.archivedAt ?? null,
          now: () => Date.now(),
        },
        chats,
        archiveWindowDays,
        protectiveWindowDays,
      );
      if (result.changed) {
        // A curation-class change happened (archived chats moved / copies written):
        // refresh every org surface. The Archive overlay reloads its rows (and their copy
        // titles) on demand the next time it opens, so no separate fallback-title load runs
        // here (the retired tree needed one; the overlay does not).
        refreshAllOrgSurfaces();
      }
      if (result.archived > 0 && context.globalState.get<boolean>(AUTO_ARCHIVE_FIRST_RUN_KEY) !== true) {
        void context.globalState.update(AUTO_ARCHIVE_FIRST_RUN_KEY, true);
        void vscode.window
          .showInformationMessage(
            'Nest moved ' +
              result.archived +
              ' older chat' +
              (result.archived === 1 ? '' : 's') +
              ' to Archive to keep the list tidy. A Nest-owned copy is kept so each ' +
              'survives Claude cleanup. Restore any from the Archive overlay.',
            'Open Archive',
          )
          .then((choice) => {
            if (choice === 'Open Archive') {
              // Reveal the org panel and open the in-panel Archive overlay (issue #87): the
              // Archive tree is retired, so "Open Archive" now opens the overlay rather than
              // focusing a view. A failure is swallowed so a missing view never throws.
              void openArchiveOverlay();
            }
          });
      }
    } catch {
      // Best-effort: an auto-archive failure must never break activation or a refresh.
    }
  };
  // Run one pass on activation (fire-and-forget).
  void runAutoArchiveNow();

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CHAT_COMMAND, (sessionId: string) => {
      // Open-via-Nest is a read-state CLEAR TRIGGER (UI-SPEC.md "Read state"): opening
      // a chat through Nest marks it seen so its '?' badge / unread dot clears. Stamp
      // before the launch and re-post the section model. Guard the id so a malformed
      // programmatic call never throws here.
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        orgPanelProvider.markChatSeen(sessionId);
      }
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

  // The palette-visible Refresh: prime the kept FoldersProvider snapshot under the
  // progress UI (it backs the link pick list, the rollup seam, and project-key
  // resolution), then re-post the org panel's section model so the PRIMARY surface
  // re-scans and re-renders too (the panel scans on its own refresh).
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNest.refresh', async () => {
      await runRefreshScan(foldersProvider, 'chats');
      refreshOrgPanel();
      // Run an auto-archive pass after the scan refresh (issue #86 AC #4: "runs on
      // activation and after scan refresh"): a chat that just aged past the window is
      // swept now rather than only on the next activation.
      void runAutoArchiveNow();
    }),
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
      (item?: ChatMemberItem | ChatOccurrenceItem) => {
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
      // Since the Archive tree is retired (issue #87), this command's only callers are the
      // palette (no arg) and the Archive overlay's row preview (a sessionId string). It no
      // longer receives an ArchivedChatItem tree node.
      (item?: string) => {
        const sessionId = typeof item === 'string' ? item : undefined;
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
      (item?: ChatMemberItem | ChatOccurrenceItem) => {
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

  // The Settings gear (slice s3b-settings-overlay, issue #86): the Settings sub-page
  // is now an IN-PANEL overlay inside the org panel webview (the retired
  // settingsWebview.ts WebviewPanel is deleted). The command reveals the org panel and
  // asks it to open the overlay. Focusing the view resolves it if it was never opened;
  // once 'ready' arrives the panel posts the settings state and opens the overlay.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, async () => {
      try {
        await vscode.commands.executeCommand('claudeNest.orgPanel.focus');
      } catch {
        // The view may not be resolvable yet; the open message below still queues.
      }
      orgPanelProvider.openSettingsOverlay();
    }),
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
      refreshOrgPanel();
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

  // Named-tab-focus read-state CLEAR TRIGGER (UI-SPEC.md "Read state", deviation 4/6).
  // When a Claude Code chat tab gains focus, resolve which chat it is by matching the
  // tab label to a scanned chat title (the identity-by-label heuristic; the real
  // session id is never exposed) and mark that chat seen. The Tabs API
  // (window.tabGroups) is a 1.67+ finalized API not present in the pinned 1.66 types,
  // so it is feature-detected through a narrow shim: on the 1.66 engines floor it is
  // simply absent and the trigger no-ops (open-via-Nest still clears). Best-effort per
  // the deviations; a throw is swallowed so it never affects Claude or activation.
  registerTabFocusReadState(context, orgPanelProvider);

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

// The narrow, feature-detected shim over the finalized Tabs API (window.tabGroups),
// which is NOT in the pinned @types/vscode 1.66 but is present at runtime on 1.67+.
// Only the fields the focus trigger reads are declared. Everything is optional so a
// 1.66 host (no tabGroups) or a shape change fails the guards and no-ops.
interface TabInputShim {
  readonly viewType?: string;
}
interface TabShim {
  readonly label?: string;
  readonly input?: unknown;
}
interface TabGroupShim {
  readonly activeTab?: TabShim;
}
interface TabGroupsShim {
  readonly activeTabGroup?: TabGroupShim;
  onDidChangeTabGroups?(listener: () => void): { dispose(): void };
  onDidChangeTabs?(listener: () => void): { dispose(): void };
}

// Wire the named-tab-focus read-state clear trigger. Feature-detects window.tabGroups
// and, on each tab change, if the active tab is a Claude chat webview, resolves its
// label to a unique scanned chat and marks it seen. Best-effort and fully guarded: a
// missing API, a non-Claude tab, an ambiguous/unnamed label, or any throw is a silent
// no-op, so this can never affect Claude Code or the extension's activation.
function registerTabFocusReadState(
  context: vscode.ExtensionContext,
  orgPanelProvider: OrgPanelProvider,
): void {
  const tabGroups = (vscode.window as unknown as { tabGroups?: TabGroupsShim }).tabGroups;
  if (tabGroups === undefined) {
    return; // 1.66 engines floor: the Tabs API is unavailable; open-via-Nest still clears.
  }
  // The last active-tab signature ("<viewType>::<label>") we processed, so a tab-
  // change storm that does not change the active tab does NO disk scan and NO re-post.
  let lastTabSignature: string | null = null;
  const onFocusChange = (): void => {
    try {
      const activeTab = tabGroups.activeTabGroup?.activeTab;
      const input = activeTab?.input as TabInputShim | undefined;
      const viewType = typeof input?.viewType === 'string' ? input.viewType : '';
      const label = typeof activeTab?.label === 'string' ? activeTab.label : '';
      const signature = activeTab === undefined ? '' : viewType + '::' + label;
      if (signature === lastTabSignature) {
        return; // Same active tab as last time: nothing to recompute.
      }
      lastTabSignature = signature;
      // Only a focused Claude chat tab identifies an active chat. Anything else means
      // no chat is the currently-open editor, so clear the active-row tint.
      if (activeTab === undefined || !isClaudeChatViewType(viewType)) {
        orgPanelProvider.setActiveChat(null);
        return;
      }
      const sessionId = matchTabLabelToChat(label, orgPanelProvider.scanRecords());
      // Set the active-row tint to the matched chat (null when the label is unnamed or
      // ambiguous: then no row is tinted, UI-SPEC.md deviation 4). Mark seen only when
      // the active chat actually changed (the read-state CLEAR TRIGGER), so re-focusing
      // an already-active chat does not re-post.
      const changed = orgPanelProvider.setActiveChat(sessionId);
      if (changed && sessionId !== null) {
        orgPanelProvider.markChatSeen(sessionId);
      }
    } catch {
      // Best-effort convenience layer; never surface a failure.
    }
  };
  if (typeof tabGroups.onDidChangeTabs === 'function') {
    context.subscriptions.push(tabGroups.onDidChangeTabs(onFocusChange));
  }
  if (typeof tabGroups.onDidChangeTabGroups === 'function') {
    context.subscriptions.push(tabGroups.onDidChangeTabGroups(onFocusChange));
  }
  // Seed the active state from the currently-focused tab on activation (a Claude chat
  // may already be open). Best-effort; the guarded handler swallows any throw.
  onFocusChange();
}

// Recover the shared ChatRecord from a chat-row node (a Folders member or a Tags
// occurrence, both kept as non-view service node shapes for programmatic callers).
// Both wrappers dereference the ONE shared ChatRecord (ARCHITECTURE.md tree
// binding rule). A non-chat node yields undefined, so the Preview Full Chat
// command is a no-op on a folder/tag row.
function chatRecordFrom(
  item?: ChatMemberItem | ChatOccurrenceItem,
): ChatRecord | undefined {
  if (item instanceof ChatMemberItem || item instanceof ChatOccurrenceItem) {
    return item.record;
  }
  return undefined;
}

// The chat-row node shapes a curation command (star/unstar/archive/restore) can
// fire on: a folder member, a tags occurrence, or a bare sessionId from a
// programmatic caller (the Archive tree's ArchivedChatItem was retired with the tree,
// issue #87; the Archive overlay's Restore/star-unarchive route through the org-panel
// OrgPanelActions.restoreArchivedChat seam, which builds the target directly).
type CurationClickable =
  | ChatMemberItem
  | ChatOccurrenceItem
  | string;

// Recover the CurationTarget (sessionId + filePath + title) from a clicked chat
// row in any view. All chat-row wrappers dereference the ONE shared ChatRecord,
// which carries filePath and title. A bare sessionId (a programmatic caller) yields a
// target with an EMPTY filePath (star/unstar/restore on an already-archived chat need
// only the sessionId). A non-chat node yields undefined, so a curation command is a
// no-op on a folder/tag/group row.
function curationTargetFrom(item?: CurationClickable): CurationTarget | undefined {
  if (typeof item === 'string') {
    return { sessionId: item, filePath: '', title: item };
  }
  if (item instanceof ChatMemberItem || item instanceof ChatOccurrenceItem) {
    return { sessionId: item.record.sessionId, filePath: item.record.filePath, title: item.record.title };
  }
  return undefined;
}

// Recover a PromotableGroup from a promote-command argument. The Smart Groups
// tree that minted bucket rows is retired (slice s3a-view-consolidation), so the
// only remaining caller is programmatic: a plain {name, memberChatIds} object,
// validated structurally (memberChatIds must be an array of strings; anything
// else yields undefined and the command no-ops). The name becomes the folder
// name / tag label and memberChatIds the chats to file/tag.
function promotableFrom(item?: unknown): PromotableGroup | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const candidate = item as { name?: unknown; memberChatIds?: unknown };
  if (typeof candidate.name !== 'string' || !Array.isArray(candidate.memberChatIds)) {
    return undefined;
  }
  const memberChatIds = candidate.memberChatIds.filter(
    (v): v is string => typeof v === 'string',
  );
  return { name: candidate.name, memberChatIds };
}

// Recover the clicked chats' sessionIds from a tag-command invocation. VSCode
// passes the clicked node first and the full multi-selection second for a tree
// context-menu command. The selection (when present) wins so a multi-select tags
// every chosen chat; otherwise the single clicked node is used, then a bare
// sessionId string for a programmatic caller. A chat node resolves to its
// record.sessionId (a Folders member) or its occurrence chat (Tags); a folder/tag
// row contributes nothing. The result is de-duplicated in first-seen order.
function collectChatSessionIds(
  item: TagTreeNode | FolderTreeNode | string | undefined,
  selection: (TagTreeNode | FolderTreeNode)[] | undefined,
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
