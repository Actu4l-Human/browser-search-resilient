import type { LinkResult } from '../types.js';

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, token: string) => {
    if (token.startsWith('#x') || token.startsWith('#X')) {
      const cp = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (token.startsWith('#')) {
      const cp = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return ENTITY_MAP[token.toLowerCase()] ?? full;
  });
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeWhitespace(decodeHtmlEntities(stripTags(match[1] ?? ''))) : '';
}

export function htmlToText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  return normalizeWhitespace(decodeHtmlEntities(cleaned));
}

export function extractLinks(html: string, baseUrl: string, limit = 200): LinkResult[] {
  const links: LinkResult[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && links.length < limit) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      const url = new URL(decodeHtmlEntities(href), baseUrl).toString();
      if (!/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      links.push({ text: normalizeWhitespace(decodeHtmlEntities(stripTags(match[4] ?? ''))), url });
    } catch {
      // Ignore malformed links.
    }
  }
  return links;
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

export function truncate(value: string, maxCharacters: number): { value: string; truncated: boolean } {
  if (value.length <= maxCharacters) return { value, truncated: false };
  return { value: `${value.slice(0, maxCharacters)}\n\n[truncated]`, truncated: true };
}
