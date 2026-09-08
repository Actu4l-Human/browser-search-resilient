import { performance } from 'node:perf_hooks';
import { classify } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt, LinkResult } from '../types.js';
import { normalizeWhitespace, truncate } from '../util/text.js';

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(`Camofox request timed out after ${config.browserTimeoutMs}ms`)), config.browserTimeoutMs);
  try {
    return await fetch(`${config.camofoxUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new TimeoutError(`Camofox request timed out after ${config.browserTimeoutMs}ms`);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(`Camofox request timed out after ${config.browserTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractSnapshotText(payload: unknown): string {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(payload);
  return normalizeWhitespace(values.join('\n'));
}

function parseEvaluateResult(payload: unknown): { title: string; url: string; text: string; links: LinkResult[] } | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  let value: unknown = record.result ?? record.value ?? record.data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  return {
    title: typeof result.title === 'string' ? result.title : '',
    url: typeof result.url === 'string' ? result.url : '',
    text: typeof result.text === 'string' ? result.text : '',
    links: Array.isArray(result.links)
      ? result.links
          .filter((link): link is { text?: unknown; url?: unknown } => Boolean(link && typeof link === 'object'))
          .map((link) => ({ text: typeof link.text === 'string' ? link.text : '', url: typeof link.url === 'string' ? link.url : '' }))
          .filter((link) => /^https?:/i.test(link.url))
          .slice(0, 200)
      : [],
  };
}

async function waitForReady(tabId: string): Promise<boolean> {
  const expression = 'document.readyState';
  const deadline = Date.now() + Math.min(config.browserTimeoutMs, 15_000);
  while (Date.now() < deadline) {
    try {
      const evaluated = await call(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.camofoxApiKey}` },
        body: JSON.stringify({ userId: config.camofoxUserId, expression }),
      });
      if (evaluated.ok) {
        const payload = (await evaluated.json()) as Record<string, unknown>;
        const ready = String(payload.result ?? payload.value ?? payload.data ?? '').toLowerCase();
        if (ready === 'complete') return false;
      }
    } catch (error) {
      if (error instanceof TimeoutError) return true;
      // ignore transient evaluate errors during load
    }
    await sleep(500);
  }
  return true;
}

export async function fetchCamofox(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  let tabId = '';
  let timedOut = false;
  let cleanupUnconfirmed = false;
  let result: FetchAttempt | undefined;
  try {
    await resolvePublicUrl(url);
    const create = await call('/tabs', {
      method: 'POST',
      body: JSON.stringify({
        userId: config.camofoxUserId,
        sessionKey: config.camofoxSessionKey,
        url,
      }),
    });
    if (!create.ok) throw new Error(`Camofox create tab failed: HTTP ${create.status}`);
    const created = (await create.json()) as Record<string, unknown>;
    tabId = String(created.tabId ?? created.id ?? '');
    if (!tabId) throw new Error('Camofox did not return a tabId');

    timedOut ||= await waitForReady(tabId);
    if (config.browserSettleMs > 0) {
      await sleep(Math.min(config.browserSettleMs, config.browserTimeoutMs));
    }

    let title = '';
    let finalUrl = typeof created.url === 'string' ? created.url : url;
    let content = '';
    let links: LinkResult[] = [];

    if (config.camofoxApiKey) {
      const expression = `JSON.stringify({title:document.title,url:location.href,text:document.body?.innerText||'',links:Array.from(document.querySelectorAll('a[href]')).slice(0,200).map(a=>({text:(a.innerText||a.textContent||'').trim(),url:a.href}))})`;
      const evaluated = await call(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.camofoxApiKey}` },
        body: JSON.stringify({ userId: config.camofoxUserId, expression }),
      });
      if (evaluated.ok) {
        const parsed = parseEvaluateResult(await evaluated.json());
        if (parsed) {
          title = parsed.title;
          finalUrl = parsed.url || finalUrl;
          content = parsed.text;
          links = parsed.links;
        }
      }
    }

    if (!content) {
      const snapshot = await call(`/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(config.camofoxUserId)}`);
      if (!snapshot.ok) throw new Error(`Camofox snapshot failed: HTTP ${snapshot.status}`);
      const payload = await snapshot.json();
      content = extractSnapshotText(payload);
    }

    await resolvePublicUrl(finalUrl);
    const limited = truncate(normalizeWhitespace(content), maxCharacters);
    const classification = classify({ title, content: limited.value, finalUrl, rendered: true });
    result = {
      backend: 'camofox',
      outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url,
      finalUrl,
      title,
      content: limited.value,
      ...(includeLinks ? { links } : {}),
      elapsedMs: Math.round(performance.now() - started),
      truncated: limited.truncated,
      ...(timedOut ? { timedOut: true } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
    };
  } catch (error) {
    timedOut = timedOut || error instanceof TimeoutError;
    cleanupUnconfirmed = cleanupUnconfirmed || timedOut;
    result = {
      backend: 'camofox',
      outcome: isSecurityPolicyError(error) ? 'policy_denied' : 'network_error',
      url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
      ...(timedOut ? { timedOut: true } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
    };
  } finally {
    if (tabId) {
      try {
        const deleted = await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(config.camofoxUserId)}`, { method: 'DELETE' });
        if (!deleted.ok) cleanupUnconfirmed = true;
      } catch {
        cleanupUnconfirmed = true;
      }
    }
  }
  if (result && cleanupUnconfirmed && !result.cleanupUnconfirmed) {
    result.cleanupUnconfirmed = true;
  }
  if (result && timedOut && !result.timedOut) {
    result.timedOut = true;
  }
  return result ?? {
    backend: 'camofox',
    outcome: 'network_error',
    url,
    elapsedMs: Math.round(performance.now() - started),
    reason: 'Camofox returned no result',
  };
}
