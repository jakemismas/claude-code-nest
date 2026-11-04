import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
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
import { OPEN_IN_TERMINAL_COMMAND, openRunningChat } from './launch/attachLauncher';
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
import { Link, isSafeRecordId, isValidColor } from './store/schema';
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
import { FleetReloader } from './fleet/fleetReloader';
import { fleetFilePaths } from './fleet/fleetSource';
import { watchFile, watchFileResubscribing, watchFleetFilesResubscribing } from './fleet/fleetWatcher';
import { ConfigReloader, nestConfigPath } from './fleet/configSource';
import { AgentsResult, execFileRunner, listAgentSessions } from './claude/agentsCli';
import { AgentsPoller } from './fleet/agentsPoller';
import { QueueReloader, currentQueuePath } from './fleet/queueSource';
import { expandLinkedFolders, resolveFleetFileEntries } from './fleet/nestConfig';
import { GROUP_BY_OVERRIDE_KEY, effectiveGroupBy } from './fleet/groupByOverride';
import { EMPTY_FLEET_STATE, FleetState } from './fleet/types';
import { OPEN_LAYOUT_FILE_COMMAND, openLayoutFile } from './commands/openLayoutFile';
import { createOpenLayoutDeps } from './commands/openLayoutFileHost';
import {
  ORGANIZE_APPLY_COMMAND,
  ORGANIZE_PREVIEW_COMMAND,
  ORGANIZE_UNDO_COMMAND,
  OrganizeDeps,
  applyOrganize,
  idleOrganizeReport,
  previewOrganize,
  undoOrganize,
} from './commands/organizeCommands';
import { resolveFolderName, resolveStarred, resolveTagLabels } from './views/chatMeta';

// Entry point for the Claude Code Nest extension: contributes the claudeNest Activity Bar view container, wires the open-chat command to Claude's URI handler, and stands up the MetadataStore over context.globalState.
// The org panel webview is the only browsing surface.
// The active store, held so deactivate can await a final flush; VS Code awaits a Thenable returned from deactivate.
let activeStore: MetadataStore | undefined;

// The active auto-exporter, held so deactivate() can cancel a pending debounced snapshot.
let activeAutoExporter: AutoExporter | undefined;

// Test-only seam: lets an integration test mark a made-up session id as attachable.
let attachableOverride: ((sessionId: string) => boolean) | null = null;
export function setAttachableOverrideForTests(fn: ((sessionId: string) => boolean) | null): void {
  attachableOverride = fn;
}

// Test-only seam: the live org panel provider, so an integration test can attach a fake view.
let orgPanelProviderForTests: OrgPanelProvider | undefined;
export function getOrgPanelProviderForTests(): OrgPanelProvider | undefined {
  return orgPanelProviderForTests;
}

