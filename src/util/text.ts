import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { LinkResult } from '../types.js';

type Node = DefaultTreeAdapterMap['node'];

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
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

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas']);
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'br',
  'hr',
]);

function isElement(node: Node): node is DefaultTreeAdapterMap['element'] {
  return 'tagName' in node;
}

function isText(node: Node): node is DefaultTreeAdapterMap['textNode'] {
  return node.nodeName === '#text';
}

function findElement(node: Node, name: string): DefaultTreeAdapterMap['element'] | undefined {
  if (isElement(node) && node.tagName === name) return node;
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const found = findElement(child, name);
      if (found) return found;
    }
  }
  return undefined;
}

function collectText(node: Node, parts: string[]): void {
  if (isElement(node)) {
    if (SKIP_TAGS.has(node.tagName)) return;
    for (const child of node.childNodes) collectText(child, parts);
    if (BLOCK_TAGS.has(node.tagName)) parts.push('\n');
  } else if (isText(node)) {
    parts.push(node.value);
  }
}

export function extractTitle(html: string): string {
  try {
    return extractTitleFromDoc(parse(html, { sourceCodeLocationInfo: false }));
  } catch {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? normalizeWhitespace(decodeHtmlEntities(stripTags(match[1] ?? ''))) : '';
  }
}

export function extractTitleFromDoc(doc: Node): string {
  try {
    const title = findElement(doc, 'title');
    const parts: string[] = [];
    if (title) for (const child of title.childNodes) if (isText(child)) parts.push(child.value);
    return normalizeWhitespace(decodeHtmlEntities(stripTags(parts.join(''))));
  } catch {
    return '';
  }
}

export function htmlToText(html: string): string {
  try {
    return htmlToTextFromDoc(parse(html, { sourceCodeLocationInfo: false }));
  } catch {
    const cleaned = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    return normalizeWhitespace(decodeHtmlEntities(cleaned));
  }
}

export function htmlToTextFromDoc(doc: Node): string {
  try {
    const body = findElement(doc, 'body') ?? doc;
    const parts: string[] = [];
    collectText(body, parts);
    return normalizeWhitespace(decodeHtmlEntities(parts.join('')));
  } catch {
    return '';
  }
}

export function extractLinks(html: string, baseUrl: string, limit = 200): LinkResult[] {
  try {
    return extractLinksFromDoc(parse(html, { sourceCodeLocationInfo: false }), baseUrl, limit);
  } catch {
    return [];
  }
}

export function extractLinksFromDoc(doc: Node, baseUrl: string, limit = 200): LinkResult[] {
  const links: LinkResult[] = [];
  const seen = new Set<string>();
  try {
    const visit = (node: Node): void => {
      if (isElement(node)) {
        if (node.tagName === 'a') {
          const href = node.attrs.find((attr) => attr.name === 'href')?.value ?? '';
          if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
            try {
              const url = new URL(decodeHtmlEntities(href), baseUrl).toString();
              if (/^https?:/i.test(url) && !seen.has(url)) {
                seen.add(url);
                const parts: string[] = [];
                collectText(node, parts);
                links.push({ text: normalizeWhitespace(decodeHtmlEntities(parts.join(''))), url });
                if (links.length >= limit) return;
              }
            } catch {
              // Ignore malformed links.
            }
          }
        }
      }
      if ('childNodes' in node) {
        for (const child of node.childNodes) {
          if (links.length >= limit) return;
          visit(child);
        }
      }
    };
    visit(doc);
  } catch {
    // Fall back silently; regex-based extraction is intentionally removed in favor of parse5.
  }
  return links;
}

export function parseDocument(html: string): Node {
  return parse(html, { sourceCodeLocationInfo: false });
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
