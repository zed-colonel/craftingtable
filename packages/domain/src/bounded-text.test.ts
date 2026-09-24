import { describe, expect, it } from 'vitest';
import { truncateUtf8Bytes } from './bounded-text.js';

describe('truncateUtf8Bytes', () => {
  it('leaves short text alone and never splits a code point', () => {
    expect(truncateUtf8Bytes('plain', 10)).toBe('plain');
    const arrows = '→'.repeat(10); // 3 bytes each
    const cut = truncateUtf8Bytes(arrows, 10);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(10);
    expect(cut).toBe('→→…');
    expect(cut).not.toContain('�');
  });

  it('keeps a value stored at the character limit within the byte bound', () => {
    const stored = `${'a'.repeat(3990)}…→…→`;
    expect(stored.length).toBeLessThanOrEqual(4000);
    expect(Buffer.byteLength(stored, 'utf8')).toBeGreaterThan(4000);
    expect(Buffer.byteLength(truncateUtf8Bytes(stored, 4000), 'utf8')).toBeLessThanOrEqual(4000);
  });
});
