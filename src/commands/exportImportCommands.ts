import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';
import { ProjectMeta } from '../store/schema';
import {
  EnvelopeValidation,
  buildEnvelope,
  migrateEnvelope,
  validateEnvelope,
} from '../store/schemaMigrate';
import { ImportPlan, buildImportPlan } from '../store/exportImport';
import {
  SyncShadow,
  coerceShadow,
  reconcileProjectSync,
} from '../store/reconcileSync';
import {
  computeRetentionPrune,
  retentionSnapshotName,
} from '../store/autoExport';
import {
  deleteFile,
  ensureDirectory,
  listDirectory,
  readTextFile,
  writeTextFile,
} from '../store/exportIO';

// The vscode-bound side of export, import and cross-machine sync: filesystem IO, the activation hook, window-focus polling, globalStorage access and the last-writer-wins warning toast.
// Pure modules (exportImport, reconcileSync, schemaMigrate, autoExport) do the data work. File writes live in the exempted src/store/exportIO.ts, so this module makes no write-shaped call and nothing writes under ~/.claude.

export const EXPORT_COMMAND = 'claudeNest.exportLibrary';
export const IMPORT_COMMAND = 'claudeNest.importLibrary';

// The opt-in auto-export flag and its one-time prompt flag, stored on globalState (not synced). Default off.
const AUTO_EXPORT_ENABLED_KEY = 'nest.autoExport.enabled.v1';
const AUTO_EXPORT_PROMPTED_KEY = 'nest.autoExport.prompted.v1';

// Keep the most recent N auto-export snapshots and prune older ones; N comes from the autoExport module.
const AUTO_EXPORT_DEBOUNCE_MS = 5000;

// The last-writer-wins warning, shown once per reconcile or import pass when a same-scalar (folderId) conflict lost one side.
function lwwWarning(conflictCount: number): string {
  return (
    'Claude Code Nest: merged organization across machines. ' +
    String(conflictCount) +
    (conflictCount === 1 ? ' chat had' : ' chats had') +
    ' a conflicting folder set on two machines; the most recent edit won and the ' +
    'other was dropped. Tags and links were unioned (kept from both). The export ' +
    'JSON is the authoritative backup.'
  );
}

// What the export and import wiring needs from extension.ts: the store, globalStorageUri and globalState for the opt-in flags.
export interface ExportImportDeps {
  store: MetadataStore;
  // The per-extension storage dir for auto-export snapshots; created before the first write if missing.
  globalStorageUri: vscode.Uri;
  // Used only for the opt-in flags; the store owns all ProjectMeta and shadow access.
  flags: {
    get(key: string): boolean | undefined;
    update(key: string, value: boolean): Thenable<void>;
  };
  // The device id this install stamps with, to tell self writes from foreign ones.
  deviceId: string;
  // Called after a reconcile/import applies merges so the views re-render.
  refresh: () => void;
  // Injected clock for deterministic snapshot names; defaults to Date.now.
  now?: () => number;
  // Auto-export debounce window in ms; defaults to AUTO_EXPORT_DEBOUNCE_MS. Tests inject a short value because there is no fake-timer dependency.
  autoExportDebounceMs?: number;
}

// ---- Export: all projects, with their stamps, to a user-chosen JSON backup.

export async function exportLibrary(deps: ExportImportDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const envelope = buildEnvelope(collectAllProjects(deps.store), now);
  const json = JSON.stringify(envelope, null, 2);

  const target = await vscode.window.showSaveDialog({
    title: 'Export Claude Code Nest library',
    saveLabel: 'Export',
    filters: { JSON: ['json'] },
    defaultUri: vscode.Uri.joinPath(
      deps.globalStorageUri,
      'claude-code-nest-export.json',
    ),
  });
  if (!target) {
    return;
  }
  try {
    await writeTextFile(target, json);
  } catch (err) {
    vscode.window.showErrorMessage(
      'Claude Code Nest: export failed. ' + errorText(err),
    );
    return;
  }
  vscode.window.showInformationMessage(
    'Claude Code Nest: exported ' +
      String(Object.keys(envelope.projects).length) +
      ' project(s) to ' +
      target.fsPath,
  );
}

// ---- Import: validate and migrate a parsed copy before touching the live store, then merge additively per project (a project absent from the file is never deleted).

