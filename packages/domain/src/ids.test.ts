import { describe, expect, it } from 'vitest';
import { asEventId, asWorkspaceId, isWellFormedId } from './ids.js';

describe('branded id factories', () => {
  it('accept non-empty trimmed strings', () => {
    expect(asWorkspaceId('ws-demo')).toBe('ws-demo');
    expect(asEventId('01J0000')).toBe('01J0000');
  });

  it('reject empty strings', () => {
    expect(() => asWorkspaceId('')).toThrow(/WorkspaceId/);
  });

  it('reject surrounding whitespace', () => {
    expect(() => asEventId(' abc')).toThrow(/EventId/);
    expect(() => asEventId('abc ')).toThrow(/EventId/);
  });
});

describe('isWellFormedId', () => {
  it('accepts plain identifiers', () => {
    expect(isWellFormedId('AQ-01')).toBe(true);
  });

  it('rejects non-strings and blank values', () => {
    expect(isWellFormedId(42)).toBe(false);
    expect(isWellFormedId(null)).toBe(false);
    expect(isWellFormedId('')).toBe(false);
    expect(isWellFormedId('  ')).toBe(false);
  });
});
