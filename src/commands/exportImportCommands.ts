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

// The vscode-bound side of Slice 8. This module owns ALL filesystem IO, the
// activation hook, the window-focus polling, globalStorage access, and the LWW
// warning toast. The pure modules (exportImport, reconcileSync, schemaMigrate,
// autoExport) take plain data and return plain results; here we plumb them to the
// real environment.
//
// Read-only chokepoint (slice patch "WRITE-BAN COLLISION" resolution): the lint
// bank's first selector is object-AGNOSTIC, so even a vscode.workspace.fs write
// (vscode.workspace.fs.writeFile(...)) trips it the same as a node fs write. The
// file IO is therefore isolated in the narrow, carve-out-exempted src/store/
// exportIO.ts (listed in .eslintrc alongside claudeSettingsIO.ts); this command
// module calls those helpers and performs NO write-shaped call itself, so it stays
// under the full ban and the exemption is confined to a tiny auditable module that
// does nothing but the vscode.workspace.fs primitives. NOTHING writes under
// ~/.claude (export targets are a user-chosen path or globalStorageUri); the only
// sanctioned ~/.claude write remains claudeSettingsIO.ts.

export const EXPORT_COMMAND = 'claudeNest.exportLibrary';
export const IMPORT_COMMAND = 'claudeNest.importLibrary';

// The opt-in auto-export gate and its one-time prompt flag, stored on globalState
// (non-synced concerns; plain booleans). Default off (opt-in).
const AUTO_EXPORT_ENABLED_KEY = 'nest.autoExport.enabled.v1';
const AUTO_EXPORT_PROMPTED_KEY = 'nest.autoExport.prompted.v1';

// Retention: keep the most recent N auto-export snapshots, prune older. N lives in
// the pure autoExport module so it is unit-testable; here it is the default.
const AUTO_EXPORT_DEBOUNCE_MS = 5000;

// The honest last-writer-wins warning, surfaced once per reconcile/import pass
// when a same-scalar (folderId) conflict lost one side.
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

// The dependencies the export/import wiring needs from extension.ts. Kept narrow
// so the command logic is testable in isolation if needed and so extension.ts
// threads exactly what is required (the store, the globalStorageUri, the
// globalState for the opt-in flags).
export interface ExportImportDeps {
  store: MetadataStore;
  // context.globalStorageUri: the per-extension storage dir the auto-export
  // snapshots write to (and prune within). The dir may not exist yet; we create
  // it via vscode.workspace.fs before the first write.
  globalStorageUri: vscode.Uri;
  // context.globalState, used ONLY for the opt-in flags (enabled, prompted). The
  // store owns all ProjectMeta/shadow access; these are plain UI-preference
  // booleans, intentionally not synced.
  flags: {
    get(key: string): boolean | undefined;
    update(key: string, value: boolean): Thenable<void>;
  };
  // The device id this install stamps with, for the reconcile self/foreign
  // attribution.
  deviceId: string;
  // Called after a reconcile/import applies merges so the views re-render.
  refresh: () => void;
  // Injected clock for deterministic snapshot names in tests; defaults to
  // Date.now in the production wiring.
  now?: () => number;
  // Auto-export debounce window in ms; defaults to AUTO_EXPORT_DEBOUNCE_MS in the
  // production wiring. Injected small in unit tests so the debounce/coalesce
  // behavior is exercisable deterministically with short real timers (there is no
  // fake-timer dependency in this project).
  autoExportDebounceMs?: number;
}

// ---- Export. Writes ALL projects (with their stamps) to a user-chosen JSON as
// ---- the authoritative backup.

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

// ---- Import. Validates and migrates a SCRATCH copy BEFORE touching the live
// ---- store, then merges additively per project (never deleting a project absent
// ---- from the file). The "scratch copy" is the parsed-and-migrated envelope held
// ---- in memory; the live store is only consulted (read) to build the plan and is
// ---- mutated only after the whole plan is validated and built. putProjectMeta is
// ---- itself a single staged write per project that flushes atomically.

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

  // Parse + validate + migrate the SCRATCH copy first; the live store is untouched
  // until the plan is fully built.
  const plan = buildPlanFromText(text, deps);
  if (!plan.ok) {
    vscode.window.showErrorMessage('Claude Code Nest: ' + plan.error);
    return;
  }

  // Apply: persist each merged project via the store, then one flush so the swap
  // is durable in one settle. putProjectMeta re-stamps and preserves __unknown; a
  // project absent from the file is never enumerated and so never touched.
  let mergedProjects = 0;
  const changedKeys: string[] = [];
  for (const result of plan.plan.results) {
    if (result.changed) {
      deps.store.putProjectMeta(result.projectKey, result.merged);
      changedKeys.push(result.projectKey);
      mergedProjects++;
    }
  }
  await deps.store.flush();
  // Finalize the reconcile shadow for each changed project to the post-flush,
  // re-stamped live value, exactly as reconcileAllProjects does. Without this the
  // import-merged chats keep the WINNING side's foreign per-chat deviceId with an
  // updatedAt newer than the stale shadow, so the very next window-focus poll would
  // misclassify the just-imported state as a FOREIGN write, re-run the (idempotent)
  // merge, and re-show the LWW warning a second time after a normal restore.
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
      ' changed). No projects were deleted.',
  );
}

