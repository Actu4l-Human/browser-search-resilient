import type { FetchOutcome } from './types.js';

const CHALLENGE_PATTERNS: Array<[RegExp, string]> = [
  [/cf-chl-|challenge-platform|cf-browser-verification|cdn-cgi\/challenge/i, 'cloudflare'],
  [/checking your browser|just a moment\.\.\./i, 'browser_challenge'],
  [/akamai|bm-verify|sensor_data/i, 'akamai'],
  [/datadome|captcha-delivery\.com/i, 'datadome'],
  [/_incapsula_resource|imperva|incapsula/i, 'imperva'],
  [/px-captcha|perimeterx/i, 'perimeterx'],
  [/check\.ddos-guard\.net|ddos-guard/i, 'ddos_guard'],
];

const HUMAN_PATTERNS = [
  /verify (that )?you are human/i,
  /complete the captcha/i,
  /captcha required/i,
  /press and hold/i,
  /unusual traffic from your computer network/i,
];

const AUTH_PATTERNS = [
  /sign in to continue/i,
  /log in to continue/i,
  /authentication required/i,
  /subscription required/i,
  /this content is for subscribers/i,
];

const JS_PATTERNS = [
  /enable javascript/i,
  /javascript is required/i,
  /please turn javascript on/i,
  /you need to enable javascript/i,
];

export interface ClassificationInput {
  status?: number;
  title?: string;
  content?: string;
  contentType?: string;
  finalUrl?: string;
}

export function detectChallenge(input: ClassificationInput): string | undefined {
  const haystack = `${input.finalUrl ?? ''}\n${input.title ?? ''}\n${input.content ?? ''}`.slice(0, 200_000);
  for (const [pattern, name] of CHALLENGE_PATTERNS) if (pattern.test(haystack)) return name;
  return undefined;
}

export function classify(input: ClassificationInput): { outcome: FetchOutcome; reason?: string; challenge?: string } {
  const status = input.status;
  const text = `${input.title ?? ''}\n${input.content ?? ''}`.trim();
  const contentType = (input.contentType ?? '').toLowerCase();

  if (status === 401 || status === 407) return { outcome: 'authentication_required', reason: `HTTP ${status}` };
  if (status === 404 || status === 410) return { outcome: 'not_found', reason: `HTTP ${status}` };
  if (status === 451) return { outcome: 'policy_denied', reason: 'HTTP 451' };
  if (status === 429) return { outcome: 'rate_limited', reason: 'HTTP 429' };

  const challenge = detectChallenge(input);
  if (challenge) return { outcome: 'antibot_challenge', reason: `Detected ${challenge} challenge`, challenge };
  if (HUMAN_PATTERNS.some((pattern) => pattern.test(text))) {
    return { outcome: 'human_verification_required', reason: 'Human verification remains on the page' };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return { outcome: 'authentication_required', reason: 'Page requires authentication or a subscription' };
  }
  if (JS_PATTERNS.some((pattern) => pattern.test(text))) {
    return { outcome: 'js_required', reason: 'Page explicitly requires JavaScript' };
  }
  if (status !== undefined && status >= 400) {
    if ([403, 406, 418, 503].includes(status)) return { outcome: 'antibot_challenge', reason: `Potential browser challenge: HTTP ${status}` };
    return { outcome: 'network_error', reason: `HTTP ${status}` };
  }
  if (contentType && !contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
    return { outcome: 'unsupported_content_type', reason: `Unsupported content type: ${contentType}` };
  }
  if (text.length < 80) return { outcome: 'empty_content', reason: 'Page returned too little readable content' };
  return { outcome: 'success' };
}

export function shouldEscalate(outcome: FetchOutcome): boolean {
  return ['js_required', 'antibot_challenge', 'rate_limited', 'empty_content', 'network_error'].includes(outcome);
}
