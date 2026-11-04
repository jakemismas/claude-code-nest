// The vscode-bound shell: one file watcher per fleet file, feeding the reloader.
import * as path from 'path';
import * as vscode from 'vscode';

import { FleetReloader } from './fleetReloader';

export function watchFleetFiles(
  filePaths: readonly string[],
  reloader: FleetReloader,
): vscode.Disposable {
  const watchers = filePaths.map((filePath) => {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), path.basename(filePath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const notify = (): void => reloader.notifyFileEvent();
    watcher.onDidCreate(notify);
    watcher.onDidChange(notify);
    watcher.onDidDelete(notify);
    return watcher;
  });
  return new vscode.Disposable(() => {
    for (const w of watchers) {
      w.dispose();
    }
  });
}
