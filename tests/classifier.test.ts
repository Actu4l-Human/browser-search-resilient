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

test('browser-rendered content wins over a stale JavaScript placeholder', () => {
  const content = [
    'Enable JavaScript to see products',
    'Chaz Kangeroo Hoodie',
    '$52',
    'Teton Pullover Hoodie',
    '$70',
    'Bruno Compete Hoodie',
    '$63',
    'Frankie Sweatshirt',
    '$60',
    'Hollister Backyard Sweatshirt',
    '$52',
    'Stark Fundamental Hoodie',
    '$42',
  ].join('\n');

  assert.equal(classify({ status: 200, content, rendered: true }).outcome, 'success');
});

test('browser page with only a JavaScript placeholder still escalates', () => {
  assert.equal(classify({ status: 200, content: 'Enable JavaScript to continue', rendered: true }).outcome, 'js_required');
});
