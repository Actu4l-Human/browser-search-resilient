import { performance } from 'node:perf_hooks';
import { config } from '../config.js';
import { parsePublicUrl } from '../security/url.js';
import type { SearchAttempt, SearchOptions, SearchResult, SearchResponse } from '../types.js';

function allowedByDomain(url: URL, options: SearchOptions): boolean {
  const host = url.hostname.toLowerCase();
  if (options.includeDomains?.length && !options.includeDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
  if (options.excludeDomains?.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
  return true;
}

export async function searchSearxng(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const started = performance.now();
  const attempts: SearchAttempt[] = [];
  try {
    const endpoint = new URL('/search', config.searxngUrl);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('language', options.language ?? 'en');
    if (options.categories?.length) endpoint.searchParams.set('categories', options.categories.join(','));
    if (options.timeRange) endpoint.searchParams.set('time_range', options.timeRange);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.directTimeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const payload = (await response.json()) as { results?: Array<Record<string, unknown>> };
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 10, 50));
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const item of payload.results ?? []) {
      if (results.length >= maxResults) break;
      const rawUrl = typeof item.url === 'string' ? item.url : '';
      try {
        const url = parsePublicUrl(rawUrl);
        if (!allowedByDomain(url, options) || seen.has(url.toString())) continue;
        seen.add(url.toString());
        results.push({
          title: typeof item.title === 'string' ? item.title : url.hostname,
          url: url.toString(),
          snippet: typeof item.content === 'string' ? item.content : '',
          ...(typeof item.engine === 'string' ? { engine: item.engine } : {}),
          ...(typeof item.publishedDate === 'string' ? { publishedDate: item.publishedDate } : {}),
          ...(typeof item.score === 'number' ? { score: item.score } : {}),
        });
      } catch {
        // Ignore malformed, local, or otherwise unsafe result URLs.
      }
    }
    attempts.push({ backend: 'searxng', outcome: 'success', elapsedMs: Math.round(performance.now() - started) });
    return { status: 'success', query, results, attempts };
  } catch (error) {
    attempts.push({
      backend: 'searxng', outcome: 'failed', elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
    });
    return { status: 'failed', query, results: [], attempts };
  }
}
