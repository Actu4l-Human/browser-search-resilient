import { performance } from 'node:perf_hooks';
import { classify } from '../classifier.js';
import { config } from '../config.js';
import { resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt, LinkResult } from '../types.js';
import { normalizeWhitespace, truncate } from '../util/text.js';

async function call(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.browserTimeoutMs);
  try {
    return await fetch(`${config.camofoxUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
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
    try { value = JSON.parse(value); } catch { return null; }
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

export async function fetchCamofox(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  let tabId = '';
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

    await new Promise((resolve) => setTimeout(resolve, 1000));

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
    const classification = classify({ title, content: limited.value, finalUrl });
    return {
      backend: 'camofox', outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url, finalUrl, title, content: limited.value,
      ...(includeLinks ? { links } : {}),
      elapsedMs: Math.round(performance.now() - started), truncated: limited.truncated,
    };
  } catch (error) {
    return {
      backend: 'camofox', outcome: 'network_error', url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tabId) {
      await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(config.camofoxUserId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}
