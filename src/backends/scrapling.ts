import { performance } from 'node:perf_hooks';
import { classify } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt } from '../types.js';
import { dedupeLinks, normalizeWhitespace, truncate } from '../util/text.js';
import type { LinkCandidate } from '../util/text.js';

interface ScraplingPayload {
  success?: boolean;
  url?: unknown;
  final_url?: unknown;
  title?: unknown;
  content?: unknown;
  links?: unknown;
  status_code?: unknown;
  content_type?: unknown;
  error?: unknown;
  timed_out?: unknown;
  cleanup_unconfirmed?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function responseFlags(payload: ScraplingPayload | undefined, status?: number): { timedOut?: boolean; cleanupUnconfirmed?: boolean } {
  return {
    ...(boolValue(payload?.timed_out) === true ? { timedOut: true } : {}),
    ...(boolValue(payload?.cleanup_unconfirmed) === true ? { cleanupUnconfirmed: true } : {}),
    ...((status === 408 || status === 504) && boolValue(payload?.timed_out) !== false ? { timedOut: true } : {}),
  };
}

function toLinkCandidate(value: unknown): LinkCandidate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const href = stringValue(record.url ?? record.href);
  if (!href) return undefined;
  return { href, text: stringValue(record.text ?? record.title) };
}

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

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function statusReason(status: number): string {
  return `HTTP ${status}`;
}

function responseReason(payload: ScraplingPayload | undefined, status?: number): string {
  const detail = stringValue(payload?.error);
  if (detail) return detail;
  if (typeof status === 'number') return statusReason(status);
  return 'Scrapling extraction failed';
}

export async function fetchScrapling(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  let timedOut = false;
  let cleanupUnconfirmed = false;
  try {
    await resolvePublicUrl(url);
    const signalTimeoutMs = config.browserTimeoutMs + config.browserSettleMs + 5000;
    const signal = AbortSignal.timeout(signalTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${config.scraplingUrl.replace(/\/$/, '')}/extract`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.scraplingToken}`,
        },
        body: JSON.stringify({
          url,
          max_characters: maxCharacters,
          include_links: includeLinks,
        }),
      });
    } catch (error) {
      timedOut = signal.aborted || isTimeoutLike(error);
      cleanupUnconfirmed = timedOut;
      throw error;
    }

    let payload: ScraplingPayload | undefined;
    try {
      payload = (await response.json()) as ScraplingPayload;
    } catch (error) {
      timedOut = timedOut || signal.aborted || isTimeoutLike(error);
      cleanupUnconfirmed = cleanupUnconfirmed || timedOut;
      throw error;
    }

    if (!response.ok) {
      const flags = responseFlags(payload, response.status);
      timedOut = timedOut || Boolean(flags.timedOut);
      cleanupUnconfirmed = cleanupUnconfirmed || Boolean(flags.cleanupUnconfirmed);
      if (response.status === 401 || response.status === 403 || response.status === 407 || response.status === 451) {
        return {
          backend: 'scrapling',
          outcome: 'policy_denied',
          url,
          elapsedMs: Math.round(performance.now() - started),
          reason: responseReason(payload, response.status),
          ...(timedOut ? { timedOut: true } : {}),
          ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
        };
      }
      return {
        backend: 'scrapling',
        outcome: 'network_error',
        url,
        elapsedMs: Math.round(performance.now() - started),
        reason: responseReason(payload, response.status),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    }

    if (payload?.success === false) {
      const flags = responseFlags(payload, response.status);
      timedOut = timedOut || Boolean(flags.timedOut);
      cleanupUnconfirmed = cleanupUnconfirmed || Boolean(flags.cleanupUnconfirmed);
      const finalUrl = stringValue(payload.final_url) || stringValue(payload.url) || url;
      try {
        await resolvePublicUrl(finalUrl);
      } catch (error) {
        if (isSecurityPolicyError(error)) {
          return {
            backend: 'scrapling',
            outcome: 'policy_denied',
            url,
            finalUrl,
            elapsedMs: Math.round(performance.now() - started),
            reason: error instanceof Error ? error.message : String(error),
            ...(timedOut ? { timedOut: true } : {}),
            ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
          };
        }
        throw error;
      }
      return {
        backend: 'scrapling',
        outcome: 'network_error',
        url,
        finalUrl,
        elapsedMs: Math.round(performance.now() - started),
        reason: responseReason(payload, response.status),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    }

    const finalUrl = stringValue(payload?.final_url) || stringValue(payload?.url) || url;
    await resolvePublicUrl(finalUrl);

    const content = normalizeWhitespace(stringValue(payload?.content));
    const limited = truncate(content, maxCharacters);
    const status = numberValue(payload?.status_code);
    const title = stringValue(payload?.title);
    const contentType = stringValue(payload?.content_type);
    const flags = responseFlags(payload, response.status);
    timedOut = timedOut || Boolean(flags.timedOut);
    cleanupUnconfirmed = cleanupUnconfirmed || Boolean(flags.cleanupUnconfirmed);
    const classification = classify({
      ...(status !== undefined ? { status } : {}),
      title,
      content: limited.value,
      ...(contentType ? { contentType } : {}),
      finalUrl,
      rendered: true,
    });

    return {
      backend: 'scrapling',
      outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url,
      finalUrl,
      title,
      content: limited.value,
      ...(includeLinks ? { links: dedupeLinks(flattenLinks(payload?.links)) } : {}),
      ...(status !== undefined ? { httpStatus: status } : {}),
      ...(contentType ? { contentType } : {}),
      elapsedMs: Math.round(performance.now() - started),
      truncated: limited.truncated,
      ...(timedOut ? { timedOut: true } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
    };
  } catch (error) {
    timedOut = timedOut || isTimeoutLike(error);
    cleanupUnconfirmed = cleanupUnconfirmed || timedOut;
    if (isSecurityPolicyError(error)) {
      return {
        backend: 'scrapling',
        outcome: 'policy_denied',
        url,
        elapsedMs: Math.round(performance.now() - started),
        reason: error instanceof Error ? error.message : String(error),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    }
    return {
      backend: 'scrapling',
      outcome: 'network_error',
      url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
      ...(timedOut ? { timedOut: true } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
    };
  }
}