export async function importLibrary(deps: ExportImportDeps): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import Claude Code Nest library',
    openLabel: 'Import',
    canSelectMany: false,
    filters: { JSON: ['json'] },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const fileUri = picked[0];

  let text: string;
  try {
    text = await readTextFile(fileUri);
  } catch (err) {
    vscode.window.showErrorMessage(
      'Claude Code Nest: could not read the import file. ' + errorText(err),
    );
    return;
  }

  // Validate and migrate the parsed copy first; the live store is untouched until the plan is built.
  const plan = buildPlanFromText(text, deps);
  if (!plan.ok) {
    vscode.window.showErrorMessage('Claude Code Nest: ' + plan.error);
    return;
  }

  // Persist each merged project, then one flush. putProjectMeta re-stamps and preserves __unknown; projects absent from the file are never touched.
  let mergedProjects = 0;
  const changedKeys: string[] = [];
  for (const result of plan.plan.results) {
    if (result.changed) {
      // Finalize the shadow only after a staged write; finalizing after a rejected one would launder the live value into the baseline. validateEnvelope already skips unsafe keys, so this is a backstop.
      if (deps.store.putProjectMeta(result.projectKey, result.merged)) {
        changedKeys.push(result.projectKey);
        mergedProjects++;
      }
    }
  }
  await deps.store.flush();
  // Finalize the reconcile shadow to the post-flush, re-stamped live value. Otherwise the next focus poll treats the imported state as a foreign write and shows the LWW warning again.
  for (const projectKey of changedKeys) {
    const persisted = deps.store.getProjectMeta(projectKey);
    await deps.store.putSyncShadow(projectKey, {
      meta: persisted,
      deviceId: deps.deviceId,
    } satisfies SyncShadow);
  }
  deps.refresh();

  if (plan.plan.totalFolderConflicts > 0) {
    vscode.window.showWarningMessage(lwwWarning(plan.plan.totalFolderConflicts));
  }
  vscode.window.showInformationMessage(
    'Claude Code Nest: imported and merged ' +
      String(plan.plan.results.length) +
      ' project(s) from the file (' +
      String(mergedProjects) +
      ' changed). No projects were deleted.' +
      (plan.skippedProjects > 0
        ? ' Skipped ' +
          String(plan.skippedProjects) +
          ' project entry(ies) with an invalid key or oversized document.'
        : ''),
  );
}

// Parse the import text and build the plan against the live store, returning a structured result so validation failures surface without throwing.
// skippedProjects carries the count of entries validateEnvelope dropped, so a partial import is reported honestly.
type PlanResult =
  | { ok: true; plan: ImportPlan; skippedProjects: number }
  | { ok: false; error: string };

function buildPlanFromText(text: string, deps: ExportImportDeps): PlanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The import file is not valid JSON.' };
  }
  const validation: EnvelopeValidation = validateEnvelope(parsed);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  const now = (deps.now ?? Date.now)();
  const normalized = migrateEnvelope(validation.envelope, deps.deviceId, now);
  // Build the plan from the reconciled live read: a plan rooted on an unreconciled foreign value would carry its loss through the apply loop, and the re-stamp would launder it into a self-write.
  const plan = buildImportPlan(normalized, (projectKey) =>
    deps.store.getReconciledProjectMeta(projectKey),
  );
  return { ok: true, plan, skippedProjects: validation.envelope.skippedProjects };
}

// ---- Cross-machine reconcile on activation and window focus. There is no Memento change event, so each call diffs every project's live synced value against the local shadow and merges additively on a foreign write.

export async function reconcileAllProjects(deps: ExportImportDeps): Promise<void> {
  const projectKeys = deps.store.allProjectKeys();
  let totalConflicts = 0;
  // Projects whose merge wrote the store; their shadow is finalized from the post-flush live value so the next poll reports unchanged.
  const mergedKeys: string[] = [];
  // Projects whose merge needed no store write because merged equals live (a pure-superset foreign write). The shadow must still advance, or every focus poll re-merges and re-fires the LWW warning.
  const acceptedKeys: string[] = [];

  for (const projectKey of projectKeys) {
    const live = deps.store.getProjectMeta(projectKey);
    const shadow: SyncShadow | null = coerceShadow(
      deps.store.getSyncShadow(projectKey),
    );
    const outcome = reconcileProjectSync(projectKey, live, shadow, deps.deviceId);

    if (outcome.kind === 'unchanged') {
      continue;
    }
    if (outcome.kind === 'adopt' || outcome.kind === 'self-write') {
      // No merge needed; refresh the shadow so the next poll reports unchanged.
      await deps.store.putSyncShadow(projectKey, outcome.shadow);
      continue;
    }
    // Persist the additive merge now and finalize the shadow after the flush. Gate on storeChanged (merged != live), not result.changed (merged != shadow): a foreign value that dropped a local-only record has merged == shadow, and skipping would lose the record permanently.
    if (outcome.storeChanged) {
      // A rejected key (failing isSafeProjectKey) is skipped: finalizing its shadow would launder the lossy live value and disable additive restore. allProjectKeys no longer lists such keys; this is a backstop.
      if (deps.store.putProjectMeta(projectKey, outcome.result.merged)) {
        mergedKeys.push(projectKey);
      }
    } else {
      // merged equals live, so no write is needed; advance the shadow so this foreign value is not re-merged on the next poll.
      acceptedKeys.push(projectKey);
    }
    totalConflicts += outcome.result.folderConflicts.length;
  }

  for (const projectKey of acceptedKeys) {
    await deps.store.putSyncShadow(projectKey, {
      meta: deps.store.getProjectMeta(projectKey),
      deviceId: deps.deviceId,
    } satisfies SyncShadow);
  }
  if (mergedKeys.length > 0) {
    await deps.store.flush();
    // Finalize each merged project's shadow to the persisted, re-stamped value so the next poll diff is empty.
    for (const projectKey of mergedKeys) {
      const persisted = deps.store.getProjectMeta(projectKey);
      await deps.store.putSyncShadow(projectKey, {
        meta: persisted,
        deviceId: deps.deviceId,
      } satisfies SyncShadow);
    }
    deps.refresh();
  }
  if (totalConflicts > 0) {
    vscode.window.showWarningMessage(lwwWarning(totalConflicts));
  }
}

