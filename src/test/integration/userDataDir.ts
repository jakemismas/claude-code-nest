import * as path from 'path';

// VS Code opens its IPC socket inside the user data folder, and macOS and Linux
// reject socket paths longer than 103 bytes.
const MAX_SOCKET_PATH = 103;
// Room for the socket file name VS Code appends, such as `/1.144-main.sock`.
const SOCKET_NAME_ROOM = 20;
const FALLBACK_NAME = 'nest-vscode-test';

// Keeps the default folder unless a deep checkout would push the socket past the limit.
export function integrationUserDataDir(defaultDir: string, tmpDir: string): string {
  if (defaultDir.length + SOCKET_NAME_ROOM <= MAX_SOCKET_PATH) {
    return defaultDir;
  }
  return path.join(tmpDir, FALLBACK_NAME);
}
