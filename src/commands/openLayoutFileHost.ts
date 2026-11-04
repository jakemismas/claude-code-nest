import * as vscode from 'vscode';
import * as fs from 'fs';
import type { OpenLayoutDeps } from './openLayoutFile';

// Host bindings for "Nest: Open Layout File". The untitled editor takes the target
// path so the layout schema validation applies and Save defaults to .nest/config.json.
export function createOpenLayoutDeps(
  workspacePath: string | undefined,
  extensionUri: vscode.Uri,
): OpenLayoutDeps {
  return {
    workspaceFolder: () => workspacePath,
    fileExists: async (filePath) => {
      try {
        return (await fs.promises.stat(filePath)).isFile();
      } catch {
        return false;
      }
    },
    schemaRef: () => vscode.Uri.joinPath(extensionUri, 'schemas', 'nest-config.schema.json').toString(),
    openExisting: async (filePath) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc);
    },
    openUntitled: async (filePath, content) => {
      const uri = vscode.Uri.file(filePath).with({ scheme: 'untitled' });
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), content));
      await vscode.languages.setTextDocumentLanguage(doc, 'jsonc');
    },
    notify: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  };
}
