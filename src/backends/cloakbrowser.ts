import { performance } from 'node:perf_hooks';
import { launch } from 'cloakbrowser';
import { classify, detectChallenge } from '../classifier.js';
import { config } from '../config.js';
import { resolvePublicUrl } from '../security/url.js';
import type { FetchAttempt, LinkResult } from '../types.js';
import { normalizeWhitespace, truncate } from '../util/text.js';

interface PageState {
  title: string;
  url: string;
  text: string;
  links: LinkResult[];
}

async function state(page: any): Promise<PageState> {
  return page.evaluate(() => ({
    title: document.title || '',
    url: location.href,
    text: document.body?.innerText || '',
    links: Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map((anchor: any) => ({
      text: (anchor.innerText || anchor.textContent || '').trim(),
      url: anchor.href,
    })),
  }));
}

export async function fetchCloakBrowser(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  let browser: any;
  let context: any;
  try {
    await resolvePublicUrl(url);
    browser = await launch({
      headless: config.cloakHeadless,
      humanize: config.cloakHumanize,
      ...(config.cloakProxy ? { proxy: config.cloakProxy } : {}),
      ...(config.cloakGeoIp ? { geoip: true } : {}),
      ...(config.cloakLicenseKey ? { licenseKey: config.cloakLicenseKey } : {}),
    });
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
      status: response?.status?.(), title: current.title, content: current.text, finalUrl: current.url,
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
    });
    const status = response?.status?.();
    const contentType = response?.headers?.()['content-type'];
    return {
      backend: 'cloakbrowser', outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url, finalUrl: current.url, title: current.title, content: limited.value,
      ...(includeLinks ? { links: current.links.filter((link) => /^https?:/i.test(link.url)) } : {}),
      ...(typeof status === 'number' ? { httpStatus: status } : {}),
      ...(typeof contentType === 'string' ? { contentType } : {}),
      elapsedMs: Math.round(performance.now() - started), truncated: limited.truncated,
    };
  } catch (error) {
    return {
      backend: 'cloakbrowser', outcome: 'network_error', url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}
