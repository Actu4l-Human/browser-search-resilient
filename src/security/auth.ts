import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function checkBearer(header: string | string[] | undefined, expected: string): boolean {
  if (!expected) return true;
  const value = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return safeEqual(value, `Bearer ${expected}`);
}