// Parse the import text and build the plan against the live store. Returns a
// structured result so the validation failure can be surfaced without throwing.
// The migration runs on the SCRATCH (parsed) copy; readLive only READS the store.
type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; error: string };

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
  // Build the plan from the RECONCILED live read (security fix pass round 3):
  // the plan's per-project merge result is persisted wholesale via
  // putProjectMeta, so a plan rooted on an unreconciled, just-landed lossy
  // foreign sync value would carry that loss straight through the apply loop
  // and the re-stamp would launder it into a self-write. The reconciled read
  // restores anything a foreign wholesale-replace dropped before the file is
  // merged on top.
  const plan = buildImportPlan(normalized, (projectKey) =>
    deps.store.getReconciledProjectMeta(projectKey),
  );
  return { ok: true, plan };
}

// ---- Cross-machine reconcile, run on activation and on window focus.
// ---- Best-effort polling: there is no Memento remote-change event, so each call
// ---- diffs the live synced value of every known project against the local-only
// ---- shadow and reconciles additively on a detected foreign write.

export async function reconcileAllProjects(deps: ExportImportDeps): Promise<void> {
  const projectKeys = deps.store.allProjectKeys();
  let totalConflicts = 0;
  // Projects whose merge actually wrote the store: their shadow must be FINALIZED
  // from the post-write live value (after the flush re-stamps the project), so the
  // next poll sees the stored value equal to the shadow and reports unchanged.
  const mergedKeys: string[] = [];
  // Projects whose foreign-merge needs NO store write because the merged document
  // already equals the live store value (storeChanged:false): the foreign value was
  // a pure superset that dropped nothing, so the union restores nothing and the
  // store is already correct. Their shadow must STILL advance to the current live
  // value, or the next focus poll re-classifies the same live value as foreign,
  // re-runs the (idempotent) merge, and re-fires the LWW warning toast on EVERY
  // focus-gain because mergedKeys would be empty and the shadow never advanced. No
  // store write is needed; the shadow simply accepts the current live value as the
  // new baseline.
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
      // No merge needed; just record/refresh the shadow so the next poll has an
      // accurate baseline. The shadow IS the current live value here, so the next
      // poll reports unchanged.
      await deps.store.putSyncShadow(projectKey, outcome.shadow);
      continue;
    }
    // foreign-merge: persist the additive merge now (deferring the shadow finalize
    // until after the flush so the shadow records the store's re-stamped value).
    // Gate on storeChanged (merged != the live STORE value), NOT result.changed
    // (merged != the shadow): a foreign value that dropped a local-only record
    // gives merged == shadow (changed:false) yet merged != live, and gating on
    // changed would skip restoring the dropped record and lose it permanently.
    if (outcome.storeChanged) {
      deps.store.putProjectMeta(projectKey, outcome.result.merged);
      mergedKeys.push(projectKey);
    } else {
      // merged already equals the live store value (a pure-superset foreign write
      // that dropped nothing). No store write needed; just advance the shadow to
      // the current live value so this same foreign value is not re-classified as
      // foreign and re-merged on the next poll.
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
    // Finalize each merged project's shadow to the now-persisted, re-stamped live
    // value, so the diff against the shadow on the next poll is empty.
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

// ---- Debounced opt-in auto-export snapshot to globalStorage with retention.

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

  // Schedule a debounced snapshot. A no-op when the opt-in flag is off. Coalesces
  // a burst of mutations into one snapshot.
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

  // Take a snapshot immediately and prune to retention. Best-effort: a write or
  // prune failure is swallowed (the user-driven export is the authoritative
  // backup; the snapshot is a convenience). Exposed for the dispose flush.
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
      // Swallow: the snapshot is best-effort; the manual export is authoritative.
    }
  }

  // Prune older snapshots beyond the retention count. The directory listing comes
  // from vscode.workspace.fs (so node fs stays out of the lint bank) and the prune
  // SET is computed by the pure module; the deletes happen here.
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

  // Cancel any pending debounce. Called on dispose. Does NOT force a final
  // snapshot (the snapshot is best-effort and the store's own flush handles
  // durability of the live data; the manual export is the authoritative backup).
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// The one-time prompt to enable auto-export and point the canonical export at a
// synced or git-tracked location (ARCHITECTURE.md line 242-243). Shown once; the
// prompted flag is then set so it never nags again. Opt-in: declining leaves
// auto-export OFF.
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

// Collect every project's current document keyed by projectKey, from the store's
// authoritative read path (pending/in-flight/persisted), for export and snapshot.
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
