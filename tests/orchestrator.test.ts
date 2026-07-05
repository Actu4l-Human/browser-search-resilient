import assert from 'node:assert/strict';
import test from 'node:test';
import { webFetch } from '../src/orchestrator.js';

test('webFetch terminates immediately when the requested URL is private', async () => {
  const response = await webFetch('http://127.0.0.1:1234', { backend: 'auto' });

  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
  assert.equal(response.attempts.length, 1);
  assert.equal(response.attempts[0]?.backend, 'direct');
});

test('webFetch with explicit private backend is policy_denied', async () => {
  const response = await webFetch('http://10.0.0.5/admin', { backend: 'direct' });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
});

test('webFetch rejects non-http schemes via policy_denied', async () => {
  const response = await webFetch('file:///etc/passwd', { backend: 'direct' });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.outcome, 'policy_denied');
});
