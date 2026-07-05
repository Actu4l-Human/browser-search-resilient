import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import { classify } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl, type ResolvedAddress } from '../security/url.js';
import type { FetchAttempt } from '../types.js';
import { extractLinks, extractTitle, htmlToText, truncate } from '../util/text.js';

export function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback): void => {
    if (options.all === true) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }

    const requestedFamily = options.family;
    const selected = requestedFamily === 4 || requestedFamily === 6
      ? addresses.find((candidate) => candidate.family === requestedFamily)
      : addresses[0];

    if (!selected) {
      callback(new Error(requestedFamily ? `No validated IPv${requestedFamily} address available` : 'No validated DNS address available'), []);
      return;
    }

    callback(null, selected.address, selected.family);
  };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

function requestOnce(url: URL, addresses: ResolvedAddress[], timeoutMs: number, maxBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const selected = addresses[0];
    if (!selected) return reject(new Error('No validated DNS address available'));

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'User-Agent': config.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          Host: url.host,
          Connection: 'close',
        },
        lookup: createPinnedLookup(addresses),
        servername: url.hostname.replace(/^\[|\]$/g, ''),
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            request.destroy(new Error(`Response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            finalUrl: url.toString(),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

async function requestWithSafeRedirects(rawUrl: string, maxRedirects = 5): Promise<RawResponse> {
  let current = rawUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const resolved = await resolvePublicUrl(current);
    const response = await requestOnce(resolved.url, resolved.addresses, config.directTimeoutMs, config.maxResponseBytes);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (!location) return response;
    if (redirect === maxRedirects) throw new Error(`Too many redirects (${maxRedirects})`);
    current = new URL(location, resolved.url).toString();
  }
  throw new Error('Unreachable redirect state');
}

export async function fetchDirect(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  try {
    const response = await requestWithSafeRedirects(url);
    const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    const charsetMatch = String(response.headers['content-type'] ?? '').match(/charset=([^;\s]+)/i);
    const encoding = charsetMatch?.[1]?.toLowerCase() === 'iso-8859-1' ? 'latin1' : 'utf8';
    const raw = response.body.toString(encoding as BufferEncoding);
    const isHtml = contentType.includes('html') || /<html|<!doctype html/i.test(raw.slice(0, 2000));
    const title = isHtml ? extractTitle(raw) : '';
    const extracted = isHtml ? htmlToText(raw) : raw.trim();
    const limited = truncate(extracted, maxCharacters);
    const classification = classify({
      status: response.status,
      title,
      content: limited.value,
      contentType,
      finalUrl: response.finalUrl,
    });
    return {
      backend: 'direct',
      outcome: classification.outcome,
      ...(classification.reason ? { reason: classification.reason } : {}),
      ...(classification.challenge ? { challenge: classification.challenge } : {}),
      url,
      finalUrl: response.finalUrl,
      title,
      content: limited.value,
      ...(includeLinks && isHtml ? { links: extractLinks(raw, response.finalUrl) } : {}),
      contentType,
      httpStatus: response.status,
      elapsedMs: Math.round(performance.now() - started),
      truncated: limited.truncated,
    };
  } catch (error) {
    return {
      backend: 'direct',
      outcome: isSecurityPolicyError(error) ? 'policy_denied' : 'network_error',
      url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
