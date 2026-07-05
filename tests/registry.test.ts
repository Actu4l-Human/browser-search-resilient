import assert from 'node:assert/strict';
import test from 'node:test';
import { inFlight } from '../src/util/registry.js';

test('registry tracks in-flight promises and resolves to their value', async () => {
  let completed = false;
  const p = inFlight.register(
    new Promise<string>((resolve) => {
      setTimeout(() => {
        completed = true;
        resolve('done');
      }, 10);
    }),
  );
  assert.equal(inFlight.size >= 1, true);
  const value = await p;
  assert.equal(value, 'done');
  assert.equal(completed, true);
});

test('drain resolves once registered tasks settle', async () => {
  let resolveFn: (v: string) => void = () => undefined;
  const p = inFlight.register(
    new Promise<string>((resolve) => {
      resolveFn = resolve;
    }),
  );
  const drainPromise = inFlight.drain(1000);
  resolveFn('ok');
  await Promise.all([p, drainPromise]);
  assert.equal(inFlight.size, 0);
});
