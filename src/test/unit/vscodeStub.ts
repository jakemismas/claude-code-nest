// Minimal headless stub of the `vscode` module, installed into the Node require cache so modules that import
// vscode (exportImportCommands, exportIO) run under the plain mocha runner. Every interaction is recorded on
// `vscodeHarness` so tests can script responses and assert what was shown. Import it before any vscode importer.

interface FakeUri {
  fsPath: string;
  scheme: 'file';
  joinPath?: never;
}

interface ShownMessage {
  kind: 'info' | 'warning' | 'error';
  message: string;
}

class VscodeHarness {
  // Recorded toasts, in order, across all severities.
  readonly messages: ShownMessage[] = [];

  // Scripted response for the next showOpenDialog: a path returns that Uri, null or undefined means cancelled.
  openDialogResult: string | null | undefined = undefined;

  readonly files = new Map<string, string>();

  readonly readErrors = new Set<string>();

  // Recorded writeFile calls with decoded content, so tests can count snapshot writes.
  readonly writes: { path: string; content: string }[] = [];

  // Forces writeFile to reject, keyed by fsPath.
  readonly writeErrors = new Set<string>();

  readonly createdDirs: string[] = [];
  readonly deletes: string[] = [];

  // Forces delete to reject, keyed by fsPath.
  readonly deleteErrors = new Set<string>();

  // Scripted directory listings keyed by dir fsPath; absent dirs list as empty.
  readonly dirEntries = new Map<string, [string, number][]>();

  reset(): void {
    this.messages.length = 0;
    this.openDialogResult = undefined;
    this.files.clear();
    this.readErrors.clear();
    this.writes.length = 0;
    this.writeErrors.clear();
    this.createdDirs.length = 0;
    this.deletes.length = 0;
    this.deleteErrors.clear();
    this.dirEntries.clear();
  }

  warnings(): string[] {
    return this.messages.filter((m) => m.kind === 'warning').map((m) => m.message);
  }
  infos(): string[] {
    return this.messages.filter((m) => m.kind === 'info').map((m) => m.message);
  }
  errors(): string[] {
    return this.messages.filter((m) => m.kind === 'error').map((m) => m.message);
  }

  seedFile(fsPath: string, content: string): FakeUri {
    this.files.set(fsPath, content);
    return makeUri(fsPath);
  }
}

export const vscodeHarness = new VscodeHarness();

function makeUri(fsPath: string): FakeUri {
  return { fsPath, scheme: 'file' };
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

// Minimal TreeView and Webview primitives so provider modules can be required headless.
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

class TreeItem {
  label: unknown;
  collapsibleState: unknown;
  constructor(label: unknown, collapsibleState?: unknown) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MarkdownString {
  value: string;
  isTrusted = false;
  supportThemeIcons = false;
  constructor(value = '') {
    this.value = value;
  }
}

class ThemeIcon {
  id: string;
  color?: unknown;
  constructor(id: string, color?: unknown) {
    this.id = id;
    this.color = color;
  }
}

// Minimal ThemeColor so providers that build themed icon colors can be required headless.
class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: (): void => undefined };
  };
  fire(data: T): void {
    for (const l of this.listeners) {
      l(data);
    }
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

const fakeVscode = {
  // Values match vscode.ConfigurationTarget, so code that picks a settings target can run headless.
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: {
    file: (p: string): FakeUri => makeUri(p),
    joinPath: (base: FakeUri, ...segs: string[]): FakeUri =>
      makeUri([base.fsPath, ...segs].join('/')),
  },
  FileType,
  TreeItem,
  TreeItemCollapsibleState,
  MarkdownString,
  ThemeIcon,
  ThemeColor,
  EventEmitter,
  window: {
    showInformationMessage: (message: string, ..._items: string[]): Thenable<undefined> => {
      vscodeHarness.messages.push({ kind: 'info', message });
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, ..._items: string[]): Thenable<undefined> => {
      vscodeHarness.messages.push({ kind: 'warning', message });
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string, ..._items: string[]): Thenable<undefined> => {
      vscodeHarness.messages.push({ kind: 'error', message });
      return Promise.resolve(undefined);
    },
    showOpenDialog: (_options: unknown): Thenable<FakeUri[] | undefined> => {
      const result = vscodeHarness.openDialogResult;
      if (result === null || result === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve([makeUri(result)]);
    },
    showSaveDialog: (_options: unknown): Thenable<FakeUri | undefined> =>
      Promise.resolve(undefined),
  },
  workspace: {
    fs: {
      readFile: (uri: FakeUri): Thenable<Uint8Array> => {
        if (vscodeHarness.readErrors.has(uri.fsPath)) {
          return Promise.reject(new Error('EACCES: simulated read failure'));
        }
        const content = vscodeHarness.files.get(uri.fsPath);
        if (content === undefined) {
          return Promise.reject(new Error('ENOENT: no such file: ' + uri.fsPath));
        }
        return Promise.resolve(new Uint8Array(Buffer.from(content, 'utf8')));
      },
      writeFile: (uri: FakeUri, content: Uint8Array): Thenable<void> => {
        if (vscodeHarness.writeErrors.has(uri.fsPath)) {
          return Promise.reject(new Error('EACCES: simulated write failure'));
        }
        const text = Buffer.from(content).toString('utf8');
        vscodeHarness.writes.push({ path: uri.fsPath, content: text });
        vscodeHarness.files.set(uri.fsPath, text);
        return Promise.resolve();
      },
      createDirectory: (uri: FakeUri): Thenable<void> => {
        vscodeHarness.createdDirs.push(uri.fsPath);
        return Promise.resolve();
      },
      readDirectory: (uri: FakeUri): Thenable<[string, number][]> =>
        Promise.resolve(vscodeHarness.dirEntries.get(uri.fsPath) ?? []),
      delete: (uri: FakeUri): Thenable<void> => {
        if (vscodeHarness.deleteErrors.has(uri.fsPath)) {
          return Promise.reject(new Error('EPERM: simulated delete failure'));
        }
        vscodeHarness.deletes.push(uri.fsPath);
        return Promise.resolve();
      },
    },
  },
};

// Patch the module loader once so require('vscode') resolves to the stub. Use the CommonJS module object,
// whose _load is writable; an ESM namespace import is frozen.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const moduleAny = require('module') as {
  _load?: (request: string, parent: unknown, isMain: boolean) => unknown;
  __vscodeStubInstalled?: boolean;
};
if (!moduleAny.__vscodeStubInstalled) {
  const originalLoad = moduleAny._load;
  if (typeof originalLoad === 'function') {
    moduleAny._load = function patchedLoad(
      request: string,
      parent: unknown,
      isMain: boolean,
    ): unknown {
      if (request === 'vscode') {
        return fakeVscode;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    moduleAny.__vscodeStubInstalled = true;
  }
}
