import { describe, expect, it } from 'vitest';
import { normalizeUsername, SESSION_STATUSES, USER_STATUSES } from './auth.js';

describe('authentication vocabulary', () => {
  it('defines explicit user and session statuses', () => {
    expect(USER_STATUSES).toEqual(['active', 'disabled']);
    expect(SESSION_STATUSES).toEqual(['active', 'revoked']);
  });

  it('normalizes usernames consistently', () => {
    expect(normalizeUsername('  KeITh  ')).toBe('keith');
    expect(normalizeUsername('Ｋｅｉｔｈ')).toBe('keith');
  });
});
