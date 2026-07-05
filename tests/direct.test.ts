import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinnedLookup } from '../src/backends/direct.js';

const addresses = [
  { address: '93.184.216.34', family: 4 as const },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
];

test('pinned lookup supports Node all-address callback shape', async () => {
  const lookup = createPinnedLookup(addresses);
  const result = await new Promise<unknown[]>((resolve) => {
    lookup('example.com', { all: true }, (...args) => resolve(args));
  });

  assert.equal(result[0], null);
  assert.deepEqual(result[1], addresses);
});

test('pinned lookup supports legacy single-address callback shape', async () => {
  const lookup = createPinnedLookup(addresses);
  const result = await new Promise<unknown[]>((resolve) => {
    lookup('example.com', { family: 4 }, (...args) => resolve(args));
  });

  assert.equal(result[0], null);
  assert.equal(result[1], '93.184.216.34');
  assert.equal(result[2], 4);
});
