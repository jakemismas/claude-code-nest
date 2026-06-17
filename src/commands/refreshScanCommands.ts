import { ScannerOptions } from '../claude/chatScanner';

// The explicit refresh/scan command path that wraps a transcript scan in a
// cancellable progress notification (Polish slice). This is DELIBERATELY separate
// from the passive getChildren/getParent path: those stay synchronous and read the
// provider's memoized snapshot (ARCHITECTURE.md tree binding rules + the slice fit
// patch). Here, an explicit user-driven Refresh primes the provider snapshot under
// vscode.window.withProgress with a CancellationToken, THEN fires onDidChangeTreeData
// once, so the host re-renders from the freshly primed (synchronous) snapshot.
//
// The provider seam is ScanPrimable.primeSnapshot(scanOptions): the provider clears
// its cached snapshot and rebuilds it ONCE with the supplied plain-callback scan
// options (onProgress/shouldCancel from chatScanner.ScannerOptions), then refreshes.
// The scanner stays vscode-free; this module is the only place the CancellationToken
// and the progress UI touch the scan.

// A provider that can be primed by an explicit progress-wrapped scan. Implemented
// by the four view providers. primeSnapshot rebuilds the memoized snapshot once
// with the supplied scan options (progress + cancellation) and then fires its
// change event so the passive getChildren reads the primed snapshot.
export interface ScanPrimable {
  primeSnapshot(scanOptions: ScannerOptions): void;
}

// The vscode UI seam, injected so the command logic stays headless-testable. The
// real wiring (extension.ts) supplies vscode.window.withProgress and the toast
// surface; a unit test can supply plain stand-ins.
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
  // Surface a non-blocking error. Worded so it never blames Claude (the scan reads
  // Claude's transcripts read-only; a failure here is Nest's own scan, not Claude).
  showError(message: string): void;
}

export interface RefreshScanDeps {
  provider: ScanPrimable;
  ui: RefreshScanUi;
  // The view's human label for the progress title (for example 'chats',
  // 'folders'). Kept generic so one helper serves every view.
  scanLabel: string;
}

// Run an explicit, cancellable, progress-reported refresh: prime the provider
// snapshot under a progress indicator, polling the cancellation token before each
// file and reporting per-file progress. A failure NEVER throws out to the host and
// is surfaced through a toast worded so it never attributes the failure to Claude.
export async function refreshWithProgress(deps: RefreshScanDeps): Promise<void> {
  const title = 'Scanning ' + deps.scanLabel + '...';
  try {
    await deps.ui.withProgress(title, (report, isCancelled) => {
      const scanOptions: ScannerOptions = {
        onProgress: (done, total) => report(done, total),
        shouldCancel: () => isCancelled(),
      };
      // primeSnapshot performs the synchronous scan with these callbacks and caches
      // the result; the subsequent passive getChildren reads it without rescanning.
      deps.provider.primeSnapshot(scanOptions);
    });
  } catch {
    // The scan is read-only over Nest's own view of the transcripts; a failure is
    // Nest's, never Claude's. Worded accordingly (telemetry-free: nothing is
    // reported anywhere but this local toast).
    deps.ui.showError(
      'Claude Code Nest could not finish scanning ' +
        deps.scanLabel +
        '. Your chats and organization are unchanged; try Refresh again.',
    );
  }
}
