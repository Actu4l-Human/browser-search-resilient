import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractPdfText, isPdf } from '../src/util/pdf.js';

test('extracts text from a real PDF fixture', async () => {
  const buffer = await readFile(new URL('./fixtures/hello.pdf', import.meta.url));
  assert.equal(isPdf(buffer, 'application/pdf'), true);
  const text = await extractPdfText(buffer);
  assert.match(text, /Hello resilient PDF/);
});