export function activate(context: vscode.ExtensionContext): void {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Adapt the real global Memento to the store's structural seams; the vscode binding lives only here so the store and deviceId modules stay vscode-free.
  const syncMemento: SyncMemento = context.globalState;
  const deviceIdStore: DeviceIdStore = {
    get: (key: string) => context.globalState.get<string>(key),
    set: (key: string, value: string) => {
      // The device id is install-local, so it is not registered for sync. The void is deliberate: persistence is fire-and-forget.
      void context.globalState.update(key, value);
    },
  };
  // No seed: a per-install random UUID is generated on first run. machineId is per-machine, so seeding with it would give two installs on one machine (a second profile, or Insiders and Stable) the same device id and defeat foreign-device overwrite detection.
  const deviceId = getOrCreateDeviceId(deviceIdStore);
  activeStore = new MetadataStore(syncMemento, { deviceId });
  const store = activeStore;
  context.subscriptions.push({ dispose: () => void store.dispose() });

  // Forward handle to the debounced opt-in auto-export. The AutoExporter is built lower, but the organization-mutation refresh closures are built above it and call through this, so the user's own edits schedule snapshots. A call before assignment is a harmless no-op.
  let scheduleAutoExport: () => void = () => {};

  // Forward handle to the org panel's refresh, assigned once the OrgPanelProvider exists. Every organization-mutation refresh closure calls through it so the panel re-renders on a mutation. A call before assignment is a harmless no-op.
  let refreshOrgPanel: () => void = () => {};

  // Forward handle to the auto-archive pass, assigned once the OrgPanelProvider and archive-body seams exist. Called on activation, after a scan refresh and when the user changes the window in Settings. A call before assignment is a harmless no-op.
  let runAutoArchiveNow: () => Promise<void> = () => Promise.resolve();

  // Reconcile-before-write barrier for automated store writers. A foreign Settings Sync write can land in globalState with no event; if an automated writer stages a mutation before reconcileAllProjects classifies it, the write re-stamps the project as this device's and the reconcile adopts the lossy document, dropping local-only curation.
  // Automated writers therefore await this barrier (wired to reconcileAllProjects once the export/import deps exist). Before assignment it resolves immediately, so the activation-time auto-archive is sequenced after assignment.
  let reconcileBeforeAutomatedWrite: () => Promise<void> = () => Promise.resolve();

  // The progress and cancellation UI for the explicit Refresh commands: withProgress shows a cancellable notification while a provider scans, and the scanner stays vscode-free.
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

  // The encoded project key (the on-disk projects directory name) is resolved on demand: it is undefined until Claude Code creates a project dir for this workspace, which can happen after activation. FoldersProvider.resolveProjectKey re-resolves it on every refresh and the commands share it via FolderCommandDeps.getProjectKey.
  // FoldersProvider is a non-view service now (the org panel webview is the browsing surface). Commands use it for project-key resolution, the link pick list (chatRecords), the rollup seam (tokenTotalsByChat) and reveal resolution (memberNodeForChat); its refresh is folded into every refresh closure with the org panel's.
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
        // A ChatMemberItem or a bare sessionId string resolves; no view mints chat rows for this command.
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

  // The many-to-many tag membership service. Like FoldersProvider it is a non-view service: tag commands resolve the project key through it (TagCommandDeps.getProjectKey) and its refresh joins the shared refresh closures. The org panel handles tag drag-and-drop via webviewDropAdapter, which reuses reduceDrop.
  const tagsProvider = new TagsProvider(workspacePath, store);

  // The org panel webview: the section model (Starred, Questions, the folder hierarchy with colors, Unsorted), tag filter chips, sort and density modes, folder rename and drag-and-drop. Drops reuse reduceDrop through webviewDropAdapter.
  // The shared refresh closure re-renders the folders and tags services and this panel and schedules the opt-in auto-export. It is built after both providers so their refresh and project-key resolution exist.
  const refreshAllOrgSurfaces = (): void => {
    foldersProvider.refresh();
    tagsProvider.refresh();
    refreshOrgPanel();
    scheduleAutoExport();
  };
  // Rename and color actions use the store mutations (setFolderColor, and upsertFolder preserving parent and order) then flush and refresh once, so the webview adds no write path.
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
      // Enforce the renameFolder invariants (folderCommands.ts): no slash, and no sibling-name collision under the same parent. A violating rename is ignored and the webview keeps the old name.
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
      // Reuse the deleteFolder command (modal confirm, descendant cascade, unfile; chats are never deleted). It takes a FolderItem, so build one from the live record.
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
      // Reuse the createFolder command (slash-path expansion, one-sublevel depth cap). A name from the in-panel popover goes in as presetName to skip the native input box.
      await createFolder(folderDeps, undefined, name);
    },
    newSession: async (): Promise<void> => {
      // Best-effort new Claude Code chat via the probed command chain (newSessionLauncher), with a toast on total failure: those entry points are undocumented and may be absent.
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
      // Load stored body-copy titles, by sessionId, for archived chats whose transcript was cleaned up, from the Nest-owned copies. Best-effort per id so one unreadable copy does not fail the overlay; present chats' titles come from the scan.
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
      // Restore from the overlay: route to the restoreChat command with a target built from the scan record (real filePath, so the redundant copy can be deleted) or an empty filePath when the transcript is gone (copy-only row), so restoreChat keeps the copy. An unresolvable id still clears the flag.
      const record = orgPanelProvider.resolveRecord(sessionId);
      await restoreChat(curationDeps, {
        sessionId,
        filePath: record?.filePath ?? '',
        title: record?.title ?? sessionId,
      });
    },
    runAutoArchive: async (): Promise<void> => {
      // The auto-archive window changed in Settings: run a fresh pass so a shortened window applies without a reload. No-op when auto-archiving is off or nothing is past the window.
      await runAutoArchiveNow();
    },
    setStarred: async (sessionId: string, starred: boolean): Promise<void> => {
      // Route the star toggle to the star and unstar curation commands, which accept a bare sessionId; starring needs no filePath.
      await vscode.commands.executeCommand(
        starred ? STAR_CHAT_COMMAND : UNSTAR_CHAT_COMMAND,
        sessionId,
      );
    },
    toggleChatTag: async (sessionId: string, tagId: string, on: boolean): Promise<void> => {
      // Route the tag toggle to the store's add and remove (coalesced into one write), then flush and refresh. A redundant toggle is harmless: addChatTag no-ops when present, removeChatTag when absent.
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
      // Mint a new colored tag and apply it to the chat. The createTag command prompts and mints a colorless tag, so this seam serves the in-panel name-and-swatch flow. The color is isValidColor-guarded; the two store writes coalesce into one flush and refresh.
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
      // Resolve the chat's record (real filePath) from the panel's scan cache and route to the exportChat pipeline. The format picked in the in-panel menu is passed through pickFormat, so no second QuickPick appears. An unresolvable id is a no-op.
      const record = orgPanelProvider.resolveRecord(sessionId);
      if (record === undefined) {
        return;
      }
      await exportChat({ ...exportChatDeps, pickFormat: async () => format }, record);
    },
    archiveChat: async (sessionId: string): Promise<void> => {
      // Resolve the chat's record from the scan cache and route to the archiveChat command with a full CurationTarget; a bare sessionId would archive without saving the body copy.
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
  // Drop deps: the adapter applies the reducer's intents as one coalesced write, then this refresh re-renders every org surface.
  const orgPanelDropDeps = {
    store,
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    refresh: () => refreshAllOrgSurfaces(),
  };
  // Persist the sort and density choice on workspaceState (per workspace, not synced) so the panel reopens in the same mode.
  const orgPanelStateStore: OrgPanelStateStore = {
    get: (key: string) => context.workspaceState.get<string>(key),
    set: (key: string, value: string) => void context.workspaceState.update(key, value),
  };
  // The per-device read-state store (lastSeenAt per chat) on workspaceState, which is never synced; readState.ts owns the single-key JSON shape.
  const readStateStore = new ReadStateStore({
    get: (key: string) => context.workspaceState.get<string>(key),
    update: (key: string, value: string) => void context.workspaceState.update(key, value),
  });
  // The default auto-archive window in days when the user has not chosen one: Claude's cleanupPeriodDays from settings.json, else CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS (30). Read on each call so a settings.json change applies without a reload.
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
  orgPanelProviderForTests = orgPanelProvider;
  // The hatch plays once per device; the flag is not in any synced key set.
  const ROBIN_HATCHED_KEY = 'claudeNest.robin.hatched';
  const readRobinAnimations = (): boolean =>
    vscode.workspace.getConfiguration('claudeNest').get<boolean>('robin.animations', true) !== false;
  orgPanelProvider.setRobinOptions({
    animations: readRobinAnimations,
    hatched: {
      get: () => context.globalState.get<boolean>(ROBIN_HATCHED_KEY) === true,
      set: () => void context.globalState.update(ROBIN_HATCHED_KEY, true),
    },
  });
  context.subscriptions.push(
    { dispose: () => orgPanelProvider.disposeRobin() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeNest.robin.animations')) {
        orgPanelProvider.refreshRobin();
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ORG_PANEL_VIEW, orgPanelProvider),
  );
  // Reveal the org panel and open the in-panel Archive overlay (used by the auto-archive toast's "Open Archive" action). A focus failure is swallowed so a missing view never throws out of a toast callback.
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
        // Node shapes still resolve for programmatic callers, and a bare sessionId covers the rest.
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

  // The multi-select tag command (canPickMany QuickPick). It fires from a chat row or tag occurrence, applies to the whole multi-selection, and refreshes the Folders and Tags services once.
  const taggingUi: TagMultiPickUi = {
    pickTags: (options, placeholder) => showTagMultiPick(options, placeholder),
    showError: (message) => void vscode.window.showErrorMessage(message),
  };
  const taggingDeps: TaggingCommandDeps = {
    store,
    // Refresh both membership services and the org panel after a multi-select tag change.
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
        // A tree context-menu command receives the clicked node first and the full multi-selection second. Prefer the selection, then the clicked node, then a bare sessionId.
        const chatIds = collectChatSessionIds(item, selection);
        if (chatIds.length === 0) {
          return undefined;
        }
        return tagChats(taggingDeps, chatIds);
      },
    ),
  );

  // The Links commands: link-to-chat and unlink. A 'parent' link nests the target under the source chat; unlink removes the parent link from a linked child's designated parent. Both refresh once after the store flush.
  const linkUi: LinkCommandUi = {
    // Only 'parent' links are offered: a 'related' link has no read, navigate or remove surface yet, so it would be an invisible, unremovable link. pickKind stays so 'related' can return without touching the command logic.
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
        // A palette invocation arrives with no argument, so it quick-picks the source chat first; a bare sessionId or ChatMemberItem still resolves for programmatic callers. A folder or linked-child row is not a valid source.
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
      // A palette invocation arrives with no argument and picks the linked child from the current parent links; a LinkedChildItem still resolves for programmatic callers.
      if (item === undefined) {
        return unlinkChatFromPalette(linkDeps);
      }
      return item instanceof LinkedChildItem ? unlinkChat(linkDeps, item.child) : undefined;
    }),
  );

  // The promote commands turn a described smart-group bucket into a real folder or tag. No view mints bucket rows now, so they stay registered for programmatic callers passing a PromotableGroup ({name, memberChatIds}), validated structurally below.
  // A promote is idempotent on membership and on group identity (reuse by name); see promoteSmartGroup.ts.
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

  // Archived chats live behind the in-panel Archive overlay in the org panel, reached from the bottom "Archived (N)" row, so the org panel is Nest's only contributed view. Archived membership, the Nest-owned body copy, preview and the star and restore commands all remain.

  // Read the configured keep-window in this vscode-thin layer and coerce it to a plain keepWindowDays number, so the pure archiveRetention policy never reads getConfiguration. It is evaluated on each prune, which runs once per activation, so a settings change applies on the next reload.
  const keepWindowDays = (): number =>
    coerceKeepWindowDays(
      vscode.workspace.getConfiguration('claudeNest').get<number>('archiveKeepWindowDays'),
    );

  // Archived chats with a missing transcript get their body-copy title from orgPanelActions.loadArchivedTitles, which the Archive overlay calls on demand.

  // The curation commands (star, unstar, archive, restore). A curation change alters archive membership and the star badge on every surface, so the refresh re-renders them all and schedules the opt-in auto-export snapshot. Body IO goes to archiveBodyStore (through guarded exportIO) and bodyReader.
  const curationDeps: CurationCommandDeps = {
    store,
    provider: {
      refresh: () => {
        foldersProvider.refresh();
        tagsProvider.refresh();
        refreshOrgPanel();
        scheduleAutoExport();
        // The org panel re-renders, and when the Archive overlay is open the client re-requests the archived rows on its next open.
      },
    },
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    readBody: (filePath: string) => readTranscriptBodies(filePath),
    writeBody: (envelope) => writeArchivedBody(context.globalStorageUri, envelope),
    deleteBody: (sessionId: string) => deleteArchivedBody(context.globalStorageUri, sessionId),
    // Read-only existence check (existsSync is not a write verb). Restore uses it to gate the body-copy delete: on a copy-only archived row the copy is the sole surviving form and must be kept.
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
    // There is no separate archive refresh command: the org panel's Refresh (claudeNest.refresh) re-primes the shared scan snapshot, and the Archive overlay re-requests its rows on open.
  );

  // Live-store backstop for the prune. A body copy's own {archivedAt, starred} snapshot is only best-effort current, and archivedAt is a synced scalar under per-record LWW, so a foreign device can win an older archivedAt that pushes the snapshot past the keep-window.
  // Before deleting a copy whose snapshot says prune, re-check the live synced state: a chat still userArchived is kept regardless of star, since after Claude's cleanup the copy is its only durable form. It reads synced meta without writing; with no resolved project nothing is protected and the snapshot decides.
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

  // Prune lapsed body copies on activation (best-effort, fire-and-forget): a copy past the keep-window and not starred is removed unless the live synced state protects it. A failure never blocks activation.
  void pruneArchivedBodies(
    context.globalStorageUri,
    keepWindowDays(),
    Date.now(),
    isArchivedCopyLiveProtected,
  );
  // Archive titles load on demand from the Archive overlay (orgPanelActions.loadArchivedTitles), so no activation-time prime is needed.

  // ---- Auto-archive engine: a batched pass over the scanned chats. An unstarred chat idle past the auto-archive window is userArchived (synced flag and archivedAt) and gets a Nest-owned body copy; a starred chat past the window is never archived but gets a protective copy once.
  // Flag flips coalesce into one store flush, then the surfaces refresh once. It reuses the interactive archive command's store and archiveBodyStore seams and reads the window from the org panel's persisted setting. It runs on activation, after a scan refresh and when the window is shortened; failures never block activation.
  // The first pass that archives a chat shows a one-time toast pointing at Restore in the Archive overlay.
  const AUTO_ARCHIVE_FIRST_RUN_KEY = 'claudeNest.autoArchive.firstRunNotified';
  runAutoArchiveNow = async (): Promise<void> => {
    try {
      // Barrier first, on every trigger: reconcile any foreign Settings Sync write before reading meta or staging a mutation, or an archive flip would launder it into a self-write and drop local-only curation.
      await reconcileBeforeAutomatedWrite();
      const projectKey = foldersProvider.resolveProjectKey();
      if (projectKey === undefined) {
        return;
      }
      // Two windows: the auto-archive window governs unstarred archiving (0 = Never = off); the effective Claude cleanup age governs the starred protective copy independently, so Never does not strip a starred chat of its copy. With both off there is nothing to do.
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
          // The restore stamp counts as activity, so a chat the user restored is not re-archived by this pass.
          restoredAt: chatMeta?.restoredAt ?? null,
        };
      });
      const result = await runAutoArchivePass(
        {
          // Automated: an engine-staged flip must not refresh the per-record LWW stamp (see store.setChatArchived), so it cannot beat an unsynced user edit in the cross-machine merge.
          setArchived: (sessionId) =>
            store.setChatArchived(projectKey, sessionId, true, { automated: true }),
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
        // Archived chats moved or copies were written: refresh every org surface. The Archive overlay reloads rows and copy titles on its next open.
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
              // Reveal the org panel and open the Archive overlay; a failure is swallowed so a missing view never throws.
              void openArchiveOverlay();
            }
          });
      }
    } catch {
      // Best-effort: an auto-archive failure must never break activation or a refresh.
    }
  };
  // The activation pass is not kicked here: the reconcile barrier is still the pre-assignment no-op, so it could stage archive flips against an unreconciled foreign value. It starts after the activation reconcile below.

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CHAT_COMMAND, (sessionId: string) => {
      // Opening a chat through Nest clears its unread badge: mark it seen before launch and re-post the section model. This command is callable by any extension, so the id must match the safe record-id shape (as in the webview's own 'open' check) before reaching the workspaceState lastSeenAt map; ReadStateStore.markSeen re-checks at the sink.
      if (isSafeRecordId(sessionId)) {
        orgPanelProvider.markChatSeen(sessionId);
      }
      // Adapt the launcher's OpenUri to a real Uri via vscode.Uri.from and open it with vscode.env.openExternal.
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

  // Open in terminal runs `claude attach <id>` for a running background chat. Every other
  // case, and an untrusted workspace, uses the same URI open as a plain click.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_IN_TERMINAL_COMMAND, (sessionId: string, explicit?: boolean) =>
      openRunningChat(sessionId, {
        createTerminal: (options) =>
          vscode.window.createTerminal({
            name: options.name,
            shellPath: options.shellPath,
            shellArgs: [...options.shellArgs],
            cwd: os.homedir(),
          }),
        onDidCloseTerminal: (listener) => vscode.window.onDidCloseTerminal((t) => listener(t)),
        warn: (message) => void vscode.window.showWarningMessage(message),
        isAttachable: (id) =>
          attachableOverride !== null ? attachableOverride(id) : orgPanelProvider.isAttachable(id),
        inform: (message) => void vscode.window.showInformationMessage(message),
        isTrusted: () => vscode.workspace.isTrusted !== false,
        chatName: (id) => orgPanelProvider.getChatName(id),
        offer: async (message, button) => (await vscode.window.showInformationMessage(message, button)) === button,
        openChat: (id) => vscode.commands.executeCommand(OPEN_CHAT_COMMAND, id),
      }, explicit === true),
    ),
  );

  // The palette Refresh: prime the FoldersProvider snapshot under the progress UI (it backs the link pick list, rollup seam and project-key resolution), then re-post the org panel's section model so the panel re-scans too.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNest.refresh', async () => {
      await runRefreshScan(foldersProvider, 'chats');
      refreshOrgPanel();
      // Run an auto-archive pass after the scan refresh: a chat that just aged past the
      // window is swept now rather than only on the next activation.
      void runAutoArchiveNow();
    }),
  );

  // The "Preview Full Chat" command: opens one chat's full prose in a read-only document by reading one transcript via bodyReader and discarding the bodies. The formatter and orchestrator live in previewChatCommand.ts; the chat row carries the ChatRecord on .record.
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

  // The "Preview Archived Copy" command: renders the Nest-owned copy (globalStorage) by sessionId, so it works after Claude cleans up the transcript. It fires from an archived row or with a sessionId string.
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
      // Callers are the palette (no argument) and the Archive overlay's row preview (a sessionId string); it no longer receives a tree node.
      (item?: string) => {
        const sessionId = typeof item === 'string' ? item : undefined;
        return sessionId !== undefined
          ? previewArchivedBody(previewArchivedChatDeps, sessionId)
          : undefined;
      },
    ),
  );

  // The "Export Chat" command: exports one chat to Markdown or JSON through the guarded exportIO write. The org layer is resolved on demand from the current ProjectMeta and the body is read once and discarded.
  // exportIO.writeTextFile asserts the target is not under ~/.claude/projects, so an export aimed at a transcript dir is refused.
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

  // The "Show Token Cost Rollup" command (tokens only, no USD). The id set comes from FoldersProvider.chatRecords and the totals from tokenTotalsByChat (chatRecords drops tokenTotals); the pure reducer and renderer build the report. A read-only document avoids a webview and CSP dependency.
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

  // The Settings gear reveals the org panel and asks it to open the in-panel Settings overlay. Focusing the view resolves it if never opened; on 'ready' the panel posts the settings state and opens the overlay.
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

  // Export, import and cross-machine sync. Export writes all projects (with stamps) to a user-chosen JSON backup; import validates and migrates a parsed copy, then merges additively per project without deleting absent ones.
  // The additive reconcile runs on activation and window focus (no Memento change event exists), unions tags and links, applies LWW per folderId by updatedAt and shows the LWW warning. A debounced opt-in auto-export snapshot with retention writes to globalStorage.
  // File writes go through exportIO; the pure store modules stay vscode-free.
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
  // Point the forward handle at the AutoExporter so the user's own organization mutations schedule a debounced snapshot. schedule() is a no-op until the user enables auto-export.
  scheduleAutoExport = () => autoExporter.schedule();

  // The export/import deps. refresh re-renders every membership view after a reconcile or import applies merges, and schedules a debounced auto-export snapshot.
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

  // Wire the automated-writer barrier now that the deps exist: every auto-archive trigger awaits a full reconcile before staging any store mutation.
  reconcileBeforeAutomatedWrite = () => reconcileAllProjects(exportImportDeps);

  // Reconcile on activation: a foreign-device sync write may have landed while this window was closed. The extension activates on its first view open, early enough to reconcile before the user touches organization. Best-effort and fire-and-forget; a failure never blocks activation.
  // The activation auto-archive pass is chained after this reconcile (its own barrier is then a cheap no-op), so an automated archive never precedes the foreign-write classification.
  void reconcileAllProjects(exportImportDeps)
    .catch(() => undefined)
    .then(() => runAutoArchiveNow());

  // Reconcile on window focus, the only signal for a Settings Sync remote write (there is no Memento change event), so a foreign write that landed in the background is merged when the user returns. Pushed to subscriptions so it is disposed on shutdown.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void reconcileAllProjects(exportImportDeps);
      }
    }),
  );

  // Named-tab-focus read-state clear: when a Claude Code chat tab gains focus, match the tab label to a scanned chat title (the session id is never exposed) and mark that chat seen.
  // window.tabGroups is a 1.67+ API absent from the pinned 1.66 types, so it is feature-detected through a narrow shim; on 1.66 the trigger no-ops (open-via-Nest still clears). Best-effort: a throw is swallowed so it never affects Claude or activation.
  registerTabFocusReadState(context, orgPanelProvider);

  // The one-time opt-in prompt for the auto-export snapshot and the synced or git-tracked canonical export location. Fire-and-forget.
  void maybePromptAutoExport(exportImportDeps);

  // The layout file (.nest/config.json) and fleet records are read-only input. A layout change recomputes linked folders and fleet paths, re-subscribes the fleet watchers and refreshes the panel.
  const workspaceFolderPaths = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let linkedFolders: readonly string[] = [];
  let extraFleetFiles: readonly string[] = [];
  const configPath = workspacePath === undefined ? undefined : nestConfigPath(workspacePath);
  const computeFleetPaths = (): string[] => [
    ...fleetFilePaths([...workspaceFolderPaths(), ...linkedFolders]),
    ...extraFleetFiles,
  ];
  let lastFleetState: FleetState = EMPTY_FLEET_STATE;
  const applyLayout = (): void => {
    orgPanelProvider.setLayout({
      linkedFolders,
      groupBy: effectiveGroupBy(
        orgPanelStateStore.get(GROUP_BY_OVERRIDE_KEY),
        configReloader.getParsed().config.groupBy,
      ),
      fleet: lastFleetState,
    });
    refreshOrgPanel();
  };
  orgPanelProvider.onGroupByOverrideChange(applyLayout);
  const fleetReloader = new FleetReloader({
    getPaths: computeFleetPaths,
    onChange: (state) => {
      lastFleetState = state;
      applyLayout();
    },
    warn: (message) => console.warn(message),
  });
  const fleetWatcher = watchFleetFilesResubscribing(computeFleetPaths, fleetReloader);
  const configReloader: ConfigReloader = new ConfigReloader({
    getPath: () => configPath,
    onChange: (parsed) => {
      // An untrusted workspace cannot point scans or reads at paths outside itself.
      const trusted = vscode.workspace.isTrusted !== false;
      const linked = trusted ? expandLinkedFolders(parsed.config.linkedFolders) : { paths: [], problems: [] };
      const files = trusted ? resolveFleetFileEntries(parsed.config.fleetFiles) : { paths: [], problems: [] };
      if (!trusted && (parsed.config.linkedFolders.length > 0 || parsed.config.fleetFiles.length > 0)) {
        console.warn('Nest layout file: linkedFolders and fleet.files are ignored in an untrusted workspace.');
      }
      linkedFolders = linked.paths;
      extraFleetFiles = files.paths;
      for (const problem of [...parsed.problems, ...linked.problems, ...files.problems]) {
        console.warn(`Nest layout file: ${problem}`);
      }
      orgPanelProvider.setStageStyle({ tags: parsed.config.tags, doneStages: parsed.config.doneStages });
      fleetWatcher.refresh();
      void fleetReloader.reload();
      queueWatcher.refresh();
      void queueReloader.reload();
    },
    warn: (message) => console.warn(message),
  });
  // The queue Markdown file is watched like the fleet and layout files; the watch
  // follows the layout file's queue path.
  const queueSettings = {
    getQueue: () => configReloader.getParsed().config.queue,
    getWorkspaceFolder: () => workspacePath,
    isTrusted: () => vscode.workspace.isTrusted !== false,
  };
  const queueReloader = new QueueReloader({
    ...queueSettings,
    onRows: (rows) => orgPanelProvider.setQueueRows(rows),
    warn: (message) => console.warn(message),
  });
  const queueWatcher = watchFileResubscribing(
    () => currentQueuePath(queueSettings),
    () => queueReloader.notifyFileEvent(),
  );
  // Live session list from `claude agents --json`. It never runs in an untrusted
  // workspace, and it runs from the home directory.
  const agentsPoller = new AgentsPoller({
    poll: async (): Promise<AgentsResult> => {
      if (workspacePath === undefined || vscode.workspace.isTrusted === false) {
        return { ok: false, reason: 'Live status is off in this workspace.', unavailable: true };
      }
      return listAgentSessions(execFileRunner, workspacePath);
    },
    onSessions: (sessions) => orgPanelProvider.setAgentSessions(sessions),
    log: (message) => console.warn(message),
  });
  orgPanelProvider.onVisibilityChange((visible) => agentsPoller.setVisible(visible));
  agentsPoller.start();
  context.subscriptions.push(
    { dispose: () => agentsPoller.dispose() },
    { dispose: () => fleetReloader.dispose() },
    { dispose: () => configReloader.dispose() },
    { dispose: () => queueReloader.dispose() },
    fleetWatcher,
    queueWatcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      fleetWatcher.refresh();
      void fleetReloader.reload();
    }),
    ...(configPath === undefined ? [] : [watchFile(configPath, () => configReloader.notifyFileEvent())]),
    vscode.commands.registerCommand(OPEN_LAYOUT_FILE_COMMAND, () =>
      openLayoutFile(createOpenLayoutDeps(workspacePath, context.extensionUri)),
    ),
  );
  // Organize rules: Preview reads, Apply and Undo write through the store after the
  // reconcile barrier. The undo snapshot is kept in the store's never-synced local area.
  const organizeDeps: OrganizeDeps = {
    store,
    getProjectKey: () => foldersProvider.resolveProjectKey(),
    getSubjects: () => orgPanelProvider.getOrganizeSubjects(),
    // Rules hold patterns from the workspace layout file, so they stay off until the workspace is trusted.
    getRules: () => (vscode.workspace.isTrusted === false ? [] : configReloader.getParsed().config.rules),
    getTagColors: () => configReloader.getParsed().config.tags,
    homedir: os.homedir(),
    barrier: () => reconcileBeforeAutomatedWrite(),
    refresh: () => {
      tagsProvider.refresh();
      foldersProvider.refresh();
      refreshOrgPanel();
      scheduleAutoExport();
    },
  };
  orgPanelProvider.setOrganizeActions({
    idle: () => idleOrganizeReport(organizeDeps),
    preview: () => previewOrganize(organizeDeps),
    apply: () => applyOrganize(organizeDeps),
    undo: () => undoOrganize(organizeDeps),
  });
  const confirmOrganize = async (message: string, label: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) === label;
  context.subscriptions.push(
    vscode.commands.registerCommand(ORGANIZE_PREVIEW_COMMAND, async () => {
      await vscode.commands.executeCommand('claudeNest.openSettings');
      await orgPanelProvider.runOrganize('preview');
    }),
    vscode.commands.registerCommand(ORGANIZE_APPLY_COMMAND, async () => {
      const preview = previewOrganize(organizeDeps);
      if (preview.moves.length === 0) {
        void vscode.window.showInformationMessage(preview.message);
        return;
      }
      const count = preview.moves.length;
      if (!(await confirmOrganize(`Apply organize rules to ${count} ${count === 1 ? 'chat' : 'chats'}? Undo restores them.`, 'Apply'))) {
        return;
      }
      const report = await orgPanelProvider.runOrganize('apply');
      if (report !== undefined) {
        void vscode.window.showInformationMessage(report.message);
      }
    }),
    vscode.commands.registerCommand(ORGANIZE_UNDO_COMMAND, async () => {
      const idle = idleOrganizeReport(organizeDeps);
      if (!idle.canUndo) {
        void vscode.window.showInformationMessage('There is nothing to undo.');
        return;
      }
      if (!(await confirmOrganize(`Undo the last organize Apply for ${idle.undoCount} ${idle.undoCount === 1 ? 'chat' : 'chats'}?`, 'Undo'))) {
        return;
      }
      const report = await orgPanelProvider.runOrganize('undo');
      if (report !== undefined) {
        void vscode.window.showInformationMessage(report.message);
      }
    }),
  );
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void configReloader.reload();
        agentsPoller.retryNow();
      }),
    );
  }
  void configReloader.reload();
}

