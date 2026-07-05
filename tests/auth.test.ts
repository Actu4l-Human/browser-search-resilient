import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBearer } from '../src/security/auth.js';

test('allows any header when no expected key configured', () => {
  assert.equal(checkBearer(undefined, ''), true);
  assert.equal(checkBearer('Bearer whatever', ''), true);
});

test('rejects missing or wrong token', () => {
  const key = 's3cret-key-1234567890abcdef';
  assert.equal(checkBearer(undefined, key), false);
  assert.equal(checkBearer('Bearer wrong', key), false);
  assert.equal(checkBearer('', key), false);
});

test('accepts correct bearer token', () => {
  const key = 's3cret-key-1234567890abcdef';
  assert.equal(checkBearer(`Bearer ${key}`, key), true);
});

test('handles array header form', () => {
  const key = 's3cret-key-1234567890abcdef';
  assert.equal(checkBearer([`Bearer ${key}`], key), true);
});
