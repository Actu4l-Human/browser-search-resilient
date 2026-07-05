interface PendingTask {
  promise: Promise<unknown>;
  cancel?: () => Promise<void> | void;
}

class InFlightRegistry {
  private readonly tasks = new Set<PendingTask>();
  private readonly onEmpty = new Set<() => void>();

  register<T>(promise: Promise<T>, cancel?: () => Promise<void> | void): Promise<T> {
    const task: PendingTask = { promise };
    if (cancel) task.cancel = cancel;
    this.tasks.add(task);
    const cleanup = (): void => {
      this.tasks.delete(task);
      if (this.tasks.size === 0) {
        for (const resolve of this.onEmpty) resolve();
        this.onEmpty.clear();
      }
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  get size(): number {
    return this.tasks.size;
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.tasks.size === 0) return;
    for (const task of this.tasks) {
      if (task.cancel) {
        try {
          await task.cancel();
        } catch {
          // Best-effort cancellation; the timeout still bounds shutdown.
        }
      }
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.onEmpty.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.onEmpty.add(finish);
    });
  }
}

export const inFlight = new InFlightRegistry();
