import * as assert from 'assert';
import {
  RefreshScanDeps,
  RefreshScanUi,
  ScanPrimable,
  refreshWithProgress,
} from '../../commands/refreshScanCommands';
import { ScannerOptions } from '../../claude/chatScanner';

// refreshScanCommands is vscode-free (injected ScanPrimable and RefreshScanUi), so these tests cover that it
// primes the provider with progress and cancel callbacks, shows a blameless error on failure, and never throws.

class FakePrimable implements ScanPrimable {
  public lastOptions: ScannerOptions | undefined;
  public primeCount = 0;
  constructor(private readonly onPrime?: (o: ScannerOptions) => void) {}
  primeSnapshot(scanOptions: ScannerOptions): void {
    this.primeCount++;
    this.lastOptions = scanOptions;
    if (this.onPrime) {
      this.onPrime(scanOptions);
    }
  }
}

function makeUi(opts: {
  cancelled?: boolean;
  throwInWithProgress?: boolean;
  captureErrors?: string[];
}): RefreshScanUi {
  return {
    withProgress: async (_title, work) => {
      if (opts.throwInWithProgress) {
        throw new Error('progress host failed');
      }
      const report = (): void => {};
      const isCancelled = (): boolean => opts.cancelled === true;
      await work(report, isCancelled);
    },
    showError: (message) => {
      opts.captureErrors?.push(message);
    },
  };
}

describe('refreshScanCommands.refreshWithProgress', () => {
  it('primes the provider exactly once with progress + cancellation callbacks wired', async () => {
    let reportedDone = -1;
    let reportedTotal = -1;
    const provider = new FakePrimable((o) => {
      // The provider calls these during its scan; here they only need to be wired through.
      o.onProgress?.(3, 7);
      reportedDone = 3;
      reportedTotal = 7;
      assert.strictEqual(o.shouldCancel?.(), false);
    });
    const deps: RefreshScanDeps = {
      provider,
      ui: makeUi({ cancelled: false }),
      scanLabel: 'chats',
    };
    await refreshWithProgress(deps);
    assert.strictEqual(provider.primeCount, 1);
    assert.ok(provider.lastOptions);
    assert.strictEqual(typeof provider.lastOptions.onProgress, 'function');
    assert.strictEqual(typeof provider.lastOptions.shouldCancel, 'function');
    assert.strictEqual(reportedDone, 3);
    assert.strictEqual(reportedTotal, 7);
  });

  it('propagates a cancellation signal into shouldCancel', async () => {
    let observedCancel: boolean | undefined;
    const provider = new FakePrimable((o) => {
      observedCancel = o.shouldCancel?.();
    });
    await refreshWithProgress({
      provider,
      ui: makeUi({ cancelled: true }),
      scanLabel: 'tags',
    });
    assert.strictEqual(observedCancel, true);
  });

  it('surfaces a Claude-blameless error and never throws when the scan fails', async () => {
    const errors: string[] = [];
    const provider = new FakePrimable(() => {
      throw new Error('scan blew up');
    });
    await refreshWithProgress({
      provider,
      ui: makeUi({ captureErrors: errors }),
      scanLabel: 'folders',
    });
    assert.strictEqual(errors.length, 1);
    const msg = errors[0];
    assert.ok(msg.includes('Claude Code Nest could not finish scanning folders'));
    // The message must not blame Claude (failed, broke, and so on).
    assert.ok(!/Claude (failed|broke|crashed|error)/i.test(msg));
    assert.ok(msg.toLowerCase().includes('unchanged'));
  });

  it('surfaces an error when the progress host itself throws, without rethrowing', async () => {
    const errors: string[] = [];
    const provider = new FakePrimable();
    await refreshWithProgress({
      provider,
      ui: makeUi({ throwInWithProgress: true, captureErrors: errors }),
      scanLabel: 'smart groups',
    });
    assert.strictEqual(provider.primeCount, 0);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('could not finish scanning smart groups'));
  });
});