// ---- Debounced opt-in auto-export snapshots to globalStorage, with retention.

export class AutoExporter {
  private readonly deps: ExportImportDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly snapshotsDir: vscode.Uri;
  private readonly debounceMs: number;

  constructor(deps: ExportImportDeps) {
    this.deps = deps;
    this.snapshotsDir = vscode.Uri.joinPath(deps.globalStorageUri, 'auto-export');
    this.debounceMs = deps.autoExportDebounceMs ?? AUTO_EXPORT_DEBOUNCE_MS;
  }

  // Schedule a debounced snapshot, coalescing a burst of mutations. No-op when the opt-in is off.
  schedule(): void {
    if (this.deps.flags.get(AUTO_EXPORT_ENABLED_KEY) !== true) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.snapshotNow();
    }, this.debounceMs);
  }

  // Snapshot now and prune to retention. Best-effort: failures are swallowed because the manual export is the authoritative backup. Exposed for the dispose flush.
  async snapshotNow(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const envelope = buildEnvelope(collectAllProjects(this.deps.store), now);
    const json = JSON.stringify(envelope, null, 2);
    const name = retentionSnapshotName(now);
    try {
      await ensureDirectory(this.snapshotsDir);
      await writeTextFile(vscode.Uri.joinPath(this.snapshotsDir, name), json);
      await this.prune();
    } catch {
      // Best-effort; the manual export is authoritative.
    }
  }

  // Prune snapshots beyond the retention count: the pure module computes the prune set, and the listing and deletes go through exportIO.
  private async prune(): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await listDirectory(this.snapshotsDir);
    } catch {
      return;
    }
    const names = entries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([n]) => n);
    const toDelete = computeRetentionPrune(names);
    for (const name of toDelete) {
      try {
        await deleteFile(vscode.Uri.joinPath(this.snapshotsDir, name));
      } catch {
        // Best-effort prune; ignore an individual delete failure.
      }
    }
  }

  // Cancel any pending debounce on dispose. It does not force a final snapshot; the store's own flush covers live data.
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// The one-time prompt to enable auto-export and point the canonical export at a synced or
// git-tracked location. Shown once; the prompted flag is then set so it never nags again.
// Opt-in: declining leaves auto-export OFF.
export async function maybePromptAutoExport(deps: ExportImportDeps): Promise<void> {
  if (deps.flags.get(AUTO_EXPORT_PROMPTED_KEY) === true) {
    return;
  }
  await deps.flags.update(AUTO_EXPORT_PROMPTED_KEY, true);
  const ENABLE = 'Enable auto-export';
  const EXPORT_NOW = 'Export now...';
  const choice = await vscode.window.showInformationMessage(
    'Claude Code Nest stores your folders, tags, and links in VSCode globalState ' +
      '(best-effort Settings Sync). The export JSON is the authoritative backup. ' +
      'Enable a periodic auto-export snapshot to extension storage, and consider ' +
      'pointing a manual export at a synced or git-tracked location.',
    ENABLE,
    EXPORT_NOW,
  );
  if (choice === ENABLE) {
    await deps.flags.update(AUTO_EXPORT_ENABLED_KEY, true);
  } else if (choice === EXPORT_NOW) {
    await exportLibrary(deps);
  }
}

// ---- Internals.

// Collect every project's current document keyed by projectKey, from the store's authoritative read path, for export and snapshot.
function collectAllProjects(store: MetadataStore): {
  [projectKey: string]: ProjectMeta;
} {
  const out: { [projectKey: string]: ProjectMeta } = {};
  for (const projectKey of store.allProjectKeys()) {
    out[projectKey] = store.getProjectMeta(projectKey);
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
