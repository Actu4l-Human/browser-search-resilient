import { performance } from 'node:perf_hooks';
import { launch } from 'cloakbrowser';
import { classify, detectChallenge } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt, LinkResult } from '../types.js';
import { normalizeWhitespace, truncate } from '../util/text.js';
import { log } from '../util/log.js';

interface PageState {
  title: string;
  url: string;
  text: string;
  links: LinkResult[];
}

interface CachedBrowser {
  promise: Promise<any>;
  options: Record<string, unknown>;
}

let cachedBrowser: CachedBrowser | undefined;

function launchOptions(): Record<string, unknown> {
  return {
    headless: config.cloakHeadless,
    humanize: config.cloakHumanize,
    ...(config.cloakProxy ? { proxy: config.cloakProxy } : {}),
    ...(config.cloakGeoIp ? { geoip: true } : {}),
    ...(config.cloakLicenseKey ? { licenseKey: config.cloakLicenseKey } : {}),
    ...(config.cloakTimezone ? { timezone: config.cloakTimezone } : {}),
    ...(config.cloakLocale ? { locale: config.cloakLocale } : {}),
  };
}

async function getBrowser(): Promise<any> {
  if (cachedBrowser) {
    try {
      const browser = await cachedBrowser.promise;
      if (browser && !(browser as any)?.isClosed?.()) return browser;
    } catch {
      // previous launch failed; fall through to relaunch
    }
  }
  // Reuse the previously captured launch options on relaunch so a transient
  // disconnect keeps the same proxy/geo/locale configuration; compute fresh on
  // the very first launch.
  const options = cachedBrowser?.options ?? launchOptions();
  const promise = (async () => {
    const browser = await launch(options);
    browser?.on?.('disconnected', () => {
      log.warn('CloakBrowser disconnected; will relaunch on next request');
      cachedBrowser = undefined;
    });
    return browser;
  })();
  cachedBrowser = { promise, options };
  return promise;
}

export async function closeCloakBrowser(): Promise<void> {
  const current = cachedBrowser;
  cachedBrowser = undefined;
  if (current) {
    try {
      const browser = await current.promise;
      await browser?.close?.();
    } catch {
      // ignore
    }
  }
}

async function state(page: any): Promise<PageState> {
  return page.evaluate(() => ({
    title: document.title || '',
    url: location.href,
    text: document.body?.innerText || '',
    links: Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 200)
      .map((anchor: any) => ({
        text: (anchor.innerText || anchor.textContent || '').trim(),
        url: anchor.href,
      })),
  }));
}

export async function fetchCloakBrowser(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  let context: any;
  try {
    await resolvePublicUrl(url);
    const browser = await getBrowser();
    context = await browser.newContext();

    await context.route('**/*', async (route: any) => {
      const requestUrl = route.request().url();
      if (!/^https?:/i.test(requestUrl)) return route.continue();
      try {
        await resolvePublicUrl(requestUrl);
        return route.continue();
      } catch {
        return route.abort('blockedbyclient');
      }
    });

    const page = await context.newPage();
    let response: any;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle', timeout: config.browserTimeoutMs });
    } catch {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    }

    let current = await state(page);
    const deadline = Date.now() + config.challengeWaitMs;
    let detected = detectChallenge({
      status: response?.status?.(),
      title: current.title,
      content: current.text,
      finalUrl: current.url,
    });
    while (detected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await state(page);
      detected = detectChallenge({ title: current.title, content: current.text, finalUrl: current.url });
    }

    await resolvePublicUrl(current.url);
    const limited = truncate(normalizeWhitespace(current.text), maxCharacters);
    const classification = classify({
      status: response?.status?.(),
      title: current.title,
      content: limited.value,
      contentType: response?.headers?.()['content-type'],
      finalUrl: current.url,
      rendered: true,
    });
    const status = response?.status?.();
    const contentType = response?.headers?.()['content-type'];
    return {
      backend: 'cloakbrowser',
      outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url,
      finalUrl: current.url,
      title: current.title,
      content: limited.value,
      ...(includeLinks ? { links: current.links.filter((link) => /^https?:/i.test(link.url)) } : {}),
      ...(typeof status === 'number' ? { httpStatus: status } : {}),
      ...(typeof contentType === 'string' ? { contentType } : {}),
      elapsedMs: Math.round(performance.now() - started),
      truncated: limited.truncated,
    };
  } catch (error) {
    if (!isSecurityPolicyError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      if (/target closed|browser has been closed|connection closed|disconnected/i.test(message)) {
        cachedBrowser = undefined;
      }
    }
    return {
      backend: 'cloakbrowser',
      outcome: isSecurityPolicyError(error) ? 'policy_denied' : 'network_error',
      url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
}
