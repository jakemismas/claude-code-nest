// The vscode-bound watcher shells: one file watcher per watched file. The fleet set
// is re-subscribable so a changed layout file can add or drop paths without a reload.
import * as fs from 'fs';
import * as vscode from 'vscode';

import { FleetReloader } from './fleetReloader';
import { findWatchBase } from './watchBase';

// A new watcher takes a moment to start; one late reload catches a write in that gap.
const LATE_NOTIFY_MS = 1000;

function isDirectory(p: string): Promise<boolean> {
  return fs.promises.stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

// Watches one file and calls notify on create, change and delete. While the file's folder
// is missing, it watches the nearest existing folder and moves down as folders appear.
export function watchFile(filePath: string, notify: () => void): vscode.Disposable {
  let current: vscode.Disposable | undefined;
  let late: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  const arm = async (afterCreate: boolean): Promise<void> => {
    const mine = ++generation;
    const where = await findWatchBase(filePath, isDirectory);
    if (disposed || mine !== generation) {
      return;
    }
    current?.dispose();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(where.base), where.name),
    );
    if (where.direct) {
      watcher.onDidCreate(notify);
      watcher.onDidChange(notify);
      // Only a vanished folder needs a new watch; a file replaced in place keeps this one.
      watcher.onDidDelete(() => {
        notify();
        void isDirectory(where.base).then((exists) => {
          if (!exists) {
            void arm(false);
          }
        });
      });
    } else {
      watcher.onDidCreate(() => void arm(true));
    }
    current = watcher;
    if (afterCreate) {
      notify();
      clearTimeout(late);
      late = setTimeout(notify, LATE_NOTIFY_MS);
    }
  };
  void arm(false);
  return new vscode.Disposable(() => {
    disposed = true;
    generation += 1;
    clearTimeout(late);
    current?.dispose();
    current = undefined;
  });
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
