import { beforeEach, expect, it, vi } from 'vitest';

/**
 * The live host digest a native approval names (ADR-054) follows the kernel: an approval given on
 * one kernel lapses on the next. The replays pin the digest their goldens were recorded under
 * (R-B4b); the daemon never does, so this must keep holding.
 */
const kernel = vi.hoisted(() => ({ release: '7.2.5-3-omarchy' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  release: () => kernel.release,
}));
const { nativeHostDigest } = await import('../src/native-environment.js');

beforeEach(() => {
  kernel.release = '7.2.5-3-omarchy';
});

it('changes with the kernel release and is stable on one kernel', () => {
  const before = nativeHostDigest();
  expect(nativeHostDigest()).toBe(before);
  kernel.release = '7.2.8-9-omarchy';
  const after = nativeHostDigest();
  expect(after).toMatch(/^[a-f0-9]{64}$/);
  expect(after).not.toBe(before);
  kernel.release = '7.2.5-3-omarchy';
  expect(nativeHostDigest()).toBe(before);
});
