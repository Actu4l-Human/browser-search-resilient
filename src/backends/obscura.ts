import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext, type Page, type Response as PlaywrightResponse, type Route } from 'playwright-core';
import { classify, detectChallenge } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt, LinkResult } from '../types.js';
import { log } from '../util/log.js';
import { normalizeWhitespace, truncate } from '../util/text.js';

interface PageState {
  title: string;
  url: string;
  text: string;
  links?: LinkResult[];
}

interface RequestResources {
  browser: Browser | undefined;
  context: BrowserContext | undefined;
  cleanupUnconfirmed: boolean;
}

class DeadlineExceededError extends Error {
  constructor() {
    super('Obscura request deadline exceeded');
    this.name = 'DeadlineExceededError';
  }
}

interface DeadlineState {
  aborted: boolean;
  deadlineAt: number;
  timer: NodeJS.Timeout;
  promise: Promise<never>;
}

const cleanupTimeoutMs = 5_000;
const connectTimeoutMs = 10_000;
const activeBrowsers = new Set<Browser>();

function deadlineMs(): number {
  return connectTimeoutMs + 2 * config.browserTimeoutMs + config.challengeWaitMs;
}

async function cleanupRequestResources(resources: RequestResources): Promise<boolean> {
  const browser = resources.browser;
  const context = resources.context;
  resources.browser = undefined;
  resources.context = undefined;
  const closed = await cleanupBrowser(browser, context);
  if (!closed) resources.cleanupUnconfirmed = true;
  return closed;
}

function createDeadline(resources: RequestResources): DeadlineState {
  const deadline = deadlineMs();
  let rejectDeadline!: (error: DeadlineExceededError) => void;
  const promise = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const state: DeadlineState = {
    aborted: false,
    deadlineAt: Date.now() + deadline,
    timer: setTimeout(() => {
      state.aborted = true;
      void cleanupRequestResources(resources);
      rejectDeadline(new DeadlineExceededError());
    }, deadline),
    promise,
  };
  state.timer.unref?.();
  return state;
}

function expired(state: DeadlineState): boolean {
  if (state.aborted) return true;
  if (Date.now() >= state.deadlineAt) {
    state.aborted = true;
    return true;
  }
  return false;
}

async function throwIfExpired(state: DeadlineState, resources: RequestResources): Promise<void> {
  if (!expired(state)) return;
  await cleanupRequestResources(resources);
  throw new DeadlineExceededError();
}

function boundedReason(message: string): string {
  return truncate(normalizeWhitespace(message), 512).value;
}

function rewriteObscuraWebSocketUrl(webSocketDebuggerUrl: string, baseUrl: string): string {
  const parsed = new URL(webSocketDebuggerUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    const base = new URL(baseUrl);
    parsed.hostname = base.hostname;
    if (base.port) parsed.port = base.port;
  }
  return parsed.toString();
}

