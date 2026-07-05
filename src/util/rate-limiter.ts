interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly sweepIntervalMs = 5 * 60 * 1000;

  constructor(rpm: number, burst?: number) {
    if (rpm <= 0) {
      this.capacity = 0;
      this.refillPerSecond = 0;
      return;
    }
    this.refillPerSecond = rpm / 60;
    this.capacity = burst && burst > 0 ? burst : Math.max(1, Math.ceil(rpm / 60));
    setInterval(() => this.sweep(), this.sweepIntervalMs).unref?.();
  }

  get enabled(): boolean {
    return this.capacity > 0;
  }

  consume(key: string): boolean {
    if (!this.enabled) return true;
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: Math.max(0, this.capacity - 1), lastRefill: now });
      return this.capacity > 0;
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.sweepIntervalMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key);
    }
  }
}
