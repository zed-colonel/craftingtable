import { timingSafeEqual } from 'node:crypto';

export function csrfTokensEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}
