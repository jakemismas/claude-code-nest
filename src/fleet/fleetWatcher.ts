// The vscode-bound watcher shells: one file watcher per watched file. The fleet set
// is re-subscribable so a changed layout file can add or drop paths without a reload.
import * as path from 'path';
import * as vscode from 'vscode';

import { FleetReloader } from './fleetReloader';

// Watches one file and calls notify on create, change and delete.
export function watchFile(filePath: string, notify: () => void): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), path.basename(filePath));
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidCreate(notify);
  watcher.onDidChange(notify);
  watcher.onDidDelete(notify);
  return watcher;
}

export function watchFleetFiles(
  filePaths: readonly string[],
  reloader: FleetReloader,
): vscode.Disposable {
  const watchers = [...new Set(filePaths)].map((filePath) => watchFile(filePath, () => reloader.notifyFileEvent()));
  return new vscode.Disposable(() => {
    for (const w of watchers) {
      w.dispose();
    }
  });
}

export interface ResubscribingFleetWatcher extends vscode.Disposable {
  // Recomputes the path list and recreates the per-file watchers when it changed.
  refresh(): void;
}

// Keeps one watcher per resolved fleet path. refresh() disposes and recreates the
// watchers only when the resolved path list differs from the current one.
export function watchFleetFilesResubscribing(
  getPaths: () => readonly string[],
  reloader: FleetReloader,
): ResubscribingFleetWatcher {
  let currentKey = '';
  let current: vscode.Disposable | undefined;
  let disposed = false;
  const refresh = (): void => {
    if (disposed) {
      return;
    }
    const paths = [...new Set(getPaths())].sort();
    const key = JSON.stringify(paths);
    if (key === currentKey && current !== undefined) {
      return;
    }
    current?.dispose();
    currentKey = key;
    current = watchFleetFiles(paths, reloader);
  };
  refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      current?.dispose();
      current = undefined;
    },
  };
}

export interface ResubscribingFileWatcher extends vscode.Disposable {
  // Re-reads the path and moves the watcher when it changed.
  refresh(): void;
}

// Keeps one watcher on a path that can change (or disappear) over time.
export function watchFileResubscribing(
  getPath: () => string | undefined,
  notify: () => void,
): ResubscribingFileWatcher {
  let currentPath: string | undefined;
  let current: vscode.Disposable | undefined;
  let disposed = false;
  const refresh = (): void => {
    if (disposed) {
      return;
    }
    const next = getPath();
    if (next === currentPath) {
      return;
    }
    current?.dispose();
    currentPath = next;
    current = next === undefined ? undefined : watchFile(next, notify);
  };
  refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      current?.dispose();
      current = undefined;
    },
  };
}
