import * as vscode from 'vscode';
import { assertNotUnderClaudeProjects } from './exportPathGuard';

// Narrow, carve-out-exempted IO module for the export/import and auto-export
// snapshot file operations (slice patch "WRITE-BAN COLLISION" resolution). Every
// write here is a vscode.workspace.fs call (NOT node fs), but the read-only lint
// bank's first selector is object-AGNOSTIC: CallExpression[callee.property.name in
// the write list] matches `vscode.workspace.fs.writeFile(...)` just as it matches
// `fs.writeFile(...)`. So a vscode.workspace.fs write trips the bank regardless,
// and this module is added to the .eslintrc override list alongside
// claudeSettingsIO.ts. The vscode FileSystem mutators delete/createDirectory/copy
// are additionally caught by a vscode.workspace.fs-chained selector, carved out
// only for this module.
//
// The exemption stays auditable because this module is TINY and does NOTHING but
// the vscode.workspace.fs primitives the export/import flow needs. It does NOT
// import node fs at all, so the carve-out cannot smuggle a node fs write into the
// extension: a node-fs write would still be visible in review here, and the rest
// of src remains under the full ban. NOTHING here writes under
// ~/.claude/projects/ (export targets are a user-chosen path or the extension
// globalStorageUri); the only sanctioned ~/.claude write remains
// claudeSettingsIO.ts behind its path assert.
//
// Runtime guard (mirrors claudeSettingsIO.assertAllowedTarget): unlike the
// settings chokepoint, the export target comes from a save dialog the user can
// navigate ANYWHERE, including into ~/.claude/projects/<encoded-dir>/ where they
// could overwrite a Claude transcript. An exempt fs module must runtime-assert its
// target, not trust the dialog filter. Every write/createDirectory/delete below
// first calls assertNotUnderClaudeProjects (the pure, headless-tested guard in
// exportPathGuard.ts), which throws before any path under ~/.claude/projects/ is
// touched, so the sacred read-only constraint is enforced even when a user (or a
// future buggy caller) aims the write there.

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  assertNotUnderClaudeProjects(uri.fsPath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

export async function ensureDirectory(dir: vscode.Uri): Promise<void> {
  assertNotUnderClaudeProjects(dir.fsPath);
  // createDirectory is idempotent: it does not throw when the directory exists.
  await vscode.workspace.fs.createDirectory(dir);
}

export async function listDirectory(
  dir: vscode.Uri,
): Promise<[string, vscode.FileType][]> {
  return vscode.workspace.fs.readDirectory(dir);
}

export async function deleteFile(uri: vscode.Uri): Promise<void> {
  assertNotUnderClaudeProjects(uri.fsPath);
  await vscode.workspace.fs.delete(uri);
}
