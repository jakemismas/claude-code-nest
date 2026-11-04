// Runs a task with at most one execution in flight. A request that arrives while the
// task runs marks it dirty and causes exactly one more run after the current one settles,
// so a stalled filesystem call never stacks up threads.
export class SingleFlight {
  private running: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly isStopped: () => boolean = () => false,
  ) {}

  run(): Promise<void> {
    if (this.running !== undefined) {
      this.dirty = true;
      return this.running;
    }
    const current = this.drain().finally(() => {
      this.running = undefined;
    });
    this.running = current;
    return current;
  }

  private async drain(): Promise<void> {
    do {
      this.dirty = false;
      await this.task();
    } while (this.dirty && !this.isStopped());
  }
}
