import { log } from './util/log.js';
import { stackProfileRequiredBackends, stackProfiles, type StackProfile } from './stack-profiles.js';

function numberEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    log.warn('Invalid numeric env value; using fallback', { name, value: raw, fallback });
    return fallback;
  }
  return parsed;
}

function boundedNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = numberEnv(name, fallback, min);
  if (value > max) throw new Error(`Invalid ${name} value: ${value} (expected ${min}..${max})`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function csvEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((item: string) => item.trim())
    .filter(Boolean);
}

function stackProfileEnv(name: string, fallback: StackProfile): StackProfile {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if ((stackProfiles as readonly string[]).includes(raw)) return raw as StackProfile;
  throw new Error(`Invalid ${name} value: ${raw}`);
}

const egressProxyUrl = process.env.EGRESS_PROXY_URL ?? 'http://egress-proxy:3128';
const cloakEnabled = boolEnv('CLOAK_ENABLED', true);
const camofoxEnabled = boolEnv('CAMOFOX_ENABLED', true);
const crawl4aiEnabled = boolEnv('CRAWL4AI_ENABLED', false);
const obscuraEnabled = boolEnv('OBSCURA_ENABLED', false);
const scraplingEnabled = boolEnv('SCRAPLING_ENABLED', false);
const fetchStackProfile = stackProfileEnv('FETCH_STACK_PROFILE', 'baseline');

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: numberEnv('PORT', 8088),
  apiKey: process.env.BROWSER_SEARCH_API_KEY ?? '',
  allowedHosts: csvEnv('ALLOWED_HOSTS', ['localhost', '127.0.0.1', 'browser-search']),
  allowedOrigins: csvEnv('ALLOWED_ORIGINS', ['localhost', '127.0.0.1']),

  searxngUrl: process.env.SEARXNG_URL ?? 'http://searxng:8080',
  camofoxUrl: process.env.CAMOFOX_URL ?? 'http://camofox:9377',
  egressProxyUrl,
  camofoxEnabled,
  camofoxApiKey: process.env.CAMOFOX_API_KEY ?? '',
  camofoxUserId: process.env.CAMOFOX_USER_ID ?? 'resilient-browser-search',
  camofoxSessionKey: process.env.CAMOFOX_SESSION_KEY ?? 'default',

  crawl4aiEnabled,
  crawl4aiUrl: process.env.CRAWL4AI_URL ?? 'http://crawl4ai:11235',
  crawl4aiToken: process.env.CRAWL4AI_TOKEN ?? '',
  crawl4aiTimeoutMs: numberEnv('CRAWL4AI_TIMEOUT_MS', 45_000),

  cloakEnabled,
  cloakLicenseKey: process.env.CLOAKBROWSER_LICENSE_KEY ?? '',
  // Secure by default: use the DNS-pinning egress proxy unless the operator
  // explicitly sets CLOAK_PROXY to an empty string.
  cloakProxy: process.env.CLOAK_PROXY ?? egressProxyUrl,
  cloakGeoIp: boolEnv('CLOAK_GEOIP', false),
  cloakHeadless: boolEnv('CLOAK_HEADLESS', true),
  cloakHumanize: boolEnv('CLOAK_HUMANIZE', true),
  cloakTimezone: process.env.CLOAK_TIMEZONE ?? '',
  cloakLocale: process.env.CLOAK_LOCALE ?? '',

  obscuraEnabled,
  obscuraUrl: process.env.OBSCURA_URL ?? 'http://obscura:9222',

  scraplingEnabled,
  scraplingUrl: process.env.SCRAPLING_URL ?? 'http://scrapling:11236',
  scraplingToken: process.env.SCRAPLING_TOKEN ?? '',

  fetchStackProfile,
  directTimeoutMs: numberEnv('DIRECT_TIMEOUT_MS', 20_000),
  browserTimeoutMs: numberEnv('BROWSER_TIMEOUT_MS', 45_000),
  browserSettleMs: boundedNumberEnv('BROWSER_SETTLE_MS', 0, 0, 5000),
  challengeWaitMs: numberEnv('CHALLENGE_WAIT_MS', 20_000),
  maxResponseBytes: numberEnv('MAX_RESPONSE_BYTES', 5_000_000),
  defaultMaxCharacters: numberEnv('DEFAULT_MAX_CHARACTERS', 50_000),
  maxMaxCharacters: numberEnv('MAX_MAX_CHARACTERS', 200_000),
  browserConcurrency: numberEnv('BROWSER_CONCURRENCY', 2),
  researchConcurrency: numberEnv('RESEARCH_CONCURRENCY', 4),
  searchBrowserFallback: boolEnv('SEARCH_BROWSER_FALLBACK', true),
  userAgent: process.env.WEB_USER_AGENT ?? 'Mozilla/5.0 (compatible; ResilientBrowserSearch/0.2; +https://github.com/actual-human)',

  rateLimitRpm: numberEnv('RATE_LIMIT_RPM', 0, 0),
  rateLimitBurst: numberEnv('RATE_LIMIT_BURST', 0, 0),

  cacheEnabled: boolEnv('CACHE_ENABLED', false),
  cacheTtlMs: numberEnv('CACHE_TTL_MS', 60_000),
  cacheMaxEntries: numberEnv('CACHE_MAX_ENTRIES', 256),

  robotsEnabled: boolEnv('ROBOTS_ENABLED', false),
  robotsCacheTtlMs: numberEnv('ROBOTS_CACHE_TTL_MS', 3_600_000),
};

