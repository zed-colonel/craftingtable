import { describe, expect, it } from 'vitest';
import { computeBundleDigest, type DigestArtifact } from './digest.js';

/** CT03-A21 and CT03-A22: canonical bundle digest determinism and sensitivity. */

const encoder = new TextEncoder();

const base: readonly DigestArtifact[] = [
  {
    role: 'implementation-plan',
    logicalFilename: 'plan.md',
    mediaType: 'text/markdown',
    bytes: encoder.encode('# Plan\n'),
  },
  {
    role: 'work-breakdown',
    logicalFilename: 'breakdown.yaml',
    mediaType: 'application/yaml',
    bytes: encoder.encode('document: X\n'),
  },
  {
    role: 'supporting',
    logicalFilename: 'notes.md',
    mediaType: 'text/markdown',
    bytes: encoder.encode('notes\n'),
  },
];

function permutations<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) {
    return [items];
  }
  const result: T[][] = [];
  for (const [index, item] of items.entries()) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const permutation of permutations(rest)) {
      result.push([item, ...permutation]);
    }
  }
  return result;
}

describe('canonical bundle digest', () => {
  it('is stable and well formed', () => {
    const digest = computeBundleDigest(base);
    expect(digest.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(digest.algorithm).toBe('sha-256');
    expect(digest.formatVersion).toBe(1);
    expect(computeBundleDigest(base).hex).toBe(digest.hex);
  });

  it('does not depend on multipart part order (CT03-A21)', () => {
    const expected = computeBundleDigest(base).hex;
    const digests = permutations(base).map((order) => computeBundleDigest(order).hex);
    expect(digests).toHaveLength(6);
    expect(new Set(digests)).toEqual(new Set([expected]));
  });

  it('changes when an artifact role changes (CT03-A22)', () => {
    const changed = [{ ...(base[2] as DigestArtifact), role: 'decision-log' }, base[0], base[1]];
    expect(computeBundleDigest(changed as DigestArtifact[]).hex).not.toBe(
      computeBundleDigest(base).hex,
    );
  });

  it('changes when a logical filename changes (CT03-A22)', () => {
    const changed = [
      { ...(base[0] as DigestArtifact), logicalFilename: 'plan2.md' },
      base[1],
      base[2],
    ];
    expect(computeBundleDigest(changed as DigestArtifact[]).hex).not.toBe(
      computeBundleDigest(base).hex,
    );
  });

  it('changes when a media type changes (CT03-A22)', () => {
    const changed = [{ ...(base[0] as DigestArtifact), mediaType: 'text/plain' }, base[1], base[2]];
    expect(computeBundleDigest(changed as DigestArtifact[]).hex).not.toBe(
      computeBundleDigest(base).hex,
    );
  });

  it('changes when any single byte changes (CT03-A22)', () => {
    const original = computeBundleDigest(base).hex;
    const source = base[1] as DigestArtifact;
    for (let index = 0; index < source.bytes.byteLength; index += 1) {
      const bytes = Uint8Array.from(source.bytes);
      bytes[index] = ((bytes[index] as number) + 1) % 256;
      const digest = computeBundleDigest([
        base[0] as DigestArtifact,
        { ...source, bytes },
        base[2] as DigestArtifact,
      ]).hex;
      expect(digest).not.toBe(original);
    }
  });

  it('changes when an artifact is added or removed (CT03-A22)', () => {
    expect(computeBundleDigest(base.slice(0, 2)).hex).not.toBe(computeBundleDigest(base).hex);
  });

  it('distinguishes bundles that would collide under naive concatenation', () => {
    // Length prefixing is what makes the encoding injective: without it,
    // ("ab", "c") and ("a", "bc") would hash identically.
    const left = computeBundleDigest([
      {
        role: 'supporting',
        logicalFilename: 'ab.md',
        mediaType: 'text/markdown',
        bytes: encoder.encode('c'),
      },
    ]).hex;
    const right = computeBundleDigest([
      {
        role: 'supporting',
        logicalFilename: 'a.md',
        mediaType: 'text/markdown',
        bytes: encoder.encode('bc'),
      },
    ]).hex;
    expect(left).not.toBe(right);
  });

  it('is unaffected by the order artifacts of one role are supplied in', () => {
    const supporting: readonly DigestArtifact[] = [
      {
        role: 'supporting',
        logicalFilename: 'a.md',
        mediaType: 'text/markdown',
        bytes: encoder.encode('a'),
      },
      {
        role: 'supporting',
        logicalFilename: 'b.md',
        mediaType: 'text/markdown',
        bytes: encoder.encode('b'),
      },
    ];
    expect(computeBundleDigest(supporting).hex).toBe(
      computeBundleDigest([...supporting].reverse()).hex,
    );
  });
});
