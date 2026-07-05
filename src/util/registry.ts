interface PendingTask {
  promise: Promise<unknown>;
  cancel?: () => Promise<void> | void;
}

class InFlightRegistry {
  private readonly tasks = new Set<PendingTask>();
  private readonly onEmpty: Array<() => void> = [];

  register<T>(promise: Promise<T>, cancel?: () => Promise<void> | void): Promise<T> {
    const task: PendingTask = { promise };
    if (cancel) task.cancel = cancel;
    this.tasks.add(task);
    void promise.finally(() => {
      this.tasks.delete(task);
      if (this.tasks.size === 0) for (const resolve of this.onEmpty) resolve();
    });
    return promise;
  }

  get size(): number {
    return this.tasks.size;
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.tasks.size === 0) return;
    for (const task of this.tasks) {
      if (task.cancel) {
        const result = task.cancel();
        if (result instanceof Promise) void result.catch(() => undefined);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.onEmpty.length = 0;
        resolve();
      }, timeoutMs);
      this.onEmpty.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export const inFlight = new InFlightRegistry();