export function deactivate(): Thenable<void> | void {
  // Persist any write staged within the debounce window before the host tears the extension down. VS Code awaits a returned Thenable here, but not the subscription dispose, so this is the reliable flush point.
  const store = activeStore;
  activeStore = undefined;
  // Cancel any pending debounced auto-export snapshot so it cannot fire during teardown; the store flush below persists the live data.
  if (activeAutoExporter) {
    activeAutoExporter.dispose();
    activeAutoExporter = undefined;
  }
  if (store) {
    return store.flush();
  }
}

// A narrow shim over the Tabs API (window.tabGroups), which is absent from the pinned @types/vscode 1.66 but present at runtime on 1.67+.
// Only the fields the focus trigger reads are declared, all optional, so a 1.66 host or a shape change fails the guards and no-ops.
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

// Wire the named-tab-focus read-state clear trigger: on each tab change, if the active tab is a Claude chat webview, resolve its label to a unique scanned chat and mark it seen.
// Fully guarded: a missing API, a non-Claude tab, an ambiguous or unnamed label, or any throw is a silent no-op.
function registerTabFocusReadState(
  context: vscode.ExtensionContext,
  orgPanelProvider: OrgPanelProvider,
): void {
  const tabGroups = (vscode.window as unknown as { tabGroups?: TabGroupsShim }).tabGroups;
  if (tabGroups === undefined) {
    return; // 1.66 engines floor: the Tabs API is unavailable; open-via-Nest still clears.
  }
  // The last processed active-tab signature ("<viewType>::<label>"), so a burst of tab changes that keeps the same tab does no disk scan and no re-post.
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
      // Only a focused Claude chat tab identifies an active chat; otherwise clear the active-row tint.
      if (activeTab === undefined || !isClaudeChatViewType(viewType)) {
        orgPanelProvider.setActiveChat(null);
        return;
      }
      const sessionId = matchTabLabelToChat(label, orgPanelProvider.scanRecords());
      // Tint the matched chat (null when the label is unnamed or ambiguous, so no row is tinted). Mark seen only when the active chat changed, so re-focusing the same chat does not re-post.
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
  // Seed the active state from the currently focused tab on activation, since a Claude chat may already be open.
  onFocusChange();
}

