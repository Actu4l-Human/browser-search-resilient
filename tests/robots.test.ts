import assert from 'node:assert/strict';
import test from 'node:test';
import { isPathAllowed, pathMatches } from '../src/security/robots.js';

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

test('longest matching robots rule wins', () => {
  const groups = [{ userAgents: ['*'], allow: ['/'], disallow: ['/private'] }];
  assert.equal(isPathAllowed(groups, 'ResilientBrowserSearch', '/private/data'), false);
  assert.equal(isPathAllowed(groups, 'ResilientBrowserSearch', '/public'), true);
});

test('allow wins when matching robots rules have equal specificity', () => {
  const groups = [{ userAgents: ['*'], allow: ['/private'], disallow: ['/private'] }];
  assert.equal(isPathAllowed(groups, 'ResilientBrowserSearch', '/private'), true);
});

test('equally specific user-agent groups are merged', () => {
  const groups = [
    { userAgents: ['resilientbrowsersearch'], allow: ['/public'], disallow: [] },
    { userAgents: ['resilientbrowsersearch'], allow: [], disallow: ['/private'] },
    { userAgents: ['*'], allow: ['/private'], disallow: [] },
  ];
  assert.equal(isPathAllowed(groups, 'ResilientBrowserSearch/0.2', '/private'), false);
  assert.equal(isPathAllowed(groups, 'ResilientBrowserSearch/0.2', '/public'), true);
});
