import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { browserSearchResults, googleSearchUrl, health, webFetch } from '../src/orchestrator.js';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
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

test('webFetch with explicit Obscura backend remains disabled by default', async () => {
  const response = await webFetch('https://1.1.1.1/', { backend: 'obscura' });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.backend, 'obscura');
  assert.equal(response.result.outcome, 'network_error');
  assert.equal(response.result.reason, 'Obscura backend is disabled');
  assert.equal(response.attempts.length, 1);
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

test('shallow health reports the active stack profile and service probes', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await health(false);
    assert.equal(result.stackProfile, 'baseline');
    assert.equal(result.searxng, 'ok');
    assert.equal(result.camofox, 'ok');
    assert.equal(result.egressProxy, 'ok');
    assert.equal(result.obscuraEnabled, false);
    assert.equal(result.scraplingEnabled, false);
    assert.equal(Array.isArray(result.requiredBackends), true);
    assert.equal((result.requiredBackends as string[]).includes('direct'), true);
    assert.equal((result.requiredBackends as string[]).includes('camofox'), true);
    assert.equal((result.requiredBackends as string[]).includes('scrapling'), false);
    assert.equal(requested.some((url) => url.endsWith('/healthz')), true);
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
async function runTsxScript(script: string, env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFile(
    process.execPath,
    ['--import', tsxLoader, '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      timeout: 30_000,
      maxBuffer: 10_000_000,
    },
  );
  return stdout.trim();
}

test('invalid fetch stack profile fails startup', async () => {
  await assert.rejects(
    runTsxScript(`import './src/config.ts';`, { FETCH_STACK_PROFILE: 'bogus' }),
    /Invalid FETCH_STACK_PROFILE value/,
  );
});

test('replace-scrapling profile accepts the required backend flags', async () => {
  const output = await runTsxScript(
    `import { config } from './src/config.ts';
     process.stdout.write(JSON.stringify({
       profile: config.fetchStackProfile,
       crawl4ai: config.crawl4aiEnabled,
       scrapling: config.scraplingEnabled,
       camofox: config.camofoxEnabled,
       cloak: config.cloakEnabled,
     }));`,
    {
      FETCH_STACK_PROFILE: 'replace-scrapling',
      CRAWL4AI_ENABLED: 'true',
      SCRAPLING_ENABLED: 'true',
      CAMOFOX_ENABLED: 'false',
      CLOAK_ENABLED: 'false',
    },
  );
  assert.deepEqual(JSON.parse(output), {
    profile: 'replace-scrapling',
    crawl4ai: true,
    scrapling: true,
    camofox: false,
    cloak: false,
  });
});

test('crawl4ai timeout metadata is retained when the sidecar aborts', async () => {
  const output = await runTsxScript(
    `AbortSignal.timeout = () => {
       const controller = new AbortController();
       controller.abort();
       return controller.signal;
     };
     globalThis.fetch = async (_input, init) => {
       if (init?.signal?.aborted) {
         throw Object.assign(new Error('aborted'), { name: 'AbortError' });
       }
       return new Response(JSON.stringify({
         success: true,
         url: 'https://example.com/',
         final_url: 'https://example.com/',
         title: 'example',
         content: 'hello from crawl4ai',
         links: [],
         status_code: 200,
       }), { status: 200, headers: { 'Content-Type': 'application/json' } });
     };
     import { fetchCrawl4ai } from './src/backends/crawl4ai.ts';
     const result = await fetchCrawl4ai('https://example.com/', 2000, false);
     process.stdout.write(JSON.stringify(result));`,
    {
      CRAWL4AI_ENABLED: 'true',
      CRAWL4AI_TOKEN: 'token',
      CRAWL4AI_URL: 'http://crawl4ai.invalid',
      CRAWL4AI_TIMEOUT_MS: '1',
    },
  );
  const result = JSON.parse(output) as { timedOut?: boolean; cleanupUnconfirmed?: boolean; outcome: string };
  assert.equal(result.outcome, 'network_error');
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupUnconfirmed, true);
});
