import { describe, expect, it } from 'vitest';
import {
  asAuditEventId,
  asEventId,
  asSessionId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  isWellFormedId,
} from './ids.js';

describe('branded id factories', () => {
  it('accept non-empty trimmed strings', () => {
    expect(asWorkspaceId('ws-demo')).toBe('ws-demo');
    expect(asEventId('01J0000')).toBe('01J0000');
    expect(asSessionId('session-1')).toBe('session-1');
    expect(asWorkspaceMembershipId('membership-1')).toBe('membership-1');
    expect(asAuditEventId('audit-1')).toBe('audit-1');
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
