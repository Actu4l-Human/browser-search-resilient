import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlCache } from '../src/util/cache.js';

test('TtlCache stores and returns values within ttl', () => {
  const cache = new TtlCache<string, number>(1000, 8);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
});

test('TtlCache evicts oldest entry when capacity exceeded', () => {
  const cache = new TtlCache<string, number>(10_000, 2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('TtlCache returns undefined for missing keys', () => {
  const cache = new TtlCache<string, number>(1000, 8);
  assert.equal(cache.get('missing'), undefined);
});