function validateStackProfileConfiguration(): void {
  if (config.fetchStackProfile === 'baseline') return;
  const required = new Set(stackProfileRequiredBackends(config.fetchStackProfile));
  const missing: string[] = [];
  if (required.has('crawl4ai') && !config.crawl4aiEnabled) missing.push('CRAWL4AI_ENABLED');
  if (required.has('camofox') && !config.camofoxEnabled) missing.push('CAMOFOX_ENABLED');
  if (required.has('cloakbrowser') && !config.cloakEnabled) missing.push('CLOAK_ENABLED');
  if (required.has('obscura') && !config.obscuraEnabled) missing.push('OBSCURA_ENABLED');
  if (required.has('scrapling') && !config.scraplingEnabled) missing.push('SCRAPLING_ENABLED');
  if (missing.length) {
    throw new Error(`FETCH_STACK_PROFILE=${config.fetchStackProfile} requires enabled backends: ${missing.join(', ')}`);
  }
}

validateStackProfileConfiguration();

export function warnOnInsecureDefaults(): void {
  const host = config.host;
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !config.apiKey) {
    log.warn('Listening on a non-loopback address without BROWSER_SEARCH_API_KEY; access is unauthenticated', { host });
  }
  if (config.crawl4aiEnabled && !config.crawl4aiUrl) {
    log.warn('Crawl4AI is enabled without CRAWL4AI_URL; crawl4ai backend will fail');
  }
  if (config.crawl4aiEnabled && !config.crawl4aiToken) {
    log.warn('Crawl4AI is enabled without CRAWL4AI_TOKEN; keep the sidecar on an internal network only');
  }
  if (config.scraplingEnabled && !config.scraplingUrl) {
    log.warn('Scrapling is enabled without SCRAPLING_URL; scrapling backend will fail');
  }
  if (config.scraplingEnabled && !config.scraplingToken) {
    log.warn('Scrapling is enabled without SCRAPLING_TOKEN; keep the sidecar on an internal network only');
  }
  if (config.cloakEnabled && !config.cloakProxy) {
    log.warn('CloakBrowser is enabled without CLOAK_PROXY; DNS rebinding protection is reduced');
  }
  if (config.cloakProxy && config.cloakGeoIp && config.cloakProxy === config.egressProxyUrl) {
    log.warn('CLOAK_GEOIP should remain disabled when using the local egress proxy; the proxy has no geographic metadata');
  }
}