async function resolveObscuraWebSocketUrl(baseUrl: string, deadline: DeadlineState): Promise<string> {
  await throwIfExpired(deadline, { browser: undefined, context: undefined, cleanupUnconfirmed: false });
  const versionUrl = new URL('/json/version', baseUrl);
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(connectTimeoutMs) });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Obscura CDP endpoint failed: HTTP ${response.status}`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Obscura CDP endpoint returned an invalid version payload');
  }
  const webSocketDebuggerUrl = (payload as Record<string, unknown>).webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== 'string' || !webSocketDebuggerUrl) {
    throw new Error('Obscura CDP endpoint did not advertise a websocket URL');
  }
  await throwIfExpired(deadline, { browser: undefined, context: undefined, cleanupUnconfirmed: false });
  return rewriteObscuraWebSocketUrl(webSocketDebuggerUrl, baseUrl);
}

async function closeBounded(label: string, action: () => Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${cleanupTimeoutMs}ms`)), cleanupTimeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([action(), timeout]);
    return true;
  } catch (error) {
    log.warn('Obscura cleanup failed', {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupBrowser(browser: Browser | undefined, context: BrowserContext | undefined): Promise<boolean> {
  let ok = true;
  if (context) {
    ok = (await closeBounded('context.close', () => context.close())) && ok;
  }
  if (browser) {
    const closed = await closeBounded('browser.close', () => browser.close());
    if (closed) activeBrowsers.delete(browser);
    ok = closed && ok;
  }
  return ok;
}

async function state(page: Page, includeLinks: boolean): Promise<PageState> {
  return page.evaluate(
    (wantLinks: boolean) => {
      const links = wantLinks
        ? Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 200)
            .map((anchor) => {
              const link = anchor as HTMLAnchorElement;
              return {
                text: (anchor.textContent || '').trim(),
                url: link.href,
              };
            })
        : undefined;

      return {
        title: document.title || '',
        url: location.href,
        text: document.body?.innerText || '',
        ...(links ? { links } : {}),
      };
    },
    includeLinks,
  );
}

export async function closeObscuraBrowsers(): Promise<void> {
  const browsers = [...activeBrowsers];
  activeBrowsers.clear();
  await Promise.all(
    browsers.map(async (browser) => {
      await closeBounded('shutdown.close', () => browser.close());
    }),
  );
}

export async function fetchObscura(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  const resources: RequestResources = { browser: undefined, context: undefined, cleanupUnconfirmed: false };
  const deadline = createDeadline(resources);

  const attempt = (async (): Promise<FetchAttempt> => {
    try {
      await resolvePublicUrl(url);
      if (!config.obscuraEnabled) {
        return {
          backend: 'obscura',
          outcome: 'network_error',
          url,
          elapsedMs: Math.round(performance.now() - started),
          reason: 'Obscura backend is disabled',
          ...(resources.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
        };
      }

      await throwIfExpired(deadline, resources);
      const webSocketDebuggerUrl = await resolveObscuraWebSocketUrl(config.obscuraUrl, deadline);
      await throwIfExpired(deadline, resources);
      const currentBrowser = await chromium.connectOverCDP(webSocketDebuggerUrl, { timeout: connectTimeoutMs });
      resources.browser = currentBrowser;
      activeBrowsers.add(currentBrowser);
      currentBrowser.on('disconnected', () => {
        activeBrowsers.delete(currentBrowser);
      });
      await throwIfExpired(deadline, resources);

      resources.context = await currentBrowser.newContext();
      await throwIfExpired(deadline, resources);

      await resources.context.route('**/*', async (route: Route) => {
        const requestUrl = route.request().url();
        if (!/^https?:/i.test(requestUrl)) {
          await route.continue();
          return;
        }
        try {
          await resolvePublicUrl(requestUrl);
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });

      await throwIfExpired(deadline, resources);
      const page = await resources.context.newPage();
      await throwIfExpired(deadline, resources);

      let response: PlaywrightResponse | null;
      try {
        response = await page.goto(url, { waitUntil: 'networkidle', timeout: config.browserTimeoutMs });
      } catch {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
      }

      await throwIfExpired(deadline, resources);
      let current = await state(page, includeLinks);
      await throwIfExpired(deadline, resources);

      const challengeDeadline = Date.now() + config.challengeWaitMs;
      const challengeStatus = response?.status();
      let detected = detectChallenge({
        ...(challengeStatus !== undefined ? { status: challengeStatus } : {}),
        title: current.title,
        content: current.text,
        finalUrl: current.url,
      });

      while (detected && Date.now() < challengeDeadline) {
        await throwIfExpired(deadline, resources);
        await page.waitForTimeout(1000);
        await throwIfExpired(deadline, resources);
        current = await state(page, includeLinks);
        await throwIfExpired(deadline, resources);
        detected = detectChallenge({
          ...(challengeStatus !== undefined ? { status: challengeStatus } : {}),
          title: current.title,
          content: current.text,
          finalUrl: current.url,
        });
      }

      await throwIfExpired(deadline, resources);
      await resolvePublicUrl(current.url);
      await throwIfExpired(deadline, resources);

      const limited = truncate(normalizeWhitespace(current.text), maxCharacters);
      const headers = response?.headers();
      const contentType = headers?.['content-type'];
      const httpStatus = response?.status();
      const classification = classify({
        ...(httpStatus !== undefined ? { status: httpStatus } : {}),
        title: current.title,
        content: limited.value,
        ...(contentType ? { contentType } : {}),
        finalUrl: current.url,
        rendered: true,
      });

      return {
        backend: 'obscura',
        outcome: classification.outcome,
        ...(classification.reason ? { reason: classification.reason } : {}),
        ...(classification.challenge ? { challenge: classification.challenge } : {}),
        url,
        finalUrl: current.url,
        title: current.title,
        content: limited.value,
        ...(includeLinks ? { links: current.links?.filter((link) => /^https?:/i.test(link.url)) ?? [] } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(contentType ? { contentType } : {}),
        elapsedMs: Math.round(performance.now() - started),
        truncated: limited.truncated,
        ...(resources.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    } catch (error) {
      if (isSecurityPolicyError(error)) {
        return {
          backend: 'obscura',
          outcome: 'policy_denied',
          url,
          elapsedMs: Math.round(performance.now() - started),
          reason: boundedReason(error.message),
          ...(resources.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
        };
      }

      return {
        backend: 'obscura',
        outcome: 'network_error',
        url,
        elapsedMs: Math.round(performance.now() - started),
        reason: boundedReason(error instanceof Error ? error.message : String(error)),
        ...(resources.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      };
    }
  })();

  try {
    return await Promise.race([attempt, deadline.promise]);
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      resources.cleanupUnconfirmed = true;
      return {
        backend: 'obscura',
        outcome: 'network_error',
        url,
        elapsedMs: Math.round(performance.now() - started),
        reason: 'Obscura request deadline exceeded',
        timedOut: true,
        cleanupUnconfirmed: true,
      };
    }
    throw error;
  } finally {
    clearTimeout(deadline.timer);
    await cleanupRequestResources(resources);
  }
}
