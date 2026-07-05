export interface MetricsSnapshot {
  requestsTotal: number;
  responsesByStatus: Record<string, number>;
  toolInvocations: Record<string, number>;
  backendOutcomes: Record<string, Record<string, number>>;
  backendDurationMs: Record<string, { sum: number; count: number }>;
  cacheEvents: Record<string, Record<string, number>>;
  semaphoreWaitMs: Record<string, { sum: number; count: number }>;
  rateLimitRejections: number;
  requestDurationMsSum: number;
  requestDurationMsCount: number;
}

class MetricsCollector {
  private requestsTotal = 0;
  private readonly responsesByStatus = new Map<string, number>();
  private readonly toolInvocations = new Map<string, number>();
  private readonly backendOutcomes = new Map<string, Map<string, number>>();
  private readonly backendDurationMs = new Map<string, { sum: number; count: number }>();
  private readonly cacheEvents = new Map<string, Map<string, number>>();
  private readonly semaphoreWaitMs = new Map<string, { sum: number; count: number }>();
  private rateLimitRejections = 0;
  private requestDurationMsSum = 0;
  private requestDurationMsCount = 0;

  recordRequest(): void {
    this.requestsTotal += 1;
  }

  recordResponse(status: number | string): void {
    const key = String(status);
    this.responsesByStatus.set(key, (this.responsesByStatus.get(key) ?? 0) + 1);
  }

  recordTool(tool: string): void {
    this.toolInvocations.set(tool, (this.toolInvocations.get(tool) ?? 0) + 1);
  }

  recordBackendOutcome(backend: string, outcome: string): void {
    let inner = this.backendOutcomes.get(backend);
    if (!inner) {
      inner = new Map();
      this.backendOutcomes.set(backend, inner);
    }
    inner.set(outcome, (inner.get(outcome) ?? 0) + 1);
  }

  observeBackendDuration(backend: string, durationMs: number): void {
    const current = this.backendDurationMs.get(backend) ?? { sum: 0, count: 0 };
    current.sum += durationMs;
    current.count += 1;
    this.backendDurationMs.set(backend, current);
  }

  recordCache(kind: string, event: 'hit' | 'miss'): void {
    let inner = this.cacheEvents.get(kind);
    if (!inner) {
      inner = new Map();
      this.cacheEvents.set(kind, inner);
    }
    inner.set(event, (inner.get(event) ?? 0) + 1);
  }

  observeSemaphoreWait(pool: string, durationMs: number): void {
    const current = this.semaphoreWaitMs.get(pool) ?? { sum: 0, count: 0 };
    current.sum += durationMs;
    current.count += 1;
    this.semaphoreWaitMs.set(pool, current);
  }

  recordRateLimitRejection(): void {
    this.rateLimitRejections += 1;
  }

  observeDuration(durationMs: number): void {
    this.requestDurationMsSum += durationMs;
    this.requestDurationMsCount += 1;
  }

  snapshot(): MetricsSnapshot {
    const backendOutcomes: Record<string, Record<string, number>> = {};
    for (const [backend, inner] of this.backendOutcomes) backendOutcomes[backend] = Object.fromEntries(inner);
    const backendDurationMs = Object.fromEntries(this.backendDurationMs);
    const cacheEvents: Record<string, Record<string, number>> = {};
    for (const [kind, inner] of this.cacheEvents) cacheEvents[kind] = Object.fromEntries(inner);
    const semaphoreWaitMs = Object.fromEntries(this.semaphoreWaitMs);
    return {
      requestsTotal: this.requestsTotal,
      responsesByStatus: Object.fromEntries(this.responsesByStatus),
      toolInvocations: Object.fromEntries(this.toolInvocations),
      backendOutcomes,
      backendDurationMs,
      cacheEvents,
      semaphoreWaitMs,
      rateLimitRejections: this.rateLimitRejections,
      requestDurationMsSum: this.requestDurationMsSum,
      requestDurationMsCount: this.requestDurationMsCount,
    };
  }

  toOpenMetrics(): string {
    const lines: string[] = [];
    const s = this.snapshot();
    lines.push('# HELP rbs_requests_total Total HTTP requests handled.');
    lines.push('# TYPE rbs_requests_total counter');
    lines.push(`rbs_requests_total ${s.requestsTotal}`);
    lines.push('# HELP rbs_response_total HTTP responses by status code.');
    lines.push('# TYPE rbs_response_total counter');
    for (const [status, count] of Object.entries(s.responsesByStatus)) {
      lines.push(`rbs_response_total{status="${status}"} ${count}`);
    }
    lines.push('# HELP rbs_tool_invocations_total MCP/REST tool invocations.');
    lines.push('# TYPE rbs_tool_invocations_total counter');
    for (const [tool, count] of Object.entries(s.toolInvocations)) {
      lines.push(`rbs_tool_invocations_total{tool="${tool}"} ${count}`);
    }
    lines.push('# HELP rbs_backend_outcomes_total Backend outcome counts.');
    lines.push('# TYPE rbs_backend_outcomes_total counter');
    for (const [backend, outcomes] of Object.entries(s.backendOutcomes)) {
      for (const [outcome, count] of Object.entries(outcomes)) {
        lines.push(`rbs_backend_outcomes_total{backend="${backend}",outcome="${outcome}"} ${count}`);
      }
    }
    lines.push('# HELP rbs_backend_duration_ms Backend execution duration in milliseconds.');
    lines.push('# TYPE rbs_backend_duration_ms summary');
    for (const [backend, duration] of Object.entries(s.backendDurationMs)) {
      lines.push(`rbs_backend_duration_ms_sum{backend="${backend}"} ${duration.sum.toFixed(3)}`);
      lines.push(`rbs_backend_duration_ms_count{backend="${backend}"} ${duration.count}`);
    }
    lines.push('# HELP rbs_cache_events_total Cache hits and misses.');
    lines.push('# TYPE rbs_cache_events_total counter');
    for (const [kind, events] of Object.entries(s.cacheEvents)) {
      for (const [event, count] of Object.entries(events)) {
        lines.push(`rbs_cache_events_total{kind="${kind}",event="${event}"} ${count}`);
      }
    }
    lines.push('# HELP rbs_semaphore_wait_ms Semaphore wait time in milliseconds.');
    lines.push('# TYPE rbs_semaphore_wait_ms summary');
    for (const [pool, duration] of Object.entries(s.semaphoreWaitMs)) {
      lines.push(`rbs_semaphore_wait_ms_sum{pool="${pool}"} ${duration.sum.toFixed(3)}`);
      lines.push(`rbs_semaphore_wait_ms_count{pool="${pool}"} ${duration.count}`);
    }
    lines.push('# HELP rbs_rate_limit_rejections_total Requests rejected by the rate limiter.');
    lines.push('# TYPE rbs_rate_limit_rejections_total counter');
    lines.push(`rbs_rate_limit_rejections_total ${s.rateLimitRejections}`);
    const avg = s.requestDurationMsCount > 0 ? s.requestDurationMsSum / s.requestDurationMsCount : 0;
    lines.push('# HELP rbs_request_duration_ms_avg Average request duration in milliseconds.');
    lines.push('# TYPE rbs_request_duration_ms_avg gauge');
    lines.push(`rbs_request_duration_ms_avg ${avg.toFixed(3)}`);
    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new MetricsCollector();
