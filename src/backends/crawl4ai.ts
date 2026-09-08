import { performance } from 'node:perf_hooks';
import { classify } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt } from '../types.js';
import { dedupeLinks, normalizeWhitespace, truncate } from '../util/text.js';
import type { LinkCandidate } from '../util/text.js';

interface Crawl4aiPayload {
  success?: boolean;
  url?: unknown;
  final_url?: unknown;
  title?: unknown;
  content?: unknown;
  markdown?: unknown;
  content_type?: unknown;
  links?: unknown;
  status_code?: unknown;
  error?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toLinkCandidate(value: unknown): LinkCandidate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const href = stringValue(record.url ?? record.href);
  if (!href) return undefined;
  return { href, text: stringValue(record.text ?? record.title) };
}

// Walk Crawl4AI's nested links payload into a flat candidate list, then rely on
// the shared dedupeLinks helper for http(s) validation and de-duplication.
function flattenLinks(value: unknown): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  const visit = (candidate: unknown): void => {
    if (candidates.length >= 200) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const link = toLinkCandidate(candidate);
    if (link) candidates.push(link);
    else if (candidate && typeof candidate === 'object') {
      for (const nested of Object.values(candidate as Record<string, unknown>)) visit(nested);
    }
  };
  visit(value);
  return candidates;
}
function chooseContent(payload: Crawl4aiPayload): string {
  const content = stringValue(payload.content);
  if (content) return content;
  return stringValue(payload.markdown);
}

async function callCrawl4ai(url: string, maxCharacters: number, includeLinks: boolean, query?: string): Promise<Crawl4aiPayload> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.crawl4aiToken) headers.Authorization = `Bearer ${config.crawl4aiToken}`;
  const signal = AbortSignal.timeout(config.crawl4aiTimeoutMs);

  try {
    const response = await fetch(`${config.crawl4aiUrl.replace(/\/$/, '')}/extract`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        url,
        max_characters: maxCharacters,
        include_links: includeLinks,
        ...(query ? { query } : {}),
      }),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const detail = payload && typeof payload === 'object' ? stringValue((payload as Record<string, unknown>).detail) : '';
      throw new Error(`Crawl4AI sidecar failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return payload && typeof payload === 'object' ? (payload as Crawl4aiPayload) : {};
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const timeoutError = new Error(`Crawl4AI extraction timed out after ${config.crawl4aiTimeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  }
}

function timeoutMetadata(error: unknown): { timedOut?: true; cleanupUnconfirmed?: true } {
  if (error instanceof Error && error.name === 'TimeoutError') return { timedOut: true, cleanupUnconfirmed: true };
  return {};
}

export async function fetchCrawl4ai(url: string, maxCharacters: number, includeLinks: boolean, query?: string): Promise<FetchAttempt> {
  const started = performance.now();
  let timedOut = false;
  let cleanupUnconfirmed = false;
  try {
    // The orchestrator still owns URL admission. The private sidecar is configured separately in Compose, and browser redirects/subresources remain subject to the surrounding deployment policy.
    await resolvePublicUrl(url);
    if (!config.crawl4aiEnabled) throw new Error('Crawl4AI backend is disabled');

    const payload = await callCrawl4ai(url, maxCharacters, includeLinks, query);
    const finalUrl = stringValue(payload.final_url) || stringValue(payload.url) || url;
    await resolvePublicUrl(finalUrl);

    if (payload.success === false) {
      return {
        backend: 'crawl4ai',
        outcome: 'network_error',
        url,
        finalUrl,
        elapsedMs: Math.round(performance.now() - started),
        reason: stringValue(payload.error) || 'Crawl4AI extraction failed',
        ...(timedOut ? { timedOut: true } : {}),
        ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    }
    const limited = truncate(normalizeWhitespace(chooseContent(payload)), maxCharacters);
    const status = numberValue(payload.status_code);
    const title = stringValue(payload.title);
    const contentType = stringValue(payload.content_type) || 'text/html';
    const classification = classify({
      ...(status !== undefined ? { status } : {}),
      title,
      content: limited.value,
      contentType,
      finalUrl,
      rendered: true,
    });

    return {
      backend: 'crawl4ai',
      outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url,
      finalUrl,
      title,
      content: limited.value,
      ...(includeLinks ? { links: dedupeLinks(flattenLinks(payload.links)) } : {}),
      ...(status !== undefined ? { httpStatus: status } : {}),
      contentType,
      elapsedMs: Math.round(performance.now() - started),
      truncated: limited.truncated,
      ...(timedOut ? { timedOut: true } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
    };
  } catch (error) {
    const metadata = timeoutMetadata(error);
    timedOut = timedOut || Boolean(metadata.timedOut);
    cleanupUnconfirmed = cleanupUnconfirmed || Boolean(metadata.cleanupUnconfirmed);
    if (isSecurityPolicyError(error)) {
      return {
        backend: 'crawl4ai',
        outcome: 'policy_denied',
        url,
        elapsedMs: Math.round(performance.now() - started),
        reason: error instanceof Error ? error.message : String(error),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    }
    return {
      backend: 'crawl4ai',
      outcome: 'network_error',
      url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
      ...(timedOut ? { timedOut: true } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
    };
  }
}
