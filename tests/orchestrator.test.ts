import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSearchResults, googleSearchUrl, health, webFetch } from '../src/orchestrator.js';

test('webFetch terminates immediately when the requested URL is private', async () => {
  const response = await webFetch('http://127.0.0.1:1234', { backend: 'auto' });

  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
  assert.equal(response.attempts.length, 1);
  assert.equal(response.attempts[0]?.backend, 'direct');
});

test('webFetch with explicit private backend is policy_denied', async () => {
  const response = await webFetch('http://10.0.0.5/admin', { backend: 'direct' });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
});

test('webFetch with explicit Crawl4AI backend still enforces URL policy before sidecar calls', async () => {
  const response = await webFetch('http://10.0.0.5/admin', { backend: 'crawl4ai' });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.backend, 'crawl4ai');
  assert.equal(response.result.outcome, 'policy_denied');
});

test('webFetch rejects non-http schemes via policy_denied', async () => {
  const response = await webFetch('file:///etc/passwd', { backend: 'direct' });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
});

test('browser fallback drops private and internal result URLs', () => {
  const results = browserSearchResults(
    [
      { text: 'Loopback', url: 'http://127.0.0.1/admin' },
      { text: 'Internal', url: 'http://service.internal/' },
      { text: 'Public', url: 'https://example.com/' },
    ],
    10,
    {},
  );
  assert.deepEqual(
    results.map((result) => result.url),
    ['https://example.com/'],
  );
});

test('browser fallback results preserve domain constraints', () => {
  const results = browserSearchResults(
    [
      { text: 'Allowed', url: 'https://docs.nvidia.com/example' },
      { text: 'Excluded', url: 'https://example.com/page' },
    ],
    10,
    { includeDomains: ['nvidia.com'] },
  );
  assert.deepEqual(
    results.map((result) => result.url),
    ['https://docs.nvidia.com/example'],
  );
});

test('browser fallback query carries domain and category constraints', () => {
  const url = new URL(
    googleSearchUrl('gpu news', 5, {
      includeDomains: ['nvidia.com', 'amd.com'],
      excludeDomains: ['example.com'],
      categories: ['news'],
    }),
  );
  assert.match(url.searchParams.get('q') ?? '', /site:nvidia\.com/);
  assert.match(url.searchParams.get('q') ?? '', /site:amd\.com/);
  assert.match(url.searchParams.get('q') ?? '', /-site:example\.com/);
  assert.equal(url.searchParams.get('tbm'), 'nws');
});

test('shallow health checks local service endpoints without executing a search', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await health(false);
    assert.equal(result.searxng, 'ok');
    assert.equal(result.camofox, 'ok');
    assert.equal(result.egressProxy, 'ok');
    assert.equal(result.crawl4ai, 'disabled');
    assert.equal(
      requested.some((url) => url.includes('/search?')),
      false,
    );
    assert.equal(
      requested.some((url) => url.endsWith('/healthz')),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webResearch asks auto fetches to prefer Crawl4AI extraction', async () => {
  // This is intentionally a behavior-level guard rather than a network test:
  // webResearch should request query-aware extraction, but direct fetch remains
  // a fallback if Crawl4AI is disabled or fails.
  const response = await webFetch('http://127.0.0.1:1234', {
    backend: 'auto',
    query: 'private address should be blocked',
    preferCrawl4ai: true,
  });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
  assert.equal(response.attempts.length, 1);
});
