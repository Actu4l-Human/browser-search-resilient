import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedAddress, parsePublicUrl } from '../src/security/url.js';

for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) {
  test(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
}

test('allows a public address', () => assert.equal(isBlockedAddress('1.1.1.1'), false));
test('rejects localhost URL', () => assert.throws(() => parsePublicUrl('http://localhost/admin'), /Blocked/));
test('rejects URL credentials', () => assert.throws(() => parsePublicUrl('https://user:pass@example.com'), /Credentials/));
test('accepts normal public URL syntax', () => assert.equal(parsePublicUrl('https://example.com/path').hostname, 'example.com'));
test('rejects IPv6 loopback URL', () => assert.throws(() => parsePublicUrl('http://[::1]/admin'), /Blocked/));
