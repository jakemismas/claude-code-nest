import * as vscode from 'vscode';

// Entry point for the Claude Code Nest extension. Slice 0 contributes the
// claudeNest Activity Bar view container and the flat chat list; later slices
// add the Folders, Tags, Links, Smart Groups, and Settings surfaces. This
// scaffold activates cleanly with no contributions so the package installs.
export function activate(_context: vscode.ExtensionContext): void {
  // Intentionally empty in the scaffold. Build slices register their views,
  // commands, and stores here.
}

export function deactivate(): void {
  // No teardown required for the scaffold.
}
