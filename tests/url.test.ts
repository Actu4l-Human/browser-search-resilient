import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedAddress, parsePublicUrl } from '../src/security/url.js';

for (const address of [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '::1',
  'fd00::1',
  'fe80::1',
  'ff02::1',
  'fec0::1',
  '2001:db8::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:a00:1',
  '::7f00:1',
  '64:ff9b::7f00:1',
  '100::',
  '64:ff9b:1::1',
  'fc00::1',
  '::',
  'fc00::1.2.3.4',
  'fe80::1.2.3.4',
  'ff02::1.2.3.4',
  '2002:0a00::1',
  '2002:c0a8:0101::1',
]) {
  test(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
}

test('allows public ipv4 and ipv6', () => {
  assert.equal(isBlockedAddress('1.1.1.1'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedAddress('::808:808'), false);
  assert.equal(isBlockedAddress('64:ff9b::808:808'), false);
});

test('rejects localhost URL', () => assert.throws(() => parsePublicUrl('http://localhost/admin'), /Blocked/));
test('rejects URL credentials', () => assert.throws(() => parsePublicUrl('https://user:pass@example.com'), /Credentials/));
test('accepts normal public URL syntax', () => assert.equal(parsePublicUrl('https://example.com/path').hostname, 'example.com'));
test('rejects IPv6 loopback URL', () => assert.throws(() => parsePublicUrl('http://[::1]/admin'), /Blocked/));

test('rejects canonical IPv4-embedded IPv6 URL forms', () => {
  for (const url of ['http://[::ffff:7f00:1]/', 'http://[::ffff:a00:1]/', 'http://[::7f00:1]/', 'http://[64:ff9b::7f00:1]/']) {
    assert.throws(() => parsePublicUrl(url), /Blocked/);
  }
});

test('rejects non-canonical IPv4 loopback URL forms', () => {
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://2130706433/']) {
    assert.throws(() => parsePublicUrl(url), /Blocked/);
  }
});

test('rejects cloud metadata hostnames', () => {
  assert.throws(() => parsePublicUrl('http://metadata.google.internal/computeMetadata/v1'), /Blocked/);
  assert.throws(() => parsePublicUrl('http://instance-data.ec2.internal/latest/meta-data'), /Blocked/);
});
test('rejects internal TLDs', () => {
  assert.throws(() => parsePublicUrl('http://service.local'), /Blocked/);
  assert.throws(() => parsePublicUrl('http://service.internal'), /Blocked/);
});
