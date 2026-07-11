import { performance } from 'node:perf_hooks';
import { shouldEscalate } from './classifier.js';
import { config, warnOnInsecureDefaults } from './config.js';
import { fetchCamofox } from './backends/camofox.js';
import { fetchCrawl4ai } from './backends/crawl4ai.js';
import { fetchCloakBrowser } from './backends/cloakbrowser.js';
import { fetchDirect } from './backends/direct.js';
import { allowedByDomain, searchSearxng } from './search/searxng.js';
import { parsePublicUrl } from './security/url.js';
import type {
  BackendName,
  FetchAttempt,
  FetchOptions,
  FetchResponse,
  ResearchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from './types.js';
import { Semaphore } from './util/semaphore.js';
import { TtlCache } from './util/cache.js';
import { inFlight } from './util/registry.js';
import { log, metrics } from './util/index.js';

warnOnInsecureDefaults();

const browserSemaphore = new Semaphore(config.browserConcurrency);
const healthSemaphore = new Semaphore(1);
const researchSemaphore = new Semaphore(config.researchConcurrency);

const fetchCache = config.cacheEnabled ? new TtlCache<string, FetchResponse>(config.cacheTtlMs, config.cacheMaxEntries) : undefined;
const searchCache = config.cacheEnabled ? new TtlCache<string, SearchResponse>(config.cacheTtlMs, config.cacheMaxEntries) : undefined;

export { inFlight };

function normalizeMaxCharacters(value?: number): number {
  return Math.max(1_000, Math.min(value ?? config.defaultMaxCharacters, config.maxMaxCharacters));
}

async function runBackend(
  backend: BackendName,
  url: string,
  maxCharacters: number,
  includeLinks: boolean,
  reserve: 'browser' | 'health' = 'browser',
  query?: string,
): Promise<FetchAttempt> {
  const started = performance.now();
  try {
    if (backend === 'direct') return await fetchDirect(url, maxCharacters, includeLinks);
    const semaphore = reserve === 'health' ? healthSemaphore : browserSemaphore;
    const operation =
      backend === 'crawl4ai'
        ? () => fetchCrawl4ai(url, maxCharacters, includeLinks, query)
        : backend === 'camofox'
          ? () => fetchCamofox(url, maxCharacters, includeLinks)
          : () => fetchCloakBrowser(url, maxCharacters, includeLinks);
    return await semaphore.run(operation, (waitMs) => metrics.observeSemaphoreWait(reserve, waitMs));
  } finally {
    metrics.observeBackendDuration(backend, performance.now() - started);
  }
}

function fetchCacheKey(url: string, maxCharacters: number, includeLinks: boolean, requested: string, options: FetchOptions): string {
  return JSON.stringify({
    url,
    maxCharacters,
    includeLinks,
    backend: requested,
    query: options.query ?? '',
    preferCrawl4ai: options.preferCrawl4ai ?? false,
  });
}

function autoBackendChain(): BackendName[] {
  return ['direct', ...(config.crawl4aiEnabled ? ['crawl4ai' as const] : []), 'camofox', ...(config.cloakEnabled ? ['cloakbrowser' as const] : [])];
}

async function webFetchImpl(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
  const maxCharacters = normalizeMaxCharacters(options.maxCharacters);
  const includeLinks = options.includeLinks ?? true;
  const requested = options.backend ?? 'auto';
  const cacheKey = fetchCacheKey(url, maxCharacters, includeLinks, requested, options);

  if (fetchCache) {
    const cached = fetchCache.get(cacheKey);
    metrics.recordCache('fetch', cached ? 'hit' : 'miss');
    if (cached) return cached;
  }

  const chain: BackendName[] = requested === 'auto' ? autoBackendChain() : [requested];
  const attempts: FetchAttempt[] = [];
  let directSuccess: FetchAttempt | undefined;

  for (const backend of chain) {
    const attempt = await runBackend(backend, url, maxCharacters, includeLinks, 'browser', options.query);
    attempts.push(attempt);
    metrics.recordBackendOutcome(backend, attempt.outcome);
    if (attempt.outcome === 'success') {
      if (backend === 'direct' && requested === 'auto' && config.crawl4aiEnabled && options.preferCrawl4ai) {
        directSuccess = attempt;
        continue;
      }
      const response: FetchResponse = { status: 'success', requestedUrl: url, result: attempt, attempts };
      fetchCache?.set(cacheKey, response);
      return response;
    }
    if (!shouldEscalate(attempt.outcome)) {
      if (directSuccess) {
        const response: FetchResponse = { status: 'success', requestedUrl: url, result: directSuccess, attempts };
        fetchCache?.set(cacheKey, response);
        return response;
      }
      return { status: 'failed', requestedUrl: url, result: attempt, attempts };
    }
  }

  if (directSuccess) {
    const response: FetchResponse = { status: 'success', requestedUrl: url, result: directSuccess, attempts };
    fetchCache?.set(cacheKey, response);
    return response;
  }

  const result = attempts.at(-1) ?? {
    backend: 'direct' as const,
    outcome: 'network_error' as const,
    url,
    elapsedMs: 0,
    reason: 'No backends available',
  };
  return { status: 'failed', requestedUrl: url, result, attempts };
}

export function webFetch(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
  return inFlight.register(webFetchImpl(url, options));
}

export function browserSearchResults(
  links: Array<{ text: string; url: string }> | undefined,
  maxResults: number,
  options: SearchOptions,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const link of links ?? []) {
    try {
      const url = new URL(link.url);
      const isGoogleHost = url.hostname === 'google.com' || url.hostname.endsWith('.google.com');
      const redirected = isGoogleHost && url.pathname === '/url' ? url.searchParams.get('q') : null;
      const target = redirected ? new URL(redirected) : url;
      if (!['http:', 'https:'].includes(target.protocol)) continue;
      if (/google\.|gstatic\.|accounts\.|support\./i.test(target.hostname)) continue;
      const safeTarget = parsePublicUrl(target.toString());
      if (!allowedByDomain(safeTarget, options)) continue;
      const normalized = safeTarget.toString();
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

function validDomain(value: string): string | undefined {
  const candidate = value.trim().toLowerCase().replace(/^\.+/, '');
  if (!candidate || candidate.length > 253 || !/^[a-z0-9.-]+$/.test(candidate)) return undefined;
  try {
    return new URL(`http://${candidate}`).hostname;
  } catch {
    return undefined;
  }
}

export function googleSearchUrl(query: string, maxResults: number, options: SearchOptions): string {
  const includeDomains = (options.includeDomains ?? []).map(validDomain).filter((domain): domain is string => Boolean(domain));
  const excludeDomains = (options.excludeDomains ?? []).map(validDomain).filter((domain): domain is string => Boolean(domain));
  const includeConstraint = includeDomains.length
    ? includeDomains.length === 1
      ? `site:${includeDomains[0]}`
      : `(${includeDomains.map((domain) => `site:${domain}`).join(' OR ')})`
    : '';
  const excludeConstraint = excludeDomains.map((domain) => `-site:${domain}`).join(' ');
  const constrainedQuery = [query, includeConstraint, excludeConstraint].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: constrainedQuery, num: String(maxResults) });
  if (options.language) {
    params.set('hl', options.language);
    params.set('lr', `lang_${options.language}`);
  }
  if (options.timeRange) {
    const qdr = options.timeRange === 'day' ? 'd' : options.timeRange === 'week' ? 'w' : options.timeRange === 'month' ? 'm' : 'y';
    params.set('tbs', `qdr:${qdr}`);
  }
  const categories = new Set(options.categories?.map((category) => category.trim().toLowerCase()));
  if (categories.has('images')) params.set('tbm', 'isch');
  else if (categories.has('videos')) params.set('tbm', 'vid');
  else if (categories.has('news')) params.set('tbm', 'nws');
  return `https://www.google.com/search?${params.toString()}`;
}

async function webSearchImpl(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const cacheKey = JSON.stringify({ query, ...options });
  if (searchCache) {
    const cached = searchCache.get(cacheKey);
    metrics.recordCache('search', cached ? 'hit' : 'miss');
    if (cached) return cached;
  }

  const searx = await searchSearxng(query, options);
  for (const attempt of searx.attempts) metrics.recordBackendOutcome(attempt.backend, attempt.outcome);
  if (searx.status === 'success' && searx.results.length > 0) {
    searchCache?.set(cacheKey, searx);
    return searx;
  }
  if (!config.searchBrowserFallback) return searx;

  const maxResults = Math.max(1, Math.min(options.maxResults ?? 10, 50));
  const searchUrl = googleSearchUrl(query, maxResults, options);
  const browser = await webFetch(searchUrl, { backend: 'auto', maxCharacters: 20_000, includeLinks: true });
  const results = browserSearchResults(browser.result.links, maxResults, options);
  const response: SearchResponse = {
    status: results.length ? 'success' : 'failed',
    query,
    results,
    attempts: [
      ...searx.attempts,
      ...browser.attempts.map((attempt) => ({
        backend: attempt.backend,
        outcome: attempt.outcome === 'success' ? ('success' as const) : ('failed' as const),
        elapsedMs: attempt.elapsedMs,
        ...(attempt.reason ? { reason: attempt.reason } : {}),
      })),
    ],
  };
  if (response.status === 'success') searchCache?.set(cacheKey, response);
  return response;
}

export function webSearch(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  return inFlight.register(webSearchImpl(query, options));
}

async function webResearchImpl(
  query: string,
  options: SearchOptions & { maxSources?: number; maxCharactersPerSource?: number } = {},
): Promise<ResearchResponse> {
  const maxSources = Math.max(1, Math.min(options.maxSources ?? 6, 20));
  const search = await webSearch(query, { ...options, maxResults: Math.max(options.maxResults ?? maxSources * 2, maxSources) });
  const selected = search.results.slice(0, maxSources);
  const sources = await Promise.all(
    selected.map((result) =>
      researchSemaphore.run(
        () =>
          webFetch(result.url, {
            backend: 'auto',
            maxCharacters: options.maxCharactersPerSource ?? 30_000,
            includeLinks: false,
            query,
            preferCrawl4ai: true,
          }),
        (waitMs) => metrics.observeSemaphoreWait('research', waitMs),
      ),
    ),
  );
  const successes = sources.filter((source) => source.status === 'success').length;
  return {
    status: successes === sources.length && successes > 0 ? 'success' : successes > 0 ? 'partial' : 'failed',
    query,
    search,
    sources,
  };
}

export function webResearch(
  query: string,
  options: SearchOptions & { maxSources?: number; maxCharactersPerSource?: number } = {},
): Promise<ResearchResponse> {
  return inFlight.register(webResearchImpl(query, options));
}

async function serviceCheck(url: string, headers?: Record<string, string>): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), ...(headers ? { headers } : {}) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? 'ok' : `http_${response.status}`;
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function health(deep = false): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {
    service: 'ok',
    crawl4aiEnabled: config.crawl4aiEnabled,
    cloakEnabled: config.cloakEnabled,
  };
  const started = Date.now();
  const searxUrl = `${config.searxngUrl.replace(/\/$/, '')}/`;
  const camofoxUrl = `${config.camofoxUrl.replace(/\/$/, '')}/health`;
  const egressUrl = `${config.egressProxyUrl.replace(/\/$/, '')}/healthz`;
  const crawl4aiUrl = `${config.crawl4aiUrl.replace(/\/$/, '')}/healthz`;
  const [searxng, camofox, egressProxy, crawl4ai] = await Promise.all([
    serviceCheck(searxUrl, { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' }),
    serviceCheck(camofoxUrl),
    serviceCheck(egressUrl),
    config.crawl4aiEnabled ? serviceCheck(crawl4aiUrl) : Promise.resolve('disabled'),
  ]);
  checks.searxng = searxng;
  checks.camofox = camofox;
  checks.egressProxy = egressProxy;
  checks.crawl4ai = crawl4ai;

  if (deep && config.crawl4aiEnabled) {
    const result = await runBackend('crawl4ai', 'https://example.com', 2000, false, 'health');
    checks.crawl4ai = result.outcome === 'success' ? 'ok' : (result.reason ?? result.outcome);
  }

  if (deep && config.cloakEnabled) {
    const result = await runBackend('cloakbrowser', 'https://example.com', 2000, false, 'health');
    checks.cloakbrowser = result.outcome === 'success' ? 'ok' : (result.reason ?? result.outcome);
  } else checks.cloakbrowser = config.cloakEnabled ? 'configured' : 'disabled';
  checks.elapsedMs = Date.now() - started;
  return checks;
}

export { log };
