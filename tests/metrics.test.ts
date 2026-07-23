import assert from 'node:assert/strict';
import test from 'node:test';

import { metrics } from '../src/util/metrics.js';

test('metrics collector records counters and emits OpenMetrics text', () => {
  const backend = '__metrics_test_backend__';
  const outcome = '__metrics_test_outcome__';
  const tool = '__metrics_test_tool__';
  const cacheKind = '__metrics_test_cache__';
  const pool = '__metrics_test_pool__';

  const before = metrics.snapshot();

  metrics.recordRequest();
  metrics.recordRequest();
  metrics.recordResponse(200);
  metrics.recordResponse('429');
  metrics.recordTool(tool);
  metrics.recordBackendOutcome(backend, outcome);
  metrics.observeBackendDuration(backend, 12.5);
  metrics.recordCache(cacheKind, 'hit');
  metrics.recordCache(cacheKind, 'miss');
  metrics.observeSemaphoreWait(pool, 6.25);
  metrics.recordRateLimitRejection();
  metrics.observeDuration(10);
  metrics.observeDuration(20);

  const after = metrics.snapshot();

  assert.equal(after.requestsTotal, before.requestsTotal + 2);
  assert.equal((after.responsesByStatus['200'] ?? 0) - (before.responsesByStatus['200'] ?? 0), 1);
  assert.equal((after.responsesByStatus['429'] ?? 0) - (before.responsesByStatus['429'] ?? 0), 1);
  assert.equal((after.toolInvocations[tool] ?? 0) - (before.toolInvocations[tool] ?? 0), 1);
  assert.equal(
    (after.backendOutcomes[backend]?.[outcome] ?? 0) - (before.backendOutcomes[backend]?.[outcome] ?? 0),
    1,
  );
  assert.equal(after.rateLimitRejections, before.rateLimitRejections + 1);
  assert.equal(after.requestDurationMsCount, before.requestDurationMsCount + 2);
  assert.equal(after.requestDurationMsSum, before.requestDurationMsSum + 30);

  const openMetrics = metrics.toOpenMetrics();
  assert.match(openMetrics, /# HELP rbs_requests_total/);
  assert.match(openMetrics, new RegExp(`rbs_tool_invocations_total\\{tool=\\"${tool}\\"\\}`));
  assert.match(openMetrics, new RegExp(`rbs_backend_outcomes_total\\{backend=\\"${backend}\\",outcome=\\"${outcome}\\"\\}`));
  assert.match(openMetrics, new RegExp(`rbs_cache_events_total\\{kind=\\"${cacheKind}\\",event=\\"hit\\"\\}`));
  assert.match(openMetrics, new RegExp(`rbs_semaphore_wait_ms_count\\{pool=\\"${pool}\\"\\}`));
  assert.match(openMetrics, /rbs_request_duration_ms_avg \d+\.\d{3}/);
});
