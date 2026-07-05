import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLinks, extractTitle, htmlToText, truncate } from '../src/util/text.js';

test('extractTitle decodes entities and strips tags', () => {
  assert.equal(extractTitle('<html><head><title>Hello &amp; <b>World</b></title></head><body></body></html>'), 'Hello & World');
});

test('htmlToText skips scripts/styles and collapses whitespace', () => {
  const html = '<html><head><style>x{}</style></head><body><p>Line one</p><script>alert(1)</script><p>Line two</p></body></html>';
  const text = htmlToText(html);
  assert.ok(text.includes('Line one'));
  assert.ok(text.includes('Line two'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('x{}'));
});

test('extractLinks resolves relative urls against base and dedupes', () => {
  const html = '<body><a href="/a">A</a><a href="https://other.test/b">B</a><a href="#skip">s</a><a href="/a">dup</a></body>';
  const links = extractLinks(html, 'https://example.test/');
  assert.equal(links.length, 2);
  assert.equal(links[0]!.url, 'https://example.test/a');
  assert.equal(links[1]!.url, 'https://other.test/b');
});

test('truncate appends marker when over limit', () => {
  const out = truncate('abcdef', 3);
  assert.equal(out.truncated, true);
  assert.ok(out.value.startsWith('abc'));
  assert.ok(out.value.includes('[truncated]'));
  assert.equal(truncate('abc', 3).truncated, false);
});

test('htmlToText handles malformed html without throwing', () => {
  const text = htmlToText('<p>unclosed <b>bold');
  assert.ok(text.includes('unclosed'));
  assert.ok(text.includes('bold'));
});
