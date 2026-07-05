import * as http from 'node:http';
import * as https from 'node:https';
import { TtlCache } from '../util/cache.js';
import { config } from '../config.js';
import { resolvePublicUrl } from './url.js';

export interface RobotsGroup {
  userAgents: string[];
  allow: string[];
  disallow: string[];
}

interface RobotsRules {
  rules: RobotsGroup[];
}

const cache = new TtlCache<string, RobotsRules>(config.robotsCacheTtlMs, 64);

async function fetchRobots(origin: string): Promise<RobotsRules> {
  const cached = cache.get(origin);
  if (cached) return cached;

  const rules: RobotsRules = { rules: [] };
  try {
    const robotsUrl = new URL('/robots.txt', origin);
    const resolved = await resolvePublicUrl(robotsUrl.toString());
    const body = await new Promise<string>((resolve, reject) => {
      const transport = robotsUrl.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          protocol: robotsUrl.protocol,
          hostname: robotsUrl.hostname.replace(/^\[|\]$/g, ''),
          port: robotsUrl.port || undefined,
          path: '/robots.txt',
          method: 'GET',
          headers: { 'User-Agent': config.userAgent, Accept: 'text/plain', Connection: 'close' },
          lookup: (_h, _o, cb) => cb(null, resolved.addresses[0]?.address ?? '', resolved.addresses[0]?.family ?? 4),
          servername: robotsUrl.hostname.replace(/^\[|\]$/g, ''),
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            resolve('');
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          const limit = Math.min(config.maxResponseBytes, 1_000_000);
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > limit) {
              req.destroy(new Error(`robots.txt exceeded ${limit} bytes`));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      req.setTimeout(config.directTimeoutMs, () => req.destroy(new Error('robots.txt timeout')));
      req.on('error', reject);
      req.end();
    });

    let currentUserAgents: string[] = [];
    let currentAllow: string[] = [];
    let currentDisallow: string[] = [];
    const flush = (): void => {
      if (currentUserAgents.length) {
        rules.rules.push({
          userAgents: currentUserAgents.map((agent) => agent.toLowerCase()),
          allow: currentAllow,
          disallow: currentDisallow,
        });
      }
      currentUserAgents = [];
      currentAllow = [];
      currentDisallow = [];
    };
    for (const rawLine of body.split('\n')) {
      const line = rawLine.split('#')[0]!.trim();
      if (!line) continue;
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      const field = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();
      if (field === 'user-agent') {
        if (currentAllow.length || currentDisallow.length) flush();
        currentUserAgents.push(value);
      } else if (field === 'allow') {
        currentAllow.push(value);
      } else if (field === 'disallow') {
        if (value) currentDisallow.push(value);
      }
    }
    flush();
  } catch {
    // No robots.txt or fetch error: allow by default.
  }
  cache.set(origin, rules);
  return rules;
}

export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const hadDollar = pattern.endsWith('$');
  let regex = hadDollar ? pattern.slice(0, -1) : pattern;
  regex = regex.replace(/[.?+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${regex}${hadDollar ? '$' : ''}`).test(path);
}

function userAgentSpecificity(group: RobotsGroup, userAgent: string): number {
  let specificity = -1;
  for (const rawAgent of group.userAgents) {
    const agent = rawAgent.trim().toLowerCase();
    const wildcard = agent === '' || agent === '*';
    if (wildcard || userAgent.includes(agent)) specificity = Math.max(specificity, wildcard ? 0 : agent.length);
  }
  return specificity;
}

function ruleSpecificity(pattern: string): number {
  return (pattern.endsWith('$') ? pattern.slice(0, -1) : pattern).replace(/\*/g, '').length;
}

export function isPathAllowed(groups: RobotsGroup[], userAgent: string, path: string): boolean {
  const normalizedAgent = userAgent.toLowerCase();
  let bestAgentSpecificity = -1;
  const matchingGroups: RobotsGroup[] = [];

  for (const group of groups) {
    const specificity = userAgentSpecificity(group, normalizedAgent);
    if (specificity < 0) continue;
    if (specificity > bestAgentSpecificity) {
      bestAgentSpecificity = specificity;
      matchingGroups.length = 0;
      matchingGroups.push(group);
    } else if (specificity === bestAgentSpecificity) {
      matchingGroups.push(group);
    }
  }

  if (matchingGroups.length === 0) return true;

  let decision: { allow: boolean; specificity: number } | undefined;
  const consider = (pattern: string, allow: boolean): void => {
    if (!pathMatches(pattern, path)) return;
    const specificity = ruleSpecificity(pattern);
    if (!decision || specificity > decision.specificity || (specificity === decision.specificity && allow)) {
      decision = { allow, specificity };
    }
  };

  for (const group of matchingGroups) {
    for (const pattern of group.disallow) consider(pattern, false);
    for (const pattern of group.allow) consider(pattern, true);
  }

  return decision?.allow ?? true;
}

export async function isAllowed(url: string): Promise<boolean> {
  if (!config.robotsEnabled) return true;
  const parsed = new URL(url);
  const robots = await fetchRobots(`${parsed.protocol}//${parsed.host}`);
  const path = `${parsed.pathname}${parsed.search}`;
  return isPathAllowed(robots.rules, config.userAgent, path);
}
