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
  const collector = createLinkCollector(baseUrl, limit);
  try {
    const visit = (node: Node): void => {
      if (collector.full) return;
      if (isElement(node) && node.tagName === 'a') {
        const href = node.attrs.find((attr) => attr.name === 'href')?.value ?? '';
        if (href) {
          // Anchor text is produced lazily so it is only collected/decoded for
          // navigable, first-seen links that will actually be kept.
          collector.add(href, () => {
            const parts: string[] = [];
            collectText(node, parts);
            return normalizeWhitespace(decodeHtmlEntities(parts.join('')));
          });
        }
      }
      if ('childNodes' in node) {
        for (const child of node.childNodes) {
          if (collector.full) return;
          visit(child);
        }
      }
    };
    visit(doc);
  } catch {
    // Fall back silently; regex-based extraction is intentionally removed in favor of parse5.
  }
  return [...collector.links];
}

export interface LinkCandidate {
  href?: string;
  text?: string;
}

// hrefs that are never navigable http(s) links. Only the bare-fragment ("#")
// case must be filtered explicitly; javascript:/mailto: are also dropped by the
// http(s) protocol check, but listing them keeps intent clear and matches the
// historical anchor-extraction behavior.
const NON_NAVIGABLE_HREF_PREFIXES = ['#', 'javascript:', 'mailto:'];

// Resolve and validate a link href into an absolute http(s) URL string, or
// undefined if it is blank, non-navigable, malformed, or a non-http(s) scheme.
export function normalizeLinkHref(href: string, baseUrl?: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (NON_NAVIGABLE_HREF_PREFIXES.some((prefix) => lower.startsWith(prefix))) return undefined;
  let resolved: URL;
  try {
    resolved = baseUrl ? new URL(decodeHtmlEntities(trimmed), baseUrl) : new URL(decodeHtmlEntities(trimmed));
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(resolved.protocol)) return undefined;
  return resolved.toString();
}

// Incremental link collector: the single owner of normalize + validate +
// de-duplicate + cap. Both the HTML walker (which needs early-exit on the
// unique count) and the array-based dedupeLinks helper drive it, so every
// backend shares identical URL handling and dedup semantics. `text` is a
// thunk so walkers only pay for anchor-text extraction on accepted links.
export interface LinkCollector {
  readonly full: boolean;
  add(href: string, text: () => string): void;
  readonly links: readonly LinkResult[];
}

export function createLinkCollector(baseUrl?: string, limit = 200): LinkCollector {
  const links: LinkResult[] = [];
  const seen = new Set<string>();
  return {
    get full() {
      return links.length >= limit;
    },
    add(href, text) {
      if (links.length >= limit) return;
      const url = normalizeLinkHref(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);
      links.push({ text: text(), url });
    },
    get links() {
      return links;
    },
  };
}

// Normalize, validate, and de-duplicate a stream of link candidates into at
// most `limit` LinkResult entries. Thin wrapper over createLinkCollector.
export function dedupeLinks(
  candidates: Iterable<LinkCandidate | undefined | null>,
  options: { baseUrl?: string; limit?: number } = {},
): LinkResult[] {
  const collector = createLinkCollector(options.baseUrl, options.limit);
  for (const candidate of candidates) {
    if (!candidate) continue;
    collector.add(candidate.href ?? '', () => candidate.text ?? '');
  }
  return [...collector.links];
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
