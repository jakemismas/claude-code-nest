// "Nest: Open Layout File". The editor and filesystem are injected.
// Nest writes nothing: a missing file opens as an untitled editor at the .nest/config.json path for the user to save.
import { nestConfigPath } from '../fleet/configSource';

export const OPEN_LAYOUT_FILE_COMMAND = 'claudeNest.openLayoutFile';

// The schema reference must resolve from any workspace, so the caller passes an absolute
// URI to the schema shipped with the extension.
export function starterLayout(schemaRef: string): string {
  return `{
  "$schema": ${JSON.stringify(schemaRef)},
  "groupBy": "auto",
  "linkedFolders": [],
  "doneStages": ["Done"]
}
`;
}

export interface OpenLayoutDeps {
  readonly workspaceFolder: () => string | undefined;
  readonly fileExists: (filePath: string) => Promise<boolean>;
  readonly openExisting: (filePath: string) => Promise<void>;
  readonly schemaRef: () => string;
  readonly openUntitled: (filePath: string, content: string) => Promise<void>;
  readonly notify: (message: string) => void;
}

export async function openLayoutFile(deps: OpenLayoutDeps): Promise<void> {
  const folder = deps.workspaceFolder();
  if (folder === undefined) {
    deps.notify('Open a folder first. The layout file lives at .nest/config.json in the workspace folder.');
    return;
  }
  const filePath = nestConfigPath(folder);
  if (await deps.fileExists(filePath)) {
    await deps.openExisting(filePath);
    return;
  }
  await deps.openUntitled(filePath, starterLayout(deps.schemaRef()));
}
