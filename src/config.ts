function numberEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function csvEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((item: string) => item.trim()).filter(Boolean);
}

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: numberEnv('PORT', 8088),
  apiKey: process.env.BROWSER_SEARCH_API_KEY ?? '',
  allowedHosts: csvEnv('ALLOWED_HOSTS', ['localhost', '127.0.0.1', 'browser-search']),
  allowedOrigins: csvEnv('ALLOWED_ORIGINS', ['localhost', '127.0.0.1']),

  searxngUrl: process.env.SEARXNG_URL ?? 'http://searxng:8080',
  camofoxUrl: process.env.CAMOFOX_URL ?? 'http://camofox:9377',
  camofoxApiKey: process.env.CAMOFOX_API_KEY ?? '',
  camofoxUserId: process.env.CAMOFOX_USER_ID ?? 'resilient-browser-search',
  camofoxSessionKey: process.env.CAMOFOX_SESSION_KEY ?? 'default',

  cloakEnabled: boolEnv('CLOAK_ENABLED', true),
  cloakLicenseKey: process.env.CLOAKBROWSER_LICENSE_KEY ?? '',
  cloakProxy: process.env.CLOAK_PROXY ?? '',
  cloakGeoIp: boolEnv('CLOAK_GEOIP', false),
  cloakHeadless: boolEnv('CLOAK_HEADLESS', true),
  cloakHumanize: boolEnv('CLOAK_HUMANIZE', true),
  cloakTimezone: process.env.CLOAK_TIMEZONE ?? '',
  cloakLocale: process.env.CLOAK_LOCALE ?? '',

  directTimeoutMs: numberEnv('DIRECT_TIMEOUT_MS', 20_000),
  browserTimeoutMs: numberEnv('BROWSER_TIMEOUT_MS', 45_000),
  challengeWaitMs: numberEnv('CHALLENGE_WAIT_MS', 20_000),
  maxResponseBytes: numberEnv('MAX_RESPONSE_BYTES', 5_000_000),
  defaultMaxCharacters: numberEnv('DEFAULT_MAX_CHARACTERS', 50_000),
  maxMaxCharacters: numberEnv('MAX_MAX_CHARACTERS', 200_000),
  browserConcurrency: numberEnv('BROWSER_CONCURRENCY', 2),
  researchConcurrency: numberEnv('RESEARCH_CONCURRENCY', 4),
  searchBrowserFallback: boolEnv('SEARCH_BROWSER_FALLBACK', true),
  userAgent:
    process.env.WEB_USER_AGENT ??
    'Mozilla/5.0 (compatible; ResilientBrowserSearch/0.1; +https://github.com/Actu4l-Human)',
};
