import { describe, expect, it } from 'vitest';
import { csrfTokensEqual } from './csrf.js';

describe('CSRF comparison', () => {
  it('accepts only an exact same-length token', () => {
    expect(csrfTokensEqual('abc123', 'abc123')).toBe(true);
    expect(csrfTokensEqual('abc123', 'abc124')).toBe(false);
    expect(csrfTokensEqual('abc123', 'short')).toBe(false);
    expect(csrfTokensEqual('abc123', undefined)).toBe(false);
  });
});
