import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, shouldEscalate } from '../src/classifier.js';

test('classifies normal readable page as success', () => {
  assert.equal(classify({ status: 200, content: 'A'.repeat(100), contentType: 'text/html' }).outcome, 'success');
});

test('detects Cloudflare challenge', () => {
  const result = classify({ status: 403, title: 'Just a moment...', content: '/cdn-cgi/challenge-platform' });
  assert.equal(result.outcome, 'antibot_challenge');
  assert.equal(result.challenge, 'cloudflare');
});

test('authentication is terminal while JS pages escalate', () => {
  assert.equal(shouldEscalate(classify({ status: 401, content: 'login' }).outcome), false);
  assert.equal(shouldEscalate(classify({ status: 200, content: 'Please enable JavaScript to continue' }).outcome), true);
});
