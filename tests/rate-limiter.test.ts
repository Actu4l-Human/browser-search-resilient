import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter } from '../src/util/rate-limiter.js';

test('disabled limiter always allows', () => {
  const limiter = new RateLimiter(0);
  assert.equal(limiter.enabled, false);
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.consume('peer'), true);
});

test('enabled limiter blocks after burst is exhausted', () => {
  const limiter = new RateLimiter(60, 3);
  assert.equal(limiter.enabled, true);
  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('a'), false);
});

test('separate keys have independent buckets', () => {
  const limiter = new RateLimiter(60, 1);
  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('a'), false);
  assert.equal(limiter.consume('b'), true);
});