// Recover the shared ChatRecord from a chat-row node (a Folders member or a Tags occurrence, kept for programmatic callers). A non-chat node yields undefined, so Preview Full Chat no-ops on a folder or tag row.
function chatRecordFrom(
  item?: ChatMemberItem | ChatOccurrenceItem,
): ChatRecord | undefined {
  if (item instanceof ChatMemberItem || item instanceof ChatOccurrenceItem) {
    return item.record;
  }
  return undefined;
}

// The chat-row node shapes a curation command can fire on: a folder member, a tags occurrence, or a bare sessionId from a programmatic caller.
// The Archive overlay's Restore and unarchive-star go through OrgPanelActions.restoreArchivedChat, which builds the target directly.
type CurationClickable =
  | ChatMemberItem
  | ChatOccurrenceItem
  | string;

// Recover the CurationTarget (sessionId, filePath, title) from a clicked chat row; the ChatRecord carries filePath and title.
// A bare sessionId yields an empty filePath, which star, unstar and restore on an archived chat do not need. A non-chat node yields undefined, so a curation command no-ops on a folder or tag row.
function curationTargetFrom(item?: CurationClickable): CurationTarget | undefined {
  if (typeof item === 'string') {
    return { sessionId: item, filePath: '', title: item };
  }
  if (item instanceof ChatMemberItem || item instanceof ChatOccurrenceItem) {
    return { sessionId: item.record.sessionId, filePath: item.record.filePath, title: item.record.title };
  }
  return undefined;
}

// Recover a PromotableGroup from a promote-command argument: a plain {name, memberChatIds} object, validated structurally (memberChatIds must be an array of strings, else undefined and the command no-ops).
// The name becomes the folder name or tag label, and memberChatIds the chats to file or tag.
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

// Recover the clicked chats' sessionIds from a tag-command invocation. A tree context-menu command passes the clicked node first and the full multi-selection second; the selection wins, then the clicked node, then a bare sessionId.
// A chat node resolves to record.sessionId (Folders member) or its occurrence chat (Tags); folder and tag rows contribute nothing. The result is de-duplicated in first-seen order.
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
