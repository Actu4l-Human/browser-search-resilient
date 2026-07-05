export interface MetricsSnapshot {
  requestsTotal: number;
  responsesByStatus: Record<string, number>;
  toolInvocations: Record<string, number>;
  backendOutcomes: Record<string, Record<string, number>>;
  requestDurationMsSum: number;
  requestDurationMsCount: number;
}

class MetricsCollector {
  private requestsTotal = 0;
  private readonly responsesByStatus = new Map<string, number>();
  private readonly toolInvocations = new Map<string, number>();
  private readonly backendOutcomes = new Map<string, Map<string, number>>();
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

  observeDuration(durationMs: number): void {
    this.requestDurationMsSum += durationMs;
    this.requestDurationMsCount += 1;
  }

  snapshot(): MetricsSnapshot {
    const backendOutcomes: Record<string, Record<string, number>> = {};
    for (const [backend, inner] of this.backendOutcomes) {
      backendOutcomes[backend] = Object.fromEntries(inner);
    }
    return {
      requestsTotal: this.requestsTotal,
      responsesByStatus: Object.fromEntries(this.responsesByStatus),
      toolInvocations: Object.fromEntries(this.toolInvocations),
      backendOutcomes,
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
    const avg = s.requestDurationMsCount > 0 ? s.requestDurationMsSum / s.requestDurationMsCount : 0;
    lines.push('# HELP rbs_request_duration_ms_avg Average request duration in milliseconds.');
    lines.push('# TYPE rbs_request_duration_ms_avg gauge');
    lines.push(`rbs_request_duration_ms_avg ${avg.toFixed(3)}`);
    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new MetricsCollector();
