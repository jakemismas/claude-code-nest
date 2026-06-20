// A minimal headless stub of the `vscode` module, installed into the Node require
// cache so the vscode-importing command/IO modules (exportImportCommands,
// exportIO) can be loaded and EXERCISED under the plain mocha unit runner (no
// vscode host). Only the narrow surface those modules touch is implemented:
// window message toasts, the open dialog, Uri, and a workspace.fs.readFile backed
// by an in-memory file map. Every interaction is recorded on the exported
// `vscodeHarness` so tests can script responses and assert what was shown.
//
// This exists so the ORCHESTRATION functions (reconcileAllProjects, importLibrary)
// can be tested as they actually run -- including the post-flush shadow-finalize
// ordering whose regression a hand-replay of the steps could not catch -- rather
// than only re-playing their internals by hand.
//
// Import this module BEFORE requiring any module that imports 'vscode'. The
// install is idempotent and happens at import time.

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
  // Recorded toasts, in order, across all three severities.
  readonly messages: ShownMessage[] = [];

  // Scripted response for the next showOpenDialog call. When set to a path the
  // dialog "returns" that single Uri; when null/undefined it returns undefined
  // (the user cancelled).
  openDialogResult: string | null | undefined = undefined;

  // In-memory file contents keyed by fsPath, served by workspace.fs.readFile.
  readonly files = new Map<string, string>();

  // Force readFile to reject (simulate an unreadable file), keyed by fsPath.
  readonly readErrors = new Set<string>();

  // Recorded workspace.fs.writeFile calls, in order, with the decoded content.
  // Lets a test count snapshot writes (debounce/coalesce) and inspect payloads.
  readonly writes: { path: string; content: string }[] = [];

  // Force writeFile to reject (simulate a write failure), keyed by fsPath. Used to
  // prove the auto-export best-effort swallow does not throw.
  readonly writeErrors = new Set<string>();

  // Recorded workspace.fs.createDirectory and delete calls, in order.
  readonly createdDirs: string[] = [];
  readonly deletes: string[] = [];

  // Force delete to reject (simulate a prune delete failure), keyed by fsPath.
  // Used to prove the auto-export prune swallows an individual delete failure.
  readonly deleteErrors = new Set<string>();

  // Scripted directory listings for workspace.fs.readDirectory, keyed by dir
  // fsPath. Absent dirs list as empty (matching the default stub).
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

// Minimal TreeView/Webview primitives so a provider module (flatProvider,
// chatTooltip) that extends/constructs these can be require()d under the headless
// runner. Only the construction surface those modules touch is implemented.
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

// Minimal ThemeColor so a provider module (linkDecoration, reached transitively by
// foldersProvider) that constructs a themed icon color can be require()d under the
// headless runner. Only the construction surface is implemented.
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

// Install the stub into the module loader so `require('vscode')` resolves to it.
// Idempotent: only patches once even if imported by several test files. Use the
// CommonJS require('module') object (whose _load is a writable own property), NOT
// an ESM `import * as` namespace, which is a frozen getter-only object.
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
