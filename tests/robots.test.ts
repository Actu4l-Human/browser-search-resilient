import assert from 'node:assert/strict';
import test from 'node:test';
import { pathMatches } from '../src/security/robots.js';

test('Disallow /*? blocks only query-bearing URLs', () => {
  assert.equal(pathMatches('/*?', '/page'), false);
  assert.equal(pathMatches('/*?', '/'), false);
  assert.equal(pathMatches('/*?', '/page?x=1'), true);
  assert.equal(pathMatches('/*?', '/a/b?c=2'), true);
});

test('end-anchor $ is respected', () => {
  assert.equal(pathMatches('/private$', '/private'), true);
  assert.equal(pathMatches('/private$', '/private-data'), false);
  assert.equal(pathMatches('/private$', '/private/secret'), false);
});

test('wildcards and literal dots match as expected', () => {
  assert.equal(pathMatches('/*.pdf$', '/report.pdf'), true);
  assert.equal(pathMatches('/*.pdf$', '/report.pdf.bak'), false);
  assert.equal(pathMatches('/search?q=', '/search?q=test'), true);
});

test('empty pattern never matches', () => {
  assert.equal(pathMatches('', '/anything'), false);
});
