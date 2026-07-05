import { performance } from 'node:perf_hooks';

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be >= 1');
    this.available = limit;
  }

  async run<T>(operation: () => Promise<T>, onAcquired?: (waitMs: number) => void): Promise<T> {
    const started = performance.now();
    await this.acquire();
    onAcquired?.(performance.now() - started);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.available += 1;
  }
}
