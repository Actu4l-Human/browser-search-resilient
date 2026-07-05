import { shouldEscalate } from './classifier.js';
import { config } from './config.js';
import { fetchCamofox } from './backends/camofox.js';
import { fetchCloakBrowser } from './backends/cloakbrowser.js';
import { fetchDirect } from './backends/direct.js';
import { searchSearxng } from './search/searxng.js';
import type { BackendName, FetchAttempt, FetchOptions, FetchResponse, ResearchResponse, SearchOptions, SearchResponse, SearchResult } from './types.js';
import { Semaphore } from './util/semaphore.js';

const browserSemaphore = new Semaphore(config.browserConcurrency);
const researchSemaphore = new Semaphore(config.researchConcurrency);

function normalizeMaxCharacters(value?: number): number {
  return Math.max(1_000, Math.min(value ?? config.defaultMaxCharacters, config.maxMaxCharacters));
}

async function runBackend(backend: BackendName, url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  if (backend === 'direct') return fetchDirect(url, maxCharacters, includeLinks);
  if (backend === 'camofox') return browserSemaphore.run(() => fetchCamofox(url, maxCharacters, includeLinks));
  return browserSemaphore.run(() => fetchCloakBrowser(url, maxCharacters, includeLinks));
}

export async function webFetch(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
  const maxCharacters = normalizeMaxCharacters(options.maxCharacters);
  const includeLinks = options.includeLinks ?? true;
  const requested = options.backend ?? 'auto';
  const chain: BackendName[] = requested === 'auto'
    ? ['direct', 'camofox', ...(config.cloakEnabled ? ['cloakbrowser' as const] : [])]
    : [requested];
  const attempts: FetchAttempt[] = [];

  for (const backend of chain) {
    const attempt = await runBackend(backend, url, maxCharacters, includeLinks);
    attempts.push(attempt);
    if (attempt.outcome === 'success') return { status: 'success', requestedUrl: url, result: attempt, attempts };
    if (!shouldEscalate(attempt.outcome)) return { status: 'failed', requestedUrl: url, result: attempt, attempts };
  }
  const result = attempts.at(-1) ?? {
    backend: 'direct' as const, outcome: 'network_error' as const, url, elapsedMs: 0, reason: 'No backends available',
  };
  return { status: 'failed', requestedUrl: url, result, attempts };
}

function browserSearchResults(links: Array<{ text: string; url: string }> | undefined, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const link of links ?? []) {
    try {
      const url = new URL(link.url);
      const redirected = url.hostname.endsWith('google.com') && url.pathname === '/url' ? url.searchParams.get('q') : null;
      const target = redirected ? new URL(redirected) : url;
      if (!['http:', 'https:'].includes(target.protocol)) continue;
      if (/google\.|gstatic\.|accounts\.|support\./i.test(target.hostname)) continue;
      const normalized = target.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({ title: link.text || target.hostname, url: normalized, snippet: '', engine: 'browser-fallback' });
      if (results.length >= maxResults) break;
    } catch {
      // Ignore malformed links.
    }
  }
  return results;
}

export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const searx = await searchSearxng(query, options);
  if (searx.status === 'success' && searx.results.length > 0) return searx;
  if (!config.searchBrowserFallback) return searx;

  const maxResults = Math.max(1, Math.min(options.maxResults ?? 10, 50));
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}`;
  const browser = await webFetch(searchUrl, { backend: 'auto', maxCharacters: 20_000, includeLinks: true });
  const results = browserSearchResults(browser.result.links, maxResults);
  return {
    status: results.length ? 'success' : 'failed', query, results,
    attempts: [
      ...searx.attempts,
      ...browser.attempts.map((attempt) => ({
        backend: attempt.backend,
        outcome: attempt.outcome === 'success' ? 'success' as const : 'failed' as const,
        elapsedMs: attempt.elapsedMs,
        reason: attempt.reason,
      })),
    ],
  };
}

export async function webResearch(query: string, options: SearchOptions & { maxSources?: number; maxCharactersPerSource?: number } = {}): Promise<ResearchResponse> {
  const maxSources = Math.max(1, Math.min(options.maxSources ?? 6, 20));
  const search = await webSearch(query, { ...options, maxResults: Math.max(options.maxResults ?? maxSources * 2, maxSources) });
  const selected = search.results.slice(0, maxSources);
  const sources = await Promise.all(selected.map((result) => researchSemaphore.run(() => webFetch(result.url, {
    backend: 'auto',
    maxCharacters: options.maxCharactersPerSource ?? 30_000,
    includeLinks: false,
  }))));
  const successes = sources.filter((source) => source.status === 'success').length;
  return {
    status: successes === sources.length && successes > 0 ? 'success' : successes > 0 ? 'partial' : 'failed',
    query,
    search,
    sources,
  };
}

export async function health(deep = false): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {
    service: 'ok',
    cloakEnabled: config.cloakEnabled,
  };
  const started = Date.now();
  try {
    const response = await fetch(`${config.searxngUrl.replace(/\/$/, '')}/search?q=health&format=json`, { signal: AbortSignal.timeout(3000) });
    checks.searxng = response.ok ? 'ok' : `http_${response.status}`;
  } catch (error) { checks.searxng = `error:${error instanceof Error ? error.message : String(error)}`; }
  try {
    const response = await fetch(`${config.camofoxUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    checks.camofox = response.ok ? 'ok' : `http_${response.status}`;
  } catch (error) { checks.camofox = `error:${error instanceof Error ? error.message : String(error)}`; }
  if (deep && config.cloakEnabled) {
    const result = await webFetch('https://example.com', { backend: 'cloakbrowser', maxCharacters: 2000, includeLinks: false });
    checks.cloakbrowser = result.status === 'success' ? 'ok' : result.result.reason ?? result.result.outcome;
  } else checks.cloakbrowser = config.cloakEnabled ? 'configured' : 'disabled';
  checks.elapsedMs = Date.now() - started;
  return checks;
}
