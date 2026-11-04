import * as vscode from 'vscode';
import { assertNotUnderClaudeProjects } from './exportPathGuard';

// File operations for export, import and auto-export snapshots, built on vscode.workspace.fs.
// The lint rules ban writes by method name, so this module is the single exempt file.
// The save dialog can point anywhere, so each write path first calls assertNotUnderClaudeProjects.

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
