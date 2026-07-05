import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import { classify } from '../classifier.js';
import { config } from '../config.js';
import { isSecurityPolicyError, resolvePublicUrl, type ResolvedAddress } from '../security/url.js';
import { isAllowed } from '../security/robots.js';
import type { FetchAttempt } from '../types.js';
import { extractLinksFromDoc, extractTitleFromDoc, htmlToTextFromDoc, parseDocument, truncate } from '../util/text.js';
import { extractPdfText, isPdf } from '../util/pdf.js';

export function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback): void => {
    if (options.all === true) {
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
      return;
    }

    const requestedFamily = options.family;
    const selected =
      requestedFamily === 4 || requestedFamily === 6 ? addresses.find((candidate) => candidate.family === requestedFamily) : addresses[0];

    if (!selected) {
      callback(
        new Error(requestedFamily ? `No validated IPv${requestedFamily} address available` : 'No validated DNS address available'),
        [],
      );
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

async function requestOnceWithRetry(url: URL, addresses: ResolvedAddress[], timeoutMs: number, maxBytes: number): Promise<RawResponse> {
  const maxAttempts = 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await requestOnce(url, addresses, timeoutMs, maxBytes);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient = /ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(message);
      if (!transient || attempt === maxAttempts - 1) break;
      const jitter = 150 + Math.floor(Math.random() * 350);
      await new Promise((resolve) => setTimeout(resolve, jitter * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function requestWithSafeRedirects(rawUrl: string, maxRedirects = 5): Promise<RawResponse> {
  let current = rawUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (!(await isAllowed(current))) {
      const err = new Error('Disallowed by robots.txt');
      err.name = 'RobotsDenied';
      throw err;
    }
    const resolved = await resolvePublicUrl(current);
    const response = await requestOnceWithRetry(resolved.url, resolved.addresses, config.directTimeoutMs, config.maxResponseBytes);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (!location) return response;
    if (redirect === maxRedirects) throw new Error(`Too many redirects (${maxRedirects})`);
    current = new URL(location, resolved.url).toString();
  }
  throw new Error('Unreachable redirect state');
}

function normalizeEncoding(label: string): string | undefined {
  const lower = label.trim().toLowerCase().replace(/_/g, '-');
  if (!lower) return undefined;
  if (['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(lower)) return 'utf-8';
  if (['gbk', 'gb2312', 'gb18030'].includes(lower)) return 'gb18030';
  if (['shift_jis', 'sjis', 'shift-jis', 'ms_kanji'].includes(lower)) return 'shift_jis';
  if (['euc-jp', 'euc_jp'].includes(lower)) return 'euc-jp';
  if (['euc-kr', 'korean'].includes(lower)) return 'euc-kr';
  if (['iso-8859-1', 'latin1', 'iso8859-1', 'windows-1252', 'cp1252'].includes(lower)) return 'windows-1252';
  if (['koi8-r'].includes(lower)) return 'koi8-r';
  if (['big5', 'big-5'].includes(lower)) return 'big5';
  return lower;
}

function detectCharset(headers: IncomingHttpHeaders, bodySample: string): string | undefined {
  const headerCt = String(headers['content-type'] ?? '');
  const headerMatch = headerCt.match(/charset=([^;\s]+)/i);
  if (headerMatch) return normalizeEncoding(headerMatch[1]!);
  const metaSimple = bodySample.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  if (metaSimple) return normalizeEncoding(metaSimple[1]!);
  const metaPragma = bodySample.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["']?[^"']*charset=([\w-]+)/i);
  if (metaPragma) return normalizeEncoding(metaPragma[1]!);
  return undefined;
}

function decodeBody(body: Buffer, headers: IncomingHttpHeaders, isHtml: boolean): string {
  const sample = body.subarray(0, 2048).toString('latin1');
  const encoding = detectCharset(headers, isHtml ? sample : '') ?? 'utf-8';
  if (encoding === 'utf-8') return body.toString('utf8');
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

function curateHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const keep = [
    'content-type',
    'content-language',
    'last-modified',
    'etag',
    'date',
    'server',
    'content-length',
    'cache-control',
    'expires',
  ];
  const result: Record<string, string> = {};
  for (const name of keep) {
    const value = headers[name];
    if (value !== undefined) result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

export async function fetchDirect(url: string, maxCharacters: number, includeLinks: boolean): Promise<FetchAttempt> {
  const started = performance.now();
  try {
    const response = await requestWithSafeRedirects(url);
    const contentType =
      String(response.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim() ?? '';
    const pdf = isPdf(response.body, contentType);
    if (pdf) {
      const pdfText = await extractPdfText(response.body);
      const limited = truncate(pdfText.trim(), maxCharacters);
      const classification = classify({
        status: response.status,
        content: limited.value,
        contentType: 'text/plain',
        finalUrl: response.finalUrl,
      });
      return {
        backend: 'direct',
        outcome: classification.outcome,
        ...(classification.reason ? { reason: classification.reason } : {}),
        url,
        finalUrl: response.finalUrl,
        title: '',
        content: limited.value,
        contentType,
        headers: curateHeaders(response.headers),
        httpStatus: response.status,
        elapsedMs: Math.round(performance.now() - started),
        truncated: limited.truncated,
      };
    }
    const rawHead = response.body.subarray(0, 2000).toString('utf8');
    const isHtml = contentType.includes('html') || /<html|<!doctype html/i.test(rawHead);
    const raw = decodeBody(response.body, response.headers, isHtml);
    const doc = isHtml ? parseDocument(raw) : null;
    const title = doc ? extractTitleFromDoc(doc) : '';
    const extracted = doc ? htmlToTextFromDoc(doc) : raw.trim();
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
      ...(includeLinks && doc ? { links: extractLinksFromDoc(doc, response.finalUrl) } : {}),
      contentType,
      headers: curateHeaders(response.headers),
      httpStatus: response.status,
      elapsedMs: Math.round(performance.now() - started),
      truncated: limited.truncated,
    };
  } catch (error) {
    const robotsDenied = error instanceof Error && error.name === 'RobotsDenied';
    return {
      backend: 'direct',
      outcome: robotsDenied || isSecurityPolicyError(error) ? 'policy_denied' : 'network_error',
      url,
      elapsedMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
