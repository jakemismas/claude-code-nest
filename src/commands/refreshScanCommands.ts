import { ScannerOptions } from '../claude/chatScanner';

// Explicit Refresh command: primes the provider snapshot under a cancellable progress notification, then fires one tree change.
// Passive getChildren and getParent stay synchronous over the memoized snapshot; only this module touches CancellationToken.

// A provider that primeSnapshot can rebuild once with progress and cancellation options, then refresh.
export interface ScanPrimable {
  primeSnapshot(scanOptions: ScannerOptions): void;
}

// The vscode UI seam, injected so the command logic runs without vscode.
export interface RefreshScanUi {
  // Run work under a cancellable progress indicator. The work receives a report
  // callback (done/total -> a percentage increment) and a cancellation probe.
  withProgress(
    title: string,
    work: (
      report: (done: number, total: number) => void,
      isCancelled: () => boolean,
    ) => Promise<void> | void,
  ): Promise<void>;
  // Surface a non-blocking error that does not blame Claude (the scan is Nest's own and read-only).
  showError(message: string): void;
}

export interface RefreshScanDeps {
  provider: ScanPrimable;
  ui: RefreshScanUi;
  // The view's label for the progress title, for example 'chats'.
  scanLabel: string;
}

// Run a cancellable, progress-reported refresh. A failure never throws to the host; a toast reports it without blaming Claude.
export async function refreshWithProgress(deps: RefreshScanDeps): Promise<void> {
  const title = 'Scanning ' + deps.scanLabel + '...';
  try {
    await deps.ui.withProgress(title, (report, isCancelled) => {
      const scanOptions: ScannerOptions = {
        onProgress: (done, total) => report(done, total),
        shouldCancel: () => isCancelled(),
      };
      // primeSnapshot scans synchronously with these callbacks and caches the result.
      deps.provider.primeSnapshot(scanOptions);
    });
  } catch {
    // A failure here is Nest's own scan, never Claude's; the toast is the only report.
    deps.ui.showError(
      'Claude Code Nest could not finish scanning ' +
        deps.scanLabel +
        '. Your chats and organization are unchanged; try Refresh again.',
    );
  }
}
