import * as path from 'path';

// Resolves the VS Code executable inside a downloaded build. Kept free of any
// @vscode/test-electron import so a unit test can load it without the downloader.

export interface FsProbe {
  exists(p: string): boolean;
}

// Newer macOS builds ship the main binary as `Code`; older ones use `Electron`.
const MAC_FALLBACK_NAME = 'Code';
const MAC_PRIMARY_NAME = 'Electron';

export function resolveVscodeExecutable(downloadedPath: string, probe: FsProbe): string {
  if (probe.exists(downloadedPath)) {
    return downloadedPath;
  }
  const dir = path.dirname(downloadedPath);
  if (path.basename(downloadedPath) === MAC_PRIMARY_NAME) {
    const fallback = path.join(dir, MAC_FALLBACK_NAME);
    if (probe.exists(fallback)) {
      return fallback;
    }
  }
  throw new Error('VS Code executable not found at ' + downloadedPath);
}
